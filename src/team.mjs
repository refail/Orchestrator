import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, realpathSync, readFileSync, writeFileSync, linkSync, unlinkSync, rmSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkSnapshot, teamSection, NAME } from './agents.mjs';
import { loadSkill, SKILLS_DIR } from './skills.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL = ['completed', 'failed', 'blocked', 'interrupted', 'timed_out'];
export function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function optionalJson(path) {
  try { return json(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Publish once, atomically. link() refuses to overwrite an existing outcome.
export function publish(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { linkSync(temp, path); } finally { unlinkSync(temp); }
}
// `config` is a snapshotAgents() value: agent settings plus prompt text.
export function createRun(stateRoot, project, workspace, config) {
  if (typeof workspace !== 'string' || !workspace) throw new Error('Missing workspace identity');
  project = realpathSync(project);
  mkdirSync(join(stateRoot, 'runs'), { recursive: true, mode: 0o700 });
  mkdirSync(join(stateRoot, 'leases'), { recursive: true, mode: 0o700 });
  stateRoot = realpathSync(stateRoot);
  const id = randomUUID();
  const runDir = join(stateRoot, 'runs', id);
  config = checkSnapshot(config);
  mkdirSync(join(runDir, 'tasks'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runDir, 'orchestrator.md'), `${config.prompts.orchestrator.trimEnd()}\n\n${teamSection(config)}`, { mode: 0o600, flag: 'wx' });
  publish(join(runDir, 'run.json'), { id, stateRoot, project, workspace, config, createdAt: new Date().toISOString() });
  return runDir;
}
export function readRun(runDir) {
  const run = json(join(runDir, 'run.json'));
  if (!ID.test(run.id) || realpathSync(runDir) !== join(realpathSync(run.stateRoot), 'runs', run.id)) throw new Error('Invalid run directory identity');
  // Runs from before agents.json stay readable for status/inspect only.
  if (run.config?.agents) run.config = checkSnapshot(run.config);
  else run.legacy = true;
  return run;
}
export function taskDir(runDir, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid task id');
  return join(runDir, 'tasks', id);
}
export function readTask(runDir, id) {
  const task = json(join(taskDir(runDir, id), 'task.json'));
  if (task.id !== id || typeof task.role !== 'string' || !NAME.test(task.role)) throw new Error('Invalid task record');
  return task;
}
function leasePath(run) {
  return join(run.stateRoot, 'leases', `${createHash('sha256').update(run.project).digest('hex')}.json`);
}
export function finishTask(runDir, id, outcome) {
  readTask(runDir, id);
  const run = readRun(runDir);
  if (!TERMINAL.includes(outcome.status) || typeof outcome.text !== 'string') throw new Error('Invalid worker outcome');
  publish(join(taskDir(runDir, id), 'result.json'), { ...outcome, taskId: id, finishedAt: new Date().toISOString() });
  const path = leasePath(run);
  const lease = optionalJson(path);
  if (lease?.taskId === id && lease.runDir === runDir) unlinkSync(path);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
export function taskStatus(runDir, id, full = false) {
  const task = readTask(runDir, id);
  const dir = taskDir(runDir, id);
  const result = optionalJson(join(dir, 'result.json'));
  if (result && (result.taskId !== id || !TERMINAL.includes(result.status) || typeof result.text !== 'string')) throw new Error('Invalid worker result');
  const started = optionalJson(join(dir, 'started.json'));
  const uncertain = optionalJson(join(dir, 'launch-error.json'));
  let status = result?.status ?? (started ? 'running' : uncertain ? 'launch_uncertain' : 'starting');
  if (!result && started && !alive(started.pid)) status = 'unknown';
  return { id, role: task.role, title: task.title, status, finished: Boolean(result), createdAt: task.createdAt,
    report: result ? result.text.slice(0, full ? 32_000 : 500) : undefined,
    detail: uncertain?.message, directory: dir };
}
export function listTasks(runDir, full = false) {
  readRun(runDir);
  return readdirSync(join(runDir, 'tasks')).filter(id => ID.test(id)).map(id => taskStatus(runDir, id, full))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
// Owner-driven recovery for a worker whose runner was lost (hard kill, closed
// pane). Records `interrupted` and releases its checkout lease. Anything other
// than a provably dead runner needs explicit confirmation.
export function recoverTask(runDir, id, { confirmed = false } = {}) {
  const status = taskStatus(runDir, id);
  if (status.finished) throw new Error(`Task is already ${status.status}; nothing to recover`);
  if (status.status !== 'unknown' && !confirmed) {
    throw new Error(`Task is ${status.status}, so its worker may still be running. Close its pane, check that no agent processes remain, then rerun with --confirm`);
  }
  finishTask(runDir, id, { status: 'interrupted', text: `Recovered by the owner after the worker was lost (was ${status.status}).` });
  return taskStatus(runDir, id);
}
// Short-lived global dispatch lock. A lock left by a crashed process (dead
// owner, or no owner recorded for a minute) is replaced once.
function acquireLock(lock) {
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, 'owner'), String(process.pid)); return; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt || !staleLock(lock)) throw new Error('Another dispatch is in progress; inspect status before retrying');
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
function staleLock(lock) {
  let pid;
  try { pid = Number(readFileSync(join(lock, 'owner'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Number.isInteger(pid) && pid > 0) return !alive(pid);
  try { return Date.now() - statSync(lock).mtimeMs > 60_000; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// Newest modification time anywhere in a directory tree (Pi appends to its
// session while a run is in use, so this tracks real activity).
function lastActivity(dir) {
  let newest = lstatSync(dir).mtimeMs;
  for (const entry of readdirSync(dir, { recursive: true })) newest = Math.max(newest, lstatSync(join(dir, entry)).mtimeMs);
  return newest;
}
// Delete run records idle for longer than maxAgeMs. Runs holding a checkout
// lease or with a live worker are always kept.
export function pruneRuns(stateRoot, { maxAgeMs, now = Date.now(), dryRun = false }) {
  let ids;
  try { ids = readdirSync(join(stateRoot, 'runs')); } catch (error) { if (error.code === 'ENOENT') return { removed: [], kept: [] }; throw error; }
  stateRoot = realpathSync(stateRoot);
  let leaseFiles = [];
  try { leaseFiles = readdirSync(join(stateRoot, 'leases')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const leased = new Set(leaseFiles.filter(name => name.endsWith('.json')).map(name => optionalJson(join(stateRoot, 'leases', name))?.runDir));
  const removed = [], kept = [];
  for (const id of ids.filter(id => ID.test(id)).sort()) {
    const dir = join(stateRoot, 'runs', id);
    let tasks = [];
    try { tasks = listTasks(dir); } catch { /* damaged record: judged by age alone */ }
    const last = lastActivity(dir);
    const reason = leased.has(dir) ? 'holds the checkout lease'
      : tasks.some(task => task.status === 'running') ? 'a worker is still running'
      : now - last < maxAgeMs ? 'recent activity' : null;
    if (reason) { kept.push({ dir, reason }); continue; }
    if (!dryRun) rmSync(dir, { recursive: true, force: true });
    removed.push({ dir, lastActivity: new Date(last).toISOString() });
  }
  return { removed, kept };
}
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name} (1–${max} characters)`);
  return value;
}
export async function delegate(runDir, input, openPane, { skillsDir = SKILLS_DIR } = {}) {
  const run = readRun(runDir);
  if (run.legacy) throw new Error('This run was created by an older plugin version; start a new feature run');
  const agent = Object.hasOwn(run.config.agents, input.role) ? run.config.agents[input.role] : null;
  if (!agent) throw new Error(`Invalid role; use one of ${Object.keys(run.config.agents).join(', ')}`);
  text(input.title, 'title', 100);
  text(input.brief, 'brief', 16_000);
  const requested = input.skills ?? [];
  if (!Array.isArray(requested) || requested.length > 4 || new Set(requested).size !== requested.length) throw new Error('Invalid skills (at most 4 distinct names)');
  const skills = [...new Set([...agent.skills, ...requested])];
  // Snapshot skill text now so the worker gets exactly what was validated.
  const skillText = skills.map(name => `<skill name="${name}">\n${loadSkill(name, skillsDir)}\n</skill>`).join('\n\n');
  let context = '';
  if (input.previousTask) {
    const prior = taskStatus(runDir, input.previousTask, true);
    if (!prior.finished) throw new Error('Previous task is not finished');
    context = `Previous assignment:\n${readTask(runDir, input.previousTask).brief}\nPrevious report (${prior.status}):\n${prior.report}`;
  }
  // The dispatch lock serializes admission and checkout leases.
  const lock = join(run.stateRoot, 'dispatch.lock');
  acquireLock(lock);
  try {
    const tasks = listTasks(runDir);
    if (tasks.length >= run.config.limits.maxTasks) throw new Error('Run task limit reached');
    if (tasks.filter(task => !task.finished).length >= run.config.limits.maxParallel) throw new Error('Parallel task limit reached');
    const id = randomUUID();
    let leased = false;
    if (agent.exclusive) {
      try { publish(leasePath(run), { runDir, taskId: id, role: input.role }); leased = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const holder = optionalJson(leasePath(run));
        throw new Error(`Checkout is busy with ${holder?.role ?? 'another'} task ${holder?.taskId ?? ''}; wait for it, or inspect ${leasePath(run)}`);
      }
    }
    const dir = taskDir(runDir, id);
    try {
      mkdirSync(dir, { mode: 0o700 });
      publish(join(dir, 'task.json'), { id, role: input.role, title: input.title, brief: input.brief, context, skills, createdAt: new Date().toISOString() });
      if (skillText) writeFileSync(join(dir, 'skills.md'), skillText, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (leased) unlinkSync(leasePath(run));
      throw error;
    }
    try {
      const receipt = await openPane({ workspace: run.workspace, anchor: optionalJson(join(runDir, 'coordinator.json'))?.pane?.terminal_id,
        project: run.project, entrypoint: 'worker', focus: false, label: `${input.role} · ${input.title}`.slice(0, 60),
        env: { HERDR_ORCH_RUN: runDir, HERDR_ORCH_TASK: id } });
      publish(join(dir, 'launch.json'), receipt);
    } catch (error) {
      // The command may already have opened a pane. Preserve the attempt/lease.
      publish(join(dir, 'launch-error.json'), { message: String(error.message).slice(0, 2000) });
      throw new Error(`Worker launch uncertain for ${id}; inspect team_status before doing anything else. Do not duplicate this assignment.`);
    }
    return taskStatus(runDir, id);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
// Close collected panes of successful workers. Unsuccessful ones stay open for
// inspection. Closing is best-effort and never changes a recorded outcome.
async function closeCompleted(tasks, closePane) {
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    const closed = join(task.directory, 'closed.json');
    if (optionalJson(closed)) continue;
    const terminal = optionalJson(join(task.directory, 'launch.json'))?.pane?.terminal_id;
    try { publish(closed, { closed: await closePane(terminal), at: new Date().toISOString() }); }
    catch (error) { task.closeError = String(error.message).slice(0, 500); }
  }
}
export async function waitForTasks(runDir, ids, timeoutMs = 30_000, signal, closePane) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8) throw new Error('Wait for 1–8 task ids');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Wait timeout must be 1–60000 ms');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    const tasks = ids.map(id => taskStatus(runDir, id, true));
    if (tasks.every(task => task.finished) || Date.now() >= deadline) {
      if (closePane) await closeCompleted(tasks, closePane);
      return tasks;
    }
    await sleep(Math.min(200, deadline - Date.now()), undefined, { signal });
  }
}
