import { spawn } from 'node:child_process';
import { readdirSync, realpathSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createRun, readRun, listTasks, publish, taskDir, recoverTask, pruneRuns, closeCompletedPanes } from './team.mjs';
import { invocation, openPane, currentPane, requireHerdr, closeWorkerPane, PLUGIN_ID } from './herdr.mjs';
import { leadLaunch } from './profiles.mjs';
import { snapshotAgents } from './agents.mjs';
import { runWorker } from './worker.mjs';
import { serveDashboard } from './dashboard.mjs';
import { serveMcp } from './mcp.mjs';
import { teamTools } from './tools.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function required(env, key) {
  if (!env[key]) throw new Error(`Missing ${key}; launch through the Herdr plugin`);
  return env[key];
}
function stateDirFor(env) {
  return env.HERDR_PLUGIN_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'herdr/plugins', PLUGIN_ID);
}
function runsFor(stateRoot, project) {
  let ids;
  try { ids = readdirSync(join(stateRoot, 'runs')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // One damaged run must not hide the others.
  return ids.map(id => join(stateRoot, 'runs', id)).flatMap(dir => { try { return [{ dir, run: readRun(dir) }]; } catch { return []; } })
    .filter(({ run }) => run.project === project)
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
}
// OpenCode lead: a private `serve --stdio` in its own process group (Ctrl+C
// belongs to the TUI), then a session with the lead's agent and model for the
// TUI to attach to. Returns the server URL.
export async function opencodeLeadSession(lead, run, env, helpers) {
  mkdirSync(lead.configDir, { recursive: true, mode: 0o700 });
  const server = spawn(lead.command, lead.serve, { cwd: run.project, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helpers.push(server);
  let stderr = '', buffer = '';
  server.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode server did not report its URL within 20s: ${stderr}`)), 20_000);
    server.stdout.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, end)).url); } catch (error) { reject(error); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('close', code => { clearTimeout(timer); reject(new Error(`OpenCode server exited (${code}): ${stderr}`)); });
  });
  const response = await fetch(`${url}/api/session`, {
    method: 'POST', signal: AbortSignal.timeout(20_000), body: JSON.stringify({ ...lead.session, location: { directory: run.project } }),
    headers: { authorization: `Basic ${Buffer.from(`opencode:${lead.password}`).toString('base64')}`, 'content-type': 'application/json' },
  });
  if (!response.ok) throw new Error(`OpenCode could not create the lead session (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return url;
}
async function coordinator(runDir, env) {
  const run = readRun(runDir);
  const lead = leadLaunch(ROOT, runDir, run.config, { ...env, HERDR_ORCH_RUN: runDir });
  const leadEnv = { ...env, ...lead.env }, helpers = [];
  let child, stopping = false;
  const ignoreInterrupt = () => {}; // The interactive lead handles Ctrl+C itself.
  const terminate = () => { stopping = true; child?.kill('SIGTERM'); };
  process.on('SIGINT', ignoreInterrupt);
  process.on('SIGTERM', terminate);
  try {
    const args = lead.serve ? lead.tui(await opencodeLeadSession(lead, run, leadEnv, helpers)) : lead.args;
    if (stopping) { process.exitCode = 1; return; } // Terminated while the OpenCode lead was starting.
    child = spawn(lead.command, args, { cwd: run.project, env: leadEnv, stdio: 'inherit' });
    const [code] = await once(child, 'close');
    process.exitCode = code === 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', ignoreInterrupt);
    process.off('SIGTERM', terminate);
    for (const helper of helpers) {
      helper.stdin.end(); // `serve --stdio` stops when its stdin closes.
      try { process.kill(-helper.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  // The lead may exit before collecting finished work; close completed worker
  // panes so their TUIs stop. Others stay open for inspection.
  try { await closeCompletedPanes(runDir, terminal => closeWorkerPane(terminal, env)); } catch { /* best effort */ }
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
      output.write(`Run ${run.id} (${run.createdAt})${run.legacy ? ' · older plugin version, read-only' : ''}\n`);
      let tasks;
      try { tasks = listTasks(dir); } catch (error) { output.write(`  Cannot read its tasks: ${error.message}\n  Records: ${dir}\n\n`); continue; }
      if (!tasks.length) output.write('  No assignments yet. Talk to the orchestrator.\n');
      for (const task of tasks) {
        const age = task.finished ? '' : ` · ${Math.floor((Date.now() - Date.parse(task.createdAt)) / 60_000)} min`;
        output.write(`  ${task.status.padEnd(17)} ${task.role.padEnd(11)} ${task.title}${age}\n  ${task.id}${task.detail ? `\n  ${task.detail}` : ''}\n`);
      }
      output.write(`  Records: ${dir}\n\n`);
    }
    output.write('\nRefreshes every 2 s · r refresh · q close\n');
  };
  render();
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    await new Promise((resolve, reject) => {
      const end = error => { clearInterval(timer); process.stdin.off('data', input); error ? reject(error) : resolve(); };
      const refresh = () => { try { render(); } catch (error) { end(error); } };
      const timer = setInterval(refresh, 2000);
      const input = chunk => {
        const key = chunk.toString();
        if (key === 'r') refresh();
        else if (key === 'q' || key === '\x03' || key === '\x1b') end();
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
  if (mode === 'mcp') {
    // Team tools for a Claude Code or OpenCode lead, over stdio. The lead starts
    // it with this run's HERDR_ORCH_RUN and the coordinator pane's Herdr env.
    const tools = teamTools(required(env, 'HERDR_ORCH_RUN'));
    // OpenCode prefixes MCP tool names with the server name ("team").
    return serveMcp(process.argv[3] === 'opencode' ? tools.map(tool => ({ ...tool, name: tool.name.replace(/^team_/, '') })) : tools);
  }
  if (mode === 'inspect') {
    const dir = process.argv[3];
    output.write(`${JSON.stringify({ run: readRun(dir), tasks: listTasks(dir, true) }, null, 2)}\n`);
    return;
  }
  if (mode === 'recover') {
    const [dir, id, flag] = process.argv.slice(3);
    if (!dir || !id || (flag && flag !== '--confirm')) throw new Error('Usage: node src/cli.mjs recover RUN_DIR TASK_ID [--confirm]');
    const task = recoverTask(resolve(dir), id, { confirmed: flag === '--confirm' });
    output.write(`Recorded ${task.status} for ${task.role} task ${task.id}; its checkout lease (if any) is released.\n`);
    return;
  }
  if (mode === 'prune') {
    // Safe for cron: runs outside Herdr and never touches leased or live runs.
    const args = process.argv.slice(3);
    const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 7;
    const dryRun = args.includes('--dry-run');
    if (!(days > 0) || args.some((arg, i) => !['--days', '--dry-run'].includes(arg) && args[i - 1] !== '--days')) {
      throw new Error('Usage: node src/cli.mjs prune [--days N] [--dry-run]');
    }
    const { removed, kept } = pruneRuns(stateDirFor(env), { maxAgeMs: days * 86_400_000, dryRun });
    const stamp = new Date().toISOString();
    for (const run of removed) output.write(`${stamp} ${dryRun ? 'would remove' : 'removed'} ${run.dir} (last activity ${run.lastActivity})\n`);
    output.write(`${stamp} ${removed.length} run(s) ${dryRun ? 'would be ' : ''}removed, ${kept.length} kept (idle limit ${days} days)\n`);
    return;
  }
  if (mode === 'dashboard') {
    // A Herdr action has no terminal: detach so the server outlives the action.
    if (!interactive) {
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'dashboard-serve'], { env, detached: true, stdio: 'ignore' }).unref();
      return;
    }
    const dashboard = await serveDashboard({ log: line => output.write(`${line}\n`) });
    process.once('SIGINT', dashboard.stop);
    return dashboard.done;
  }
  if (mode === 'dashboard-serve') return (await serveDashboard({ log: () => {} })).done;
  requireHerdr(env);
  if (mode === 'start-here') {
    if (!interactive) throw new Error('start-here requires an interactive terminal; run start.sh directly, not a plugin action');
    const pane = await currentPane(env); // Explicit caller identity, never the focused pane.
    const stateDir = stateDirFor(env);
    const runDir = createRun(stateDir, realpathSync(cwd), pane.workspace_id, snapshotAgents(ROOT));
    publish(join(runDir, 'coordinator.json'), { pane });
    output.write(`Feature orchestrator in this pane. Records: ${runDir}\n`);
    await coordinator(runDir, { ...env, HERDR_ORCH_RUN: runDir, HERDR_PLUGIN_ROOT: ROOT,
      HERDR_PLUGIN_STATE_DIR: stateDir, PWD: realpathSync(cwd) });
    return runDir;
  }
  if (mode === 'start') {
    const { project, workspace } = invocation(env);
    const runDir = createRun(required(env, 'HERDR_PLUGIN_STATE_DIR'), project, workspace, snapshotAgents(ROOT));
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
  throw new Error('Usage: node src/cli.mjs start-here|start|status|dashboard|coordinator|worker|status-pane|claude-hook|inspect RUN_DIR|recover RUN_DIR TASK_ID [--confirm]|prune [--days N] [--dry-run]');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
