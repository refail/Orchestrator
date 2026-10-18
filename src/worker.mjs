import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, writeSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { readRun, readTask, taskDir, optionalJson, publish, finishTask } from './team.mjs';
import { workerLaunch, CLAUDE_ROLES } from './profiles.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// OpenCode `run --format json` events from the headless client.
export function collectOutcome(events, code) {
  let text = '', terminal = false, started = false, finalText = false, failure = '';
  for (const event of events) {
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      text = `${text}${text ? '\n' : ''}${event.part.text}`.slice(0, 32_000);
      finalText ||= Boolean(event.part.text.trim());
    }
    if (event.type === 'step_start') { started = true; terminal = false; finalText = false; }
    if (event.type === 'step_finish') { finalText = false; terminal = event.part?.reason === 'stop'; }
    if (event.type === 'error') failure = event.error?.data?.message ?? event.error?.message ?? 'OpenCode provider error';
  }
  // V2 may emit step_start + text, then exit zero without step_finish.
  // Its CLI reports failed/interrupted executions through errors/nonzero exits.
  if (code !== 0 || failure || !(terminal || (started && finalText)) || !text.trim()) {
    return { status: 'failed', text: `${failure || `Worker exited ${code}; a successful final result was required.`}\n${text}`.slice(0, 32_000) };
  }
  return { status: /^BLOCKED:/i.test(text.trim()) ? 'blocked' : 'completed', text: text.slice(0, 32_000) };
}
// Claude Stop/StopFailure hook record written by `cli.mjs claude-hook`.
export function hookOutcome(stop) {
  const text = typeof stop?.text === 'string' ? stop.text.slice(0, 32_000) : '';
  if (stop?.event === 'StopFailure') return { status: 'failed', text: `${stop.error || 'Claude stopped with an API error'}\n${text}`.slice(0, 32_000) };
  if (stop?.event !== 'Stop' || !text.trim()) return { status: 'failed', text: 'Claude ended its turn without a final report' };
  return { status: /^BLOCKED:/i.test(text.trim()) ? 'blocked' : 'completed', text };
}

function reviewSnapshot(project) {
  const git = args => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd: project, encoding: 'utf8', timeout: 5000, maxBuffer: 512_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
    return `\nGit status:\n${status.slice(0, 8000)}\nTracked diff against HEAD (at most 60000 characters):\n${diff.slice(0, 60_000)}\nRead relevant files too; untracked file content is not in this diff.`;
  } catch { return '\nGit snapshot unavailable (not a repository, no HEAD, or diff too large). Read the relevant project files; disclose this limitation.'; }
}
function optionalText(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function runWorker(runDir, id, { launch, output = process.stdout, signal, pollMs = 250 } = {}) {
  const run = readRun(runDir);
  const task = readTask(runDir, id);
  const dir = taskDir(runDir, id);
  if (optionalJson(join(dir, 'result.json'))) throw new Error('Task already finished');
  publish(join(dir, 'started.json'), { pid: process.pid, startedAt: new Date().toISOString() });
  const fds = [], procs = [];
  let stopReason, killTimer, timer, poll, errorNote = '', stderr = '', bytes = 0, recorded = false;
  // Background helpers get their own process group; the TUI must stay in the
  // pane's foreground group so it can own the terminal.
  function signalAll(sig, which = procs) {
    for (const { child, group } of which) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      try { process.kill(group ? -child.pid : child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') errorNote ||= `Cannot stop worker: ${error.message}`; }
    }
  }
  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    signalAll('SIGTERM');
    killTimer = setTimeout(() => signalAll('SIGKILL'), 2000);
  }
  function record(outcome) {
    if (recorded) return;
    recorded = true;
    clearTimeout(timer);
    if (stopReason || errorNote) outcome = { status: stopReason ?? 'failed', text: errorNote || `Worker ${stopReason}` };
    if (outcome.status === 'failed' && stderr) outcome.text = `${outcome.text}\nStderr (tail):\n${stderr}`.slice(0, 32_000);
    finishTask(runDir, id, outcome);
    return outcome;
  }
  function start(command, args, { tui = false } = {}) {
    const child = spawn(command, args, {
      cwd: run.project, env: { ...process.env, ...launch.env, PWD: run.project },
      detached: !tui, stdio: tui ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    const entry = { child, group: !tui };
    procs.push(entry);
    entry.exited = new Promise(resolve => {
      child.on('error', error => { errorNote ||= `Cannot run ${command}: ${error.message}`; });
      child.on('close', (code, exitSignal) => resolve({ code, exitSignal }));
    });
    if (!tui) {
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') { errorNote ||= error.message; stop('failed'); } });
      child.stderr.on('data', chunk => {
        try { log(fds[1], chunk); stderr = `${stderr}${chunk.toString()}`.slice(-4000); }
        catch (error) { errorNote ||= error.message; stop('failed'); }
      });
    }
    return entry;
  }
  function log(fd, chunk) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { errorNote ||= 'Worker output exceeded 8 MiB'; stop('failed'); return; }
    writeSync(fd, chunk);
  }
  function lines(child, onLine, fd = fds[0]) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', chunk => {
      try {
        if (fd !== null) log(fd, chunk);
        if (bytes > 8 * 1024 * 1024) return;
        buffer += decoder.write(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) { onLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
        if (buffer.length > 512_000) { errorNote ||= 'Worker JSON line exceeded 512 KiB'; stop('failed'); }
      } catch (error) { errorNote ||= error.message; stop('failed'); }
    });
    return () => { buffer += decoder.end(); if (buffer.trim()) onLine(buffer); buffer = ''; };
  }

  async function claude() {
    const tui = start(launch.command, launch.args, { tui: true });
    const stopFile = join(dir, 'stop.json');
    const reported = new Promise(resolve => { poll = setInterval(() => { const value = optionalJson(stopFile); if (value) resolve(value); }, pollMs); });
    const first = await Promise.race([reported, tui.exited.then(() => null)]);
    clearInterval(poll);
    const report = first ?? optionalJson(stopFile);
    // The TUI stays open after its first turn so the user can read it; the
    // orchestrator closes successful panes once it has collected the report.
    if (report && !stopReason) record(hookOutcome(report));
    const { code, exitSignal } = await tui.exited;
    record({ status: code === 0 && !exitSignal ? 'interrupted' : 'failed', text: `Claude exited before finishing its turn (${exitSignal ?? `code ${code}`})` });
  }

  async function opencode() {
    fds.push(openSync(join(dir, 'events.jsonl'), 'wx', 0o600));
    fds.push(openSync(join(dir, 'stderr.log'), 'wx', 0o600));
    const server = start(launch.command, launch.serve);
    // `serve --stdio` prints {"url": ...} first; its stdin stays open while we live.
    const url = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('OpenCode server did not report its URL within 20s')), 20_000);
      const finish = value => { clearTimeout(deadline); value instanceof Error ? reject(value) : resolve(value); };
      lines(server.child, value => {
        try { const parsed = JSON.parse(value); if (typeof parsed.url === 'string') finish(parsed.url); } catch { /* server logs */ }
      }, null);
      server.exited.then(({ code }) => finish(new Error(`OpenCode server exited (${code}) before reporting its URL`)));
    });
    signal?.throwIfAborted();
    const events = [];
    let tui, tuiQuit;
    const quit = new Promise(resolve => { tuiQuit = resolve; });
    const client = start(launch.command, launch.run(url));
    const flush = lines(client.child, value => {
      if (!value.trim()) return;
      try { events.push(JSON.parse(value)); } catch { errorNote ||= 'Malformed JSON from worker; inspect events.jsonl'; stop('failed'); return; }
      // Attach the visible TUI once the session exists on the private server.
      if (!tui) { tui = start(launch.command, launch.tui(url), { tui: true }); tui.exited.then(tuiQuit); }
    });
    client.child.stdin.end(launch.input ?? '');
    const first = await Promise.race([client.exited.then(() => 'client'), quit.then(() => 'tui')]);
    // Quitting the TUI before the report is in means the user stopped the worker.
    if (first === 'tui') stop('interrupted');
    const { code } = await client.exited;
    signalAll('SIGKILL', [client]); // descendants in its process group
    flush();
    record(collectOutcome(events, code));
    if (tui) await tui.exited;
  }

  const abort = () => stop('interrupted');
  try {
    if (!launch) {
      const instructions = readFileSync(join(ROOT, 'prompts', `${task.role}.md`), 'utf8');
      const skills = optionalText(join(dir, 'skills.md'));
      const system = skills ? `${instructions}\nFollow the agent skills below for this assignment. They describe workflow; your role limits and permissions above still apply.\n\n${skills}` : instructions;
      const brief = `Assignment: ${task.title}\nProject: ${run.project}\n\n${task.brief}\n\n${task.context}${['reviewer', 'security', 'simplifier'].includes(task.role) ? reviewSnapshot(run.project) : ''}`;
      const configDir = join(dir, 'opencode-config');
      if (!Object.hasOwn(CLAUDE_ROLES, task.role)) mkdirSync(configDir, { mode: 0o700 });
      launch = workerLaunch(task.role, run.config, brief, system, configDir, task.title);
    }
    output.write(`\n[${task.role}] ${task.title}\nTask: ${id}\nProject: ${run.project}\n${task.skills?.length ? `Skills: ${task.skills.join(', ')}\n` : ''}\n`);
    signal?.throwIfAborted();
    timer = setTimeout(() => stop('timed_out'), run.config.taskTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    await (Object.hasOwn(CLAUDE_ROLES, task.role) ? claude() : opencode());
    const result = optionalJson(join(dir, 'result.json'));
    output.write(`\n[${result.status}] ${id}\nReport: ${join(dir, 'result.json')}\n`);
  } catch (error) {
    signalAll('SIGKILL');
    if (!optionalJson(join(dir, 'result.json'))) finishTask(runDir, id, { status: stopReason ?? (signal?.aborted ? 'interrupted' : 'failed'), text: error.message });
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); clearInterval(poll);
    signal?.removeEventListener('abort', abort);
    // Stop the private server and anything else still running.
    for (const { child } of procs) child.stdin?.end();
    signalAll('SIGTERM');
    await Promise.all(procs.map(({ exited }) => Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000).unref())])));
    signalAll('SIGKILL');
    for (const fd of fds) closeSync(fd);
  }
}
