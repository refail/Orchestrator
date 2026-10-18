import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invocation, openPane, currentPane, closeWorkerPane } from '../src/herdr.mjs';

test('live calls refuse to control Herdr outside a managed pane', async () => {
  assert.throws(() => invocation({}), /Herdr-managed/);
  await assert.rejects(openPane({ entrypoint: 'worker' }, {}), /Herdr-managed/);
});

test('current-pane lookup rejects missing or mismatched caller identities', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-self-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, 'herdr');
  writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(process.env.TEST_RESPONSE);\n', { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test/socket', HERDR_BIN_PATH: fake,
    HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1' };
  await assert.rejects(currentPane({ ...env, HERDR_PANE_ID: '' }), /Missing HERDR_PANE_ID/);
  const pane = { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'stable-terminal' };
  for (const overrides of [{ pane_id: 'w1:p2' }, { workspace_id: 'w2' }, { tab_id: 'w1:t2' }, { terminal_id: '' }]) {
    await assert.rejects(currentPane({ ...env, TEST_RESPONSE: JSON.stringify({ result: { pane: { ...pane, ...overrides } } }) }), /identity changed/);
  }
});

test('a reused pane ID cannot anchor a foreground coordinator in another terminal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, 'herdr');
  writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(process.env.TEST_RESPONSE);\n', { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test/socket', HERDR_BIN_PATH: fake,
    // Pin identity vars so the real Herdr pane running the suite can't leak in.
    HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', TEST_RESPONSE: JSON.stringify({ result: {
      pane: { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'wrong-terminal' },
      process_info: { pane_id: 'w1:p1', foreground_processes: [{ pid: 2147483647 }] },
    } }) };
  await assert.rejects(currentPane(env), /does not own this process/);
});

test('project comes from explicit plugin context, never ambient cwd', t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test/socket', HERDR_WORKSPACE_ID: 'w1', HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_cwd: root }) };
  assert.deepEqual(invocation(env), { project: realpathSync(root), workspace: 'w1' });
  assert.throws(() => invocation({ ...env, HERDR_PLUGIN_CONTEXT_JSON: '{}' }), /context/i);
  assert.throws(() => invocation({ ...env, HERDR_WORKSPACE_ID: 'w2' }), /mismatch/i);
});

test('pane launch follows stable terminal identity after workspace numbering changes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, 'herdr');
  const capture = join(root, 'capture.json');
  writeFileSync(fake, `#!/usr/bin/env node\nconst args=process.argv.slice(2);\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(args));\nconsole.log(JSON.stringify({result:args[0]==='pane'?{panes:[{terminal_id:'owner-terminal',workspace_id:'w3'}]}:{type:'plugin_pane_opened',plugin_pane:{plugin_id:'personal.orchestrator',entrypoint:'worker',pane:{pane_id:'w3:p2',terminal_id:'worker-terminal'}}}}));\n`, { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test/socket', HERDR_BIN_PATH: fake, CAPTURE: capture };
  const receipt = await openPane({ workspace: 'w1', anchor: 'owner-terminal', project: '/project with spaces', entrypoint: 'worker', focus: false, env: { HERDR_ORCH_TASK: 'safe-id' } }, env);
  assert.deepEqual(receipt.pane, { pane_id: 'w3:p2', terminal_id: 'worker-terminal' });
  const args = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(args.slice(0, 3), ['plugin', 'pane', 'open']);
  assert.equal(args[args.indexOf('--plugin') + 1], 'personal.orchestrator');
  assert.equal(args[args.indexOf('--workspace') + 1], 'w3');
  assert.equal(args[args.indexOf('--cwd') + 1], '/project with spaces');
  assert.ok(args.includes('--no-focus'));
  assert.ok(!args.includes('--kind'));
});

test('plugin pane receipts unwrap the Herdr 0.7.1 envelope and reject missing terminal identities', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, 'herdr');
  writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(process.env.TEST_RESPONSE);\n', { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test/socket', HERDR_BIN_PATH: fake };
  const launch = (entrypoint, result) => openPane({ workspace: 'w1', project: root, entrypoint, focus: true },
    { ...env, TEST_RESPONSE: JSON.stringify({ result }) });
  for (const entrypoint of ['coordinator', 'status']) {
    const receipt = { plugin_id: 'personal.orchestrator', entrypoint, pane: { pane_id: 'w1:p2', terminal_id: 'stable-terminal' } };
    assert.deepEqual(await launch(entrypoint, { type: 'plugin_pane_opened', plugin_pane: receipt }), receipt);
  }
  for (const result of [
    { pane: { terminal_id: 'wrong-envelope' } },
    { plugin_pane: {} },
    { plugin_pane: { pane: { pane_id: 'w1:p2' } } },
    { plugin_pane: { pane: { terminal_id: '' } } },
    { plugin_pane: { pane: { terminal_id: 42 } } },
  ]) {
    await assert.rejects(launch('coordinator', result), /Missing stable plugin pane terminal identity/);
  }
});

test('worker panes and their tabs are renamed after launch; a failed rename keeps the launch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-rename-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, 'herdr');
  const calls = join(root, 'calls.jsonl');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[1] === 'rename' && process.env.FAIL_RENAME) { console.log(JSON.stringify({ error: { message: 'no such pane' } })); process.exit(0); }
console.log(JSON.stringify({ result: args[0] === 'plugin'
  ? { plugin_pane: { pane: { pane_id: 'w1:p2', tab_id: 'w1:t2', terminal_id: 'worker-terminal' } } }
  : args[1] === 'list' ? { panes: [{ terminal_id: 'owner', workspace_id: 'w1' }] } : { type: 'ok' } }));
`, { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test/socket', HERDR_BIN_PATH: fake, CALLS: calls };
  const options = { workspace: 'w1', anchor: 'owner', project: root, entrypoint: 'worker', focus: false, label: 'coder · Fix login' };
  const receipt = await openPane(options, env);
  assert.equal(receipt.pane.label, 'coder · Fix login');
  const made = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(made.slice(-2), [['pane', 'rename', 'w1:p2', 'coder · Fix login'], ['tab', 'rename', 'w1:t2', 'coder · Fix login']]);
  const kept = await openPane(options, { ...env, FAIL_RENAME: '1' });
  assert.equal(kept.pane.terminal_id, 'worker-terminal');
  assert.match(kept.rename_error, /no such pane/);
});

test('closing a worker resolves its stable terminal and never closes a reused or ambiguous pane ID', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, 'herdr');
  const calls = join(root, 'calls.jsonl');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({ result: args[1] === 'list' ? { panes: JSON.parse(process.env.PANES) } : { type: 'plugin_pane_closed' } }));
`, { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test/socket', HERDR_BIN_PATH: fake, CALLS: calls };
  const panes = list => ({ ...env, PANES: JSON.stringify(list) });
  // Its old ID w1:p2 now belongs to another terminal after renumbering.
  assert.equal(await closeWorkerPane('worker', panes([{ pane_id: 'w1:p2', terminal_id: 'other' }, { pane_id: 'w2:p2', terminal_id: 'worker' }])), true);
  assert.equal(await closeWorkerPane('worker', panes([{ pane_id: 'w1:p2', terminal_id: 'other' }])), false);
  await assert.rejects(closeWorkerPane('worker', panes([{ pane_id: 'a', terminal_id: 'worker' }, { pane_id: 'b', terminal_id: 'worker' }])), /ambiguous/);
  await assert.rejects(closeWorkerPane(undefined, panes([])), /terminal identity/);
  const closes = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(args => args[0] === 'plugin');
  assert.deepEqual(closes, [['plugin', 'pane', 'close', 'w2:p2']]);
});
