import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import { readRun, delegate, waitForTasks } from '../src/team.mjs';
import { openPane } from '../src/herdr.mjs';
import { snapshotAgents } from '../src/agents.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
test('foreground start refuses outside Herdr or without an interactive terminal', async () => {
  await assert.rejects(main('start-here', { env: {}, interactive: true }), /Herdr-managed/);
  await assert.rejects(main('start-here', { env: { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/no/socket' }, interactive: false }), /interactive terminal/);
});

test('foreground start uses this pane and cwd, saves its anchor, and delegates without opening a coordinator tab', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-current-pane-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['project', 'bin', 'xdg-config', 'xdg-state']) mkdirSync(join(root, dir));
  const fake = readFileSync(new URL('./fixtures/cli.mjs', import.meta.url), 'utf8');
  for (const name of ['herdr', 'pi', 'opencode']) writeFileSync(join(root, 'bin', name), fake, { mode: 0o700 });
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_SOCKET_PATH: join(root, 'socket'),
    HERDR_BIN_PATH: join(root, 'bin/herdr'), HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1',
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_STATE_HOME: join(root, 'xdg-state'),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w9', workspace_cwd: '/unrelated' }), FAKE_ROOT: root };
  delete env.HERDR_PLUGIN_CONFIG_DIR;
  delete env.HERDR_PLUGIN_STATE_DIR;
  const runDir = await main('start-here', { env, cwd: join(root, 'project'), interactive: true, output: { write() {} } });
  const run = readRun(runDir);
  assert.equal(run.project, join(root, 'project'));
  assert.equal(run.workspace, 'w1');
  assert.deepEqual(run.config, snapshotAgents(), 'the run snapshots agents.json and its prompts');
  assert.ok(runDir.startsWith(join(root, 'xdg-state')));
  const receipt = JSON.parse(readFileSync(join(runDir, 'coordinator.json'), 'utf8'));
  assert.equal(receipt.pane.terminal_id, 'coordinator-terminal');
  const pi = JSON.parse(readFileSync(join(root, 'pi-launch.json'), 'utf8'));
  assert.equal(pi.cwd, run.project);
  assert.equal(pi.run, runDir);
  const calls = () => readFileSync(join(root, 'herdr-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls(), [['pane', 'get', 'w1:p1'], ['pane', 'process-info', '--pane', 'w1:p1']]);
  assert.ok(!existsSync(join(runDir, 'tasks', 'unexpected')));
  const task = await delegate(runDir, { role: 'researcher', title: 'Inspect', brief: 'Read only' },
    options => openPane(options, { ...env, HERDR_PLUGIN_ROOT: ROOT }));
  assert.equal((await waitForTasks(runDir, [task.id], 10_000))[0].status, 'completed');
  assert.equal(calls().filter(args => args[0] === 'plugin').length, 1);
  assert.ok(!calls().some(args => args.includes('coordinator')));
});
