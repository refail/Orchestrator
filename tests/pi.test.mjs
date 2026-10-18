import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRun } from '../src/team.mjs';
import { piLaunch, TOOLS } from '../src/profiles.mjs';
import { DEFAULTS } from './fixtures/agents.mjs';

const hasPi = spawnSync('pi', ['--version'], { encoding: 'utf8' }).status === 0;
test('real Pi loads only our extension, keeps its tool allowlist across sessions, and blocks shell execution (no model calls)', { skip: !hasPi, timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-pi-rpc-'));
  mkdirSync(join(root, 'project'));
  const run = createRun(join(root, 'state'), join(root, 'project'), 'w1', DEFAULTS);
  const plugin = fileURLToPath(new URL('../', import.meta.url));
  const launch = piLaunch(plugin, run, DEFAULTS);
  const child = spawn(launch.command, [...launch.args, '--mode', 'rpc', '--offline', '--no-session'], {
    cwd: join(root, 'project'), env: { ...process.env, HERDR_ORCH_RUN: run }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', stderr = '', sequence = 0;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === 'response' && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer);
        if (message.success) resolve(message); else reject(new Error(message.error));
      }
    }
  });
  t.after(async () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('RPC test closed')); }
    child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('close', () => { clearTimeout(kill); resolve(); });
    });
    rmSync(root, { recursive: true, force: true });
  });
  const request = value => new Promise((resolve, reject) => {
    const id = `test-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Pi RPC timed out: ${stderr}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...value, id })}\n`);
  });
  const commands = await request({ type: 'get_commands' });
  assert.ok(commands.data.commands.some(command => command.name === 'team'), stderr);
  const state = await request({ type: 'get_state' });
  assert.equal(state.data.model.id, 'gpt-6.1-sol');
  assert.equal(state.data.model.provider, 'openai-codex');
  assert.equal(state.data.thinkingLevel, 'high');
  for (let iteration = 0; iteration < 2; iteration++) {
    if (iteration) await request({ type: 'new_session' });
    const response = await request({ type: 'prompt', message: '/team' });
    assert.equal(response.data.disposition, 'handled');
    const messages = await request({ type: 'get_messages' });
    const status = messages.data.messages.findLast(message => message.customType === 'orchestrator-status');
    assert.ok(status, JSON.stringify(messages));
    const content = typeof status.content === 'string' ? status.content : status.content.map(part => part.text ?? '').join('');
    assert.deepEqual(JSON.parse(content).tools.sort(), [...TOOLS].sort());
  }
  const marker = join(root, 'must-not-exist');
  const bash = await request({ type: 'bash', command: `touch '${marker}'` });
  assert.equal(bash.data.exitCode, 1);
  assert.equal(existsSync(marker), false);
  assert.match(bash.data.output, /disabled/);
  assert.doesNotMatch(stderr, /Failed to load extension|Extension error|Cannot find module/);
});
