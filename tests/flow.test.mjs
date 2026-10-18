import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { main } from '../src/cli.mjs';
import { delegate, waitForTasks, readRun } from '../src/team.mjs';
import { openPane } from '../src/herdr.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
async function untilFile(path) {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('start → isolated Pi launch → research → code → review using real fake-CLI subprocesses', async t => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['project', 'bin', 'state', 'config']) mkdirSync(join(root, dir));
  const fake = readFileSync(new URL('./fixtures/cli.mjs', import.meta.url), 'utf8');
  for (const name of ['herdr', 'pi', 'claude', 'opencode']) writeFileSync(join(root, 'bin', name), fake, { mode: 0o700 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_SOCKET_PATH: join(root, 'socket'),
    HERDR_BIN_PATH: join(root, 'bin/herdr'), HERDR_PLUGIN_ROOT: ROOT, HERDR_PLUGIN_STATE_DIR: join(root, 'state'),
    HERDR_PLUGIN_CONFIG_DIR: join(root, 'config'), HERDR_WORKSPACE_ID: 'w1',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_cwd: join(root, 'project') }), FAKE_ROOT: root };
  const runDir = await main('start', { env, output: { write() {} } });
  const pi = await untilFile(join(root, 'pi-launch.json'));
  assert.equal(pi.cwd, realpathSync(join(root, 'project')));
  assert.ok(pi.args.includes('openai-codex/gpt-6.1-sol'));
  assert.ok(pi.args.includes('--no-mcp'));
  assert.equal(readRun(runDir).workspace, 'w1');
  const coordinator = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8'));
  assert.equal(coordinator.pane.terminal_id, 'coordinator-terminal');
  assert.equal(coordinator.entrypoint, 'coordinator');
  const launch = options => openPane(options, env);
  const research = await delegate(runDir, { role: 'researcher', title: 'Find', brief: 'Find relevant code' }, launch);
  assert.equal((await waitForTasks(runDir, [research.id], 10_000))[0].status, 'completed');
  const worker = JSON.parse(readFileSync(join(runDir, 'tasks', research.id, 'launch.json'), 'utf8'));
  assert.match(worker.pane.terminal_id, /^terminal-/);
  assert.equal(worker.entrypoint, 'worker');
  const coder = await delegate(runDir, { role: 'coder', title: 'Code', brief: 'Make the change' }, launch);
  assert.equal((await waitForTasks(runDir, [coder.id], 10_000))[0].status, 'completed');
  assert.equal(readFileSync(join(root, 'project/change.txt'), 'utf8'), 'fake coder change');
  const review = await delegate(runDir, { role: 'reviewer', title: 'Review', brief: 'Review the change', previousTask: coder.id }, launch);
  assert.equal((await waitForTasks(runDir, [review.id], 10_000))[0].status, 'completed');
  const launches = readFileSync(join(root, 'herdr-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  // start + per worker: pane list, open, pane rename, tab rename
  assert.equal(launches.length, 13);
  assert.ok(launches.some(args => args.join(' ') === `tab rename ${worker.pane.tab_id} researcher · Find`));
  for (const args of launches.filter(args => args[0] === 'plugin')) assert.equal(args[args.indexOf('--workspace') + 1], 'w1');
});
