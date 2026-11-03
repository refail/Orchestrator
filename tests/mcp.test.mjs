import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serveMcp } from '../src/mcp.mjs';
import { teamTools, TOOLS } from '../src/tools.mjs';
import { createRun } from '../src/team.mjs';
import { DEFAULTS } from './fixtures/agents.mjs';

// A JSON-RPC client over in-memory streams.
function connect(tools) {
  const input = new PassThrough(), output = new PassThrough(), messages = [], logs = [];
  let buffer = '', waiters = [];
  output.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
      waiters = waiters.filter(waiter => !waiter());
    }
  });
  const done = serveMcp(tools, { input, output, log: line => logs.push(line) });
  const send = message => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const response = id => new Promise(resolve => {
    const check = () => { const found = messages.find(message => message.id === id); if (found) resolve(found); return Boolean(found); };
    if (!check()) waiters.push(check);
  });
  const request = (id, method, params) => { send({ id, method, params }); return response(id); };
  return { input, send, request, messages, logs, done };
}
const tool = (name, execute) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, label: 'hidden', execute });

test('MCP handshake negotiates a known protocol version and lists tools without internal fields', async () => {
  const client = connect([tool('one', async () => 'ok')]);
  const init = await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  const newer = await client.request(2, 'initialize', { protocolVersion: '2099-01-01' });
  assert.equal(newer.result.protocolVersion, '2025-11-25', 'an unknown version gets our latest');
  client.send({ method: 'notifications/initialized' });
  assert.deepEqual((await client.request(3, 'ping')).result, {});
  const { result } = await client.request(4, 'tools/list', {});
  assert.deepEqual(result.tools, [{ name: 'one', description: 'one tool', inputSchema: { type: 'object', properties: {} } }]);
  const unknown = await client.request(5, 'resources/list', {});
  assert.equal(unknown.error.code, -32601);
  assert.match(client.logs.join('\n'), /resources\/list/);
  client.input.end();
  await client.done;
  assert.equal(client.messages.filter(message => message.id === undefined).length, 0, 'notifications get no response');
});

test('MCP tool calls return text, JSON or readable errors', async () => {
  const client = connect([
    tool('text', async () => 'skill text'),
    tool('json', async args => ({ echo: args })),
    tool('broken', async () => { throw new Error('Checkout is busy'); }),
  ]);
  assert.deepEqual((await client.request(1, 'tools/call', { name: 'text', arguments: {} })).result, { content: [{ type: 'text', text: 'skill text' }] });
  const json = await client.request(2, 'tools/call', { name: 'json', arguments: { a: 1 } });
  assert.deepEqual(JSON.parse(json.result.content[0].text), { echo: { a: 1 } });
  const broken = await client.request(3, 'tools/call', { name: 'broken' });
  assert.equal(broken.result.isError, true);
  assert.equal(broken.result.content[0].text, 'Checkout is busy');
  assert.equal((await client.request(4, 'tools/call', { name: 'missing' })).error.code, -32602);
  client.input.write('not json\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.messages.at(-1).error.code, -32700);
  client.input.end();
  await client.done;
});

test('MCP runs sequential tools one at a time, like Pi, so parallel delegations do not race', async () => {
  let active = 0, most = 0;
  const slow = (sequential, name) => ({ ...tool(name, async () => {
    active++; most = Math.max(most, active);
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    if (name === 'fails') throw new Error('Checkout is busy');
    return 'ok';
  }), sequential });
  const client = connect([slow(true, 'delegate'), slow(true, 'fails'), slow(false, 'status')]);
  const replies = await Promise.all([
    client.request(1, 'tools/call', { name: 'delegate' }),
    client.request(2, 'tools/call', { name: 'fails' }),
    client.request(3, 'tools/call', { name: 'delegate' }),
  ]);
  assert.equal(most, 1, 'never two sequential calls at once');
  assert.deepEqual(replies.map(reply => Boolean(reply.result.isError)), [false, true, false], 'a failure does not block the queue');
  most = 0;
  await Promise.all([client.request(4, 'tools/call', { name: 'status' }), client.request(5, 'tools/call', { name: 'status' })]);
  assert.equal(most, 2, 'other tools still run in parallel');
  client.input.end();
  await client.done;
});

test('MCP cancellation aborts a waiting call and sends no response; closing stdin aborts the rest', async () => {
  const aborted = [];
  const wait = tool('wait', (args, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted.push(args.n); reject(new Error('aborted')); });
  }));
  const client = connect([wait]);
  client.send({ id: 'a', method: 'tools/call', params: { name: 'wait', arguments: { n: 1 } } });
  client.send({ id: 'b', method: 'tools/call', params: { name: 'wait', arguments: { n: 2 } } });
  client.send({ method: 'notifications/cancelled', params: { requestId: 'a', reason: 'Esc' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(aborted, [1]);
  client.input.end();
  await client.done;
  assert.deepEqual(aborted, [1, 2]);
  assert.equal(client.messages.length, 0, 'cancelled calls are never answered');
});

test('team tools expose the run roles and report invalid delegations as tool errors', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project'));
  const run = createRun(join(root, 'state'), join(root, 'project'), 'w1', DEFAULTS);
  const tools = teamTools(run, { open: async () => { throw new Error('must not open a pane'); } });
  assert.deepEqual(tools.map(item => item.name), TOOLS);
  assert.deepEqual(tools[0].inputSchema.properties.role.enum, Object.keys(DEFAULTS.agents));
  const client = connect(tools);
  const status = await client.request(1, 'tools/call', { name: 'team_status', arguments: {} });
  assert.deepEqual(JSON.parse(status.result.content[0].text).tasks, []);
  const bad = await client.request(2, 'tools/call', { name: 'team_delegate', arguments: { role: 'nobody', title: 't', brief: 'b' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /Invalid role/);
  client.input.end();
  await client.done;
});

test('`cli.mjs mcp` serves the run named by HERDR_ORCH_RUN over stdio', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-mcp-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project'));
  const run = createRun(join(root, 'state'), join(root, 'project'), 'w1', DEFAULTS);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'mcp'], { env: { ...process.env, HERDR_ORCH_RUN: run }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const [code] = await new Promise(resolve => child.on('close', (...args) => resolve(args)));
  assert.equal(code, 0, stderr);
  const [init, list] = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(init.result.serverInfo.name, 'herdr-team');
  assert.deepEqual(list.result.tools.map(item => item.name), TOOLS);
  // OpenCode prefixes the server name ("team"), so it gets bare names.
  const named = spawn(process.execPath, [cli, 'mcp', 'opencode'], { env: { ...process.env, HERDR_ORCH_RUN: run }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  named.stdout.on('data', chunk => { out += chunk; });
  named.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  await new Promise(resolve => named.on('close', resolve));
  assert.deepEqual(JSON.parse(out).result.tools.map(item => `team_${item.name}`), TOOLS);
});
