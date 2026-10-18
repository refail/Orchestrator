import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, delegate, taskStatus } from '../src/team.mjs';
import { DEFAULT_CONFIG, workerLaunch } from '../src/profiles.mjs';
import { runWorker, collectOutcome, hookOutcome } from '../src/worker.mjs';

const AGENT = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));
async function setup(t, role = 'researcher', config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-orch-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project'));
  const run = createRun(join(root, 'state'), join(root, 'project'), 'w1', { ...DEFAULT_CONFIG, ...config });
  const task = await delegate(run, { role, title: 'Test', brief: 'Inspect the entrypoint' }, async () => ({ pane: {} }));
  return { run, task };
}
// Fake OpenCode: private server + headless client + TUI attached to the same session.
function openCode(run, task, clientArgs, tui = join(task.directory, 'result.json')) {
  return { command: process.execPath, env: {}, input: 'brief',
    serve: [AGENT, 'serve'], run: () => clientArgs, tui: () => [AGENT, 'tui', tui] };
}
// Fake interactive Claude that runs the real Stop hook command from the profile.
function claude(run, task, event, then = 'exit') {
  const real = workerLaunch('coder', DEFAULT_CONFIG, 'Assignment: x', 'instructions');
  return { command: process.execPath, args: [AGENT, 'claude', event, then, '--settings', real.args[real.args.indexOf('--settings') + 1]],
    env: { HERDR_ORCH_RUN: run, HERDR_ORCH_TASK: task.id } };
}
const quiet = { write() {} };

test('Claude hook outcomes need a Stop with a final report', () => {
  assert.equal(hookOutcome({ event: 'Stop', text: 'Done' }).status, 'completed');
  assert.equal(hookOutcome({ event: 'Stop', text: 'BLOCKED: approve npm test' }).status, 'blocked');
  assert.equal(hookOutcome({ event: 'Stop', text: '  ' }).status, 'failed');
  assert.equal(hookOutcome({ event: 'StopFailure', error: 'rate_limit', text: 'partial' }).status, 'failed');
  assert.equal(hookOutcome(null).status, 'failed');
});

test('OpenCode completion needs a report, successful CLI exit and no provider error', () => {
  const text = { type: 'text', part: { text: 'Found router.js' } };
  assert.equal(collectOutcome([text], 0).status, 'failed');
  assert.equal(collectOutcome([text, { type: 'step_finish', part: { reason: 'tool-calls' } }], 0).status, 'failed');
  assert.equal(collectOutcome([text, { type: 'step_finish', part: { reason: 'stop' } }], 0).status, 'completed');
  assert.equal(collectOutcome([{ type: 'error', error: { data: { message: 'No auth' } } }], 0).status, 'failed');
});

test('OpenCode v2 can complete without emitting step_finish', () => {
  const events = [{ type: 'step_start', part: { type: 'step-start' } }, { type: 'text', part: { text: 'Found router.js' } }];
  assert.equal(collectOutcome(events, 0).status, 'completed');
  assert.equal(collectOutcome(events, 1).status, 'failed');
  assert.equal(collectOutcome([...events, { type: 'step_finish', part: { reason: 'stop' } }, events[0]], 0).status, 'failed');
  assert.equal(collectOutcome([events[0]], 0).status, 'failed');
  assert.equal(collectOutcome([...events, { type: 'step_finish', part: { reason: 'tool-calls' } }], 0).status, 'failed');
  assert.equal(collectOutcome([events[0], { type: 'step_finish', part: { reason: 'tool-calls' } }, events[1]], 0).status, 'completed');
  assert.equal(collectOutcome([...events, { type: 'error', error: { type: 'unknown', message: 'Provider unavailable' } }], 0).status, 'failed');
});

test('headless OpenCode output is captured as the report while the TUI shows the session', async t => {
  const { run, task } = await setup(t);
  await runWorker(run, task.id, { launch: openCode(run, task, [AGENT, 'success']), output: quiet });
  const result = taskStatus(run, task.id, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.report, 'Found src/router.js — café');
  const events = readFileSync(join(result.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /step_finish/);
  assert.doesNotMatch(events, /starting|127\.0\.0\.1/, 'server output is not mixed into client events');
  await assert.rejects(runWorker(run, task.id, { launch: openCode(run, task, [AGENT, 'success']), output: quiet }), /exists|finished/);
});

test('nonzero exit, malformed JSON and missing final event never count as success', async t => {
  for (const mode of ['failure', 'malformed', 'incomplete']) {
    const { run, task } = await setup(t);
    await runWorker(run, task.id, { launch: openCode(run, task, [AGENT, mode]), output: quiet });
    assert.equal(taskStatus(run, task.id).status, 'failed', mode);
  }
});

test('quitting the OpenCode TUI before the report stops the worker as interrupted', async t => {
  const { run, task } = await setup(t);
  await runWorker(run, task.id, { launch: openCode(run, task, [AGENT, 'slow'], 'quit'), output: quiet });
  assert.equal(taskStatus(run, task.id).status, 'interrupted');
});

test('workers receive the project PWD, not the launching plugin directory', async t => {
  const { run, task } = await setup(t);
  const project = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')).project;
  const script = `console.log(JSON.stringify({type:'step_start'})); console.log(JSON.stringify({type:'text',part:{text:process.env.PWD}}));`;
  await runWorker(run, task.id, { launch: { ...openCode(run, task, ['-e', script]), env: { PWD: '/wrong-project' } }, output: quiet });
  assert.equal(taskStatus(run, task.id, true).report, project);
  assert.equal(taskStatus(run, task.id).status, 'completed');
});

test('interactive Claude completes from its first Stop hook, ignoring later turns', async t => {
  const { run, task } = await setup(t, 'coder');
  await runWorker(run, task.id, { launch: claude(run, task, 'Stop'), output: quiet, pollMs: 20 });
  const status = taskStatus(run, task.id, true);
  assert.equal(status.status, 'completed');
  assert.equal(status.report, 'Updated change.txt. Tests passed.');
  assert.equal(JSON.parse(readFileSync(join(status.directory, 'stop.json'), 'utf8')).transcript, '/t.jsonl');
});

test('the report is recorded while the Claude TUI stays open, and the lease is released', async t => {
  const { run, task } = await setup(t, 'coder');
  const controller = new AbortController();
  const worker = runWorker(run, task.id, { launch: claude(run, task, 'Stop', 'stay'), signal: controller.signal, output: quiet, pollMs: 20 });
  for (let i = 0; i < 100 && !taskStatus(run, task.id).finished; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(taskStatus(run, task.id).status, 'completed');
  assert.ok((await delegate(run, { role: 'coder', title: 'Next', brief: 'Implement' }, async () => ({}))).id);
  controller.abort(); // closing the pane
  await worker;
  assert.equal(taskStatus(run, task.id).status, 'completed');
});

test('Claude API failures and exits without a report are not success', async t => {
  for (const [event, expected] of [['StopFailure', 'failed'], ['none', 'interrupted']]) {
    const { run, task } = await setup(t, 'coder');
    await runWorker(run, task.id, { launch: claude(run, task, event), output: quiet, pollMs: 20 });
    assert.equal(taskStatus(run, task.id).status, expected, event);
  }
});

test('missing executable becomes an actionable failure and releases the coder lease', async t => {
  const { run, task } = await setup(t, 'coder');
  await runWorker(run, task.id, { launch: { command: '/no/such/agent', args: [], env: {} }, output: quiet });
  const status = taskStatus(run, task.id, true);
  assert.equal(status.status, 'failed');
  assert.match(status.report, /Cannot run/);
  const next = await delegate(run, { role: 'coder', title: 'Retry', brief: 'Implement' }, async () => ({}));
  assert.ok(next.id);
});

test('cancellation stops the child and publishes interrupted, not completed', async t => {
  const { run, task } = await setup(t, 'coder');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await runWorker(run, task.id, { launch: { command: process.execPath, args: [AGENT, 'hang'], env: {} }, signal: controller.signal, output: quiet }); }
  finally { clearTimeout(timer); }
  assert.equal(taskStatus(run, task.id).status, 'interrupted');
});

test('worker deadlines produce timed_out outcomes', async t => {
  const { run, task } = await setup(t, 'researcher', { taskTimeoutMs: 1000 });
  await runWorker(run, task.id, { launch: openCode(run, task, [AGENT, 'hang']), output: quiet });
  assert.equal(taskStatus(run, task.id).status, 'timed_out');
});
