import { spawn } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createRun, readRun, listTasks, optionalJson, publish, taskDir } from './team.mjs';
import { invocation, openPane, currentPane, requireHerdr, PLUGIN_ID } from './herdr.mjs';
import { checkConfig, piLaunch } from './profiles.mjs';
import { runWorker } from './worker.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function required(env, key) {
  if (!env[key]) throw new Error(`Missing ${key}; launch through the Herdr plugin`);
  return env[key];
}
function runsFor(stateRoot, project) {
  let ids;
  try { ids = readdirSync(join(stateRoot, 'runs')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return ids.map(id => join(stateRoot, 'runs', id)).map(dir => ({ dir, run: readRun(dir) }))
    .filter(({ run }) => run.project === project)
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
}
async function coordinator(runDir, env) {
  const run = readRun(runDir);
  const { command, args } = piLaunch(ROOT, runDir, run.config);
  const child = spawn(command, args, { cwd: run.project, env, stdio: 'inherit' });
  const ignoreInterrupt = () => {}; // Interactive Pi handles Ctrl+C itself.
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', ignoreInterrupt);
  process.on('SIGTERM', terminate);
  try {
    const [code] = await once(child, 'close');
    process.exitCode = code === 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', ignoreInterrupt);
    process.off('SIGTERM', terminate);
  }
}
async function statusPane(env, output) {
  const state = required(env, 'HERDR_PLUGIN_STATE_DIR');
  const project = required(env, 'HERDR_ORCH_PROJECT');
  required(env, 'HERDR_ORCH_WORKSPACE');
  const render = () => {
    if (process.stdout.isTTY) output.write('\x1b[2J\x1b[H');
    output.write(`Feature teams — ${project}\n\n`);
    const runs = runsFor(state, project).slice(0, 10);
    if (!runs.length) output.write('No feature runs yet. Invoke personal.orchestrator.start in this workspace.\n');
    for (const { dir, run } of runs) {
      output.write(`Run ${run.id} (${run.createdAt})\n`);
      const tasks = listTasks(dir);
      if (!tasks.length) output.write('  No assignments yet. Talk to the orchestrator.\n');
      for (const task of tasks) output.write(`  ${task.status.padEnd(17)} ${task.role.padEnd(11)} ${task.title}\n  ${task.id}\n`);
      output.write(`  Records: ${dir}\n\n`);
    }
    output.write('\nr refresh · q close\n');
  };
  render();
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    await new Promise((resolve, reject) => {
      const input = chunk => {
        const key = chunk.toString();
        if (key === 'r') { try { render(); } catch (error) { process.stdin.off('data', input); reject(error); } }
        else if (key === 'q' || key === '\x03' || key === '\x1b') { process.stdin.off('data', input); resolve(); }
      };
      process.stdin.on('data', input);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); }
}
export async function main(mode = process.argv[2], {
  env = process.env, output = process.stdout, cwd = process.cwd(),
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
} = {}) {
  if (mode === 'claude-hook') {
    // Claude Code Stop/StopFailure hook inside a coder worker. Print nothing:
    // hook stdout can alter Claude's behavior. Only the first turn is recorded.
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const event = JSON.parse(input);
    const error = event.error_details || (event.error === undefined ? undefined : JSON.stringify(event.error));
    try {
      publish(join(taskDir(required(env, 'HERDR_ORCH_RUN'), required(env, 'HERDR_ORCH_TASK')), 'stop.json'), {
        event: event.hook_event_name, text: event.last_assistant_message ?? '', error,
        session: event.session_id, transcript: event.transcript_path, at: new Date().toISOString(),
      });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return;
  }
  if (mode === 'inspect') {
    const dir = process.argv[3];
    output.write(`${JSON.stringify({ run: readRun(dir), tasks: listTasks(dir, true) }, null, 2)}\n`);
    return;
  }
  requireHerdr(env);
  if (mode === 'start-here') {
    if (!interactive) throw new Error('start-here requires an interactive terminal; run start.sh directly, not a plugin action');
    const pane = await currentPane(env); // Explicit caller identity, never the focused pane.
    const home = env.HOME || homedir();
    const configDir = env.HERDR_PLUGIN_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'herdr/plugins/config', PLUGIN_ID);
    const stateDir = env.HERDR_PLUGIN_STATE_DIR || join(env.XDG_STATE_HOME || join(home, '.local/state'), 'herdr/plugins', PLUGIN_ID);
    const config = checkConfig(optionalJson(join(configDir, 'config.json')) ?? {});
    const runDir = createRun(stateDir, realpathSync(cwd), pane.workspace_id, config);
    publish(join(runDir, 'coordinator.json'), { pane });
    output.write(`Feature orchestrator in this pane. Records: ${runDir}\n`);
    await coordinator(runDir, { ...env, HERDR_ORCH_RUN: runDir, HERDR_PLUGIN_ROOT: ROOT,
      HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir, PWD: realpathSync(cwd) });
    return runDir;
  }
  if (mode === 'start') {
    const { project, workspace } = invocation(env);
    const config = checkConfig(optionalJson(join(required(env, 'HERDR_PLUGIN_CONFIG_DIR'), 'config.json')) ?? {});
    const runDir = createRun(required(env, 'HERDR_PLUGIN_STATE_DIR'), project, workspace, config);
    try {
      const receipt = await openPane({ workspace, project, entrypoint: 'coordinator', focus: true, env: { HERDR_ORCH_RUN: runDir } }, env);
      if (!receipt.pane?.terminal_id) throw new Error('Missing stable coordinator terminal identity');
      publish(join(runDir, 'coordinator.json'), receipt);
    } catch (error) {
      throw new Error(`Orchestrator launch uncertain. Inspect ${runDir} and Herdr panes before starting another run: ${error.message}`);
    }
    output.write(`Feature orchestrator started. Records: ${runDir}\n`);
    return runDir;
  }
  if (mode === 'status') {
    const { project, workspace } = invocation(env);
    return openPane({ workspace, project, entrypoint: 'status', placement: 'overlay', focus: true,
      env: { HERDR_ORCH_PROJECT: project, HERDR_ORCH_WORKSPACE: workspace } }, env);
  }
  if (mode === 'coordinator') return coordinator(required(env, 'HERDR_ORCH_RUN'), env);
  if (mode === 'worker') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const ignore = () => {}; // Ctrl+C belongs to the agent TUI in this pane.
    process.on('SIGINT', ignore); process.on('SIGTERM', abort); process.on('SIGHUP', abort);
    output.on?.('error', ignore); // The pane may already be gone after closing.
    try { return await runWorker(required(env, 'HERDR_ORCH_RUN'), required(env, 'HERDR_ORCH_TASK'), { signal: controller.signal, output }); }
    finally { process.off('SIGINT', ignore); process.off('SIGTERM', abort); process.off('SIGHUP', abort); }
  }
  if (mode === 'status-pane') return statusPane(env, output);
  throw new Error('Usage: node src/cli.mjs start-here|start|status|coordinator|worker|status-pane|claude-hook|inspect RUN_DIR');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
