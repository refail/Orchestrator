import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, delegate, taskStatus, listTasks, finishTask, waitForTasks, readTask, readRun, recoverTask, pruneRuns } from '../src/team.mjs';
import { config as agents, DEFAULTS } from './fixtures/agents.mjs';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-orch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project with spaces');
  mkdirSync(project);
  const state = join(root, 'state');
  const run = createRun(state, project, 'w1', agents(overrides));
  return { root, project, state, run };
}
const openPane = async () => ({ pane: { pane_id: 'w1:p2' } });

test('delegation publishes a brief as data and targets the saved workspace', async t => {
  const { run } = fixture(t);
  let invocation;
  const task = await delegate(run, { role: 'researcher', title: 'Find entrypoint', brief: '$(touch BAD); `exit`\nFind the relevant code.' }, async value => {
    invocation = value;
    return openPane();
  });
  assert.equal(invocation.workspace, 'w1');
  assert.equal(invocation.entrypoint, 'worker');
  assert.equal(invocation.env.HERDR_ORCH_TASK, task.id);
  assert.equal(invocation.focus, false);
  assert.ok(!JSON.stringify(invocation).includes('touch BAD'));
  assert.equal(taskStatus(run, task.id).status, 'starting');
  assert.match(readTask(run, task.id).brief, /touch BAD/);
});

test('a checkout lease prevents overlapping writers and review, including across runs', async t => {
  const { run, state, project } = fixture(t);
  const other = createRun(state, project, 'w2', DEFAULTS);
  const coder = await delegate(run, { role: 'coder', title: 'Code', brief: 'Implement' }, openPane);
  await assert.rejects(delegate(other, { role: 'coder', title: 'Other', brief: 'Implement' }, openPane), /checkout.*busy/i);
  await assert.rejects(delegate(other, { role: 'reviewer', title: 'Review', brief: 'Review' }, openPane), /checkout.*busy/i);
  const researcher = await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane);
  assert.ok(researcher.id);
  finishTask(run, coder.id, { status: 'completed', text: 'Done' });
  const review = await delegate(other, { role: 'reviewer', title: 'Review', brief: 'Review' }, openPane);
  assert.equal(taskStatus(other, review.id).status, 'starting');
});

test('ambiguous launch failures stay unresolved and keep the checkout lease', async t => {
  const { run } = fixture(t);
  await assert.rejects(delegate(run, { role: 'coder', title: 'Code', brief: 'Implement' }, async () => { throw new Error('API timed out'); }), /uncertain/i);
  const [task] = listTasks(run);
  assert.equal(task.status, 'launch_uncertain');
  await assert.rejects(delegate(run, { role: 'coder', title: 'Retry', brief: 'Implement' }, openPane), /checkout.*busy/i);
});

test('task bounds and input validation happen before any pane launch', async t => {
  const { run } = fixture(t, { limits: { maxParallel: 1 } });
  await assert.rejects(delegate(run, { role: 'shell', title: 'Bad', brief: 'bad' }, openPane), /role/i);
  await assert.rejects(delegate(run, { role: 'coder', title: 'Bad', brief: '' }, openPane), /brief/i);
  await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane);
  await assert.rejects(delegate(run, { role: 'researcher', title: 'Other', brief: 'Find' }, openPane), /parallel/i);
  assert.throws(() => taskStatus(run, '../../secrets'), /task id/i);
});

test('follow-ups include the prior task and its report, not arbitrary files', async t => {
  const { run } = fixture(t);
  const initial = await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find router' }, openPane);
  finishTask(run, initial.id, { status: 'completed', text: 'Router is src/router.js' });
  const next = await delegate(run, { role: 'researcher', title: 'Follow up', brief: 'Find handlers', previousTask: initial.id }, openPane);
  assert.match(readTask(run, next.id).context, /src\/router.js/);
  await assert.rejects(delegate(run, { role: 'researcher', title: 'Bad', brief: 'Find', previousTask: next.id }, openPane), /not finished/);
});

test('waiting is bounded and aborting it does not cancel workers', async t => {
  const { run } = fixture(t);
  const task = await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane);
  const result = await waitForTasks(run, [task.id], 10);
  assert.equal(result[0].status, 'starting');
  await assert.rejects(waitForTasks(run, [task.id], 1000, AbortSignal.abort()), /abort/i);
  assert.equal(taskStatus(run, task.id).status, 'starting');
  finishTask(run, task.id, { status: 'failed', text: 'Auth failed' });
  assert.equal((await waitForTasks(run, [task.id], 10))[0].status, 'failed');
});

test('concurrent dispatch cannot exceed the configured parallel limit', async t => {
  const { run } = fixture(t, { limits: { maxParallel: 1 } });
  const results = await Promise.allSettled([0, 1].map(i => delegate(run, { role: 'researcher', title: `Find ${i}`, brief: 'Find' }, openPane)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(listTasks(run).length, 1);
});

test('a vanished runner remains unresolved instead of becoming successful', async t => {
  const { run } = fixture(t);
  const task = await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane);
  writeFileSync(join(run, 'tasks', task.id, 'started.json'), JSON.stringify({ pid: 2147483647 }));
  const status = taskStatus(run, task.id);
  assert.equal(status.status, 'unknown');
  assert.equal(status.finished, false);
});

test('terminal outcomes are immutable and malformed results do not become success', async t => {
  const { run } = fixture(t);
  const task = await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane);
  finishTask(run, task.id, { status: 'completed', text: 'Done' });
  assert.throws(() => finishTask(run, task.id, { status: 'completed', text: 'Again' }), /exists/);
  writeFileSync(join(run, 'tasks', task.id, 'result.json'), '{broken');
  assert.throws(() => taskStatus(run, task.id), /JSON/);
});

test('named skills are validated and snapshotted for the worker, and panes get a readable label', async t => {
  const { root, run } = fixture(t);
  const skillsDir = join(root, 'skills');
  mkdirSync(join(skillsDir, 'test-driven-development'), { recursive: true });
  writeFileSync(join(skillsDir, 'test-driven-development', 'SKILL.md'), '---\nname: test-driven-development\ndescription: Red, green, refactor.\n---\nWrite a failing test first.');
  let label;
  const task = await delegate(run, { role: 'coder', title: 'Fix empty password', brief: 'Implement', skills: ['test-driven-development'] },
    async value => { label = value.label; return openPane(); }, { skillsDir });
  assert.equal(label, 'coder · Fix empty password');
  assert.deepEqual(readTask(run, task.id).skills, ['test-driven-development']);
  assert.match(readFileSync(join(task.directory, 'skills.md'), 'utf8'), /<skill name="test-driven-development">[\s\S]*failing test first/);
  for (const skills of [['missing-skill'], ['../secrets'], ['a', 'a'], ['a', 'b', 'c', 'd', 'e'], 'tdd']) {
    await assert.rejects(delegate(run, { role: 'researcher', title: 'Bad', brief: 'Find', skills }, openPane, { skillsDir }), /skill/i);
  }
  assert.equal(listTasks(run).length, 1, 'invalid skills never launch a pane');
  finishTask(run, task.id, { status: 'completed', text: 'Done' });
  mkdirSync(join(skillsDir, 'security-and-hardening'));
  writeFileSync(join(skillsDir, 'security-and-hardening', 'SKILL.md'), '---\nname: security-and-hardening\ndescription: Harden.\n---\nValidate untrusted input.');
  const audit = await delegate(run, { role: 'security', title: 'Audit', brief: 'Audit the diff', skills: ['test-driven-development'] }, openPane, { skillsDir });
  assert.deepEqual(readTask(run, audit.id).skills, ['security-and-hardening', 'test-driven-development'], 'security always follows its skill');
  await assert.rejects(delegate(run, { role: 'simplifier', title: 'Simplify', brief: 'Simplify' }, openPane, { skillsDir }), /checkout.*busy/i);
});

test('collected panes of completed workers close once; failed ones stay open', async t => {
  const { run } = fixture(t);
  const launch = async value => ({ pane: { pane_id: 'w1:p9', terminal_id: `term-${value.env.HERDR_ORCH_TASK}` } });
  const done = await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, launch);
  const failed = await delegate(run, { role: 'researcher', title: 'Other', brief: 'Find' }, launch);
  finishTask(run, done.id, { status: 'completed', text: 'Done' });
  finishTask(run, failed.id, { status: 'failed', text: 'Auth failed' });
  const closed = [];
  const close = async terminal => { closed.push(terminal); return true; };
  await waitForTasks(run, [done.id, failed.id], 10, undefined, close);
  await waitForTasks(run, [done.id, failed.id], 10, undefined, close);
  assert.deepEqual(closed, [`term-${done.id}`]);
  const pending = await delegate(run, { role: 'researcher', title: 'Pending', brief: 'Find' }, launch);
  const [result] = await waitForTasks(run, [pending.id], 10, undefined, async () => { throw new Error('Herdr unavailable'); });
  assert.equal(result.status, 'starting');
  const retry = await delegate(run, { role: 'researcher', title: 'Retry close', brief: 'Find' }, launch);
  finishTask(run, retry.id, { status: 'completed', text: 'Done' });
  const [failure] = await waitForTasks(run, [retry.id], 10, undefined, async () => { throw new Error('Herdr unavailable'); });
  assert.equal(failure.status, 'completed', 'a failed close never changes the outcome');
  assert.match(failure.closeError, /unavailable/);
});

test('runs snapshot their agents: custom roles dispatch, leases follow `exclusive`, and later edits do not leak in', async t => {
  const { run, state, project } = fixture(t, {
    agents: { docs: { description: 'Writes documentation', harness: 'claude', model: null, effort: null, tools: 'edit', web: true,
      skills: [], timeoutMinutes: 5, exclusive: true, diff: false }, researcher: null },
    prompts: { docs: 'Write docs.' },
  });
  const snapshot = readRun(run).config;
  assert.deepEqual(Object.keys(snapshot.agents), ['coder', 'reviewer', 'security', 'simplifier', 'docs']);
  assert.equal(snapshot.prompts.docs, 'Write docs.');
  const team = readFileSync(join(run, 'orchestrator.md'), 'utf8');
  assert.match(team, /^Coordinate\./);
  assert.match(team, /\*\*docs\*\* — Writes documentation \(can read and edit files.*has web access.*5 min\)/);
  assert.doesNotMatch(team, /researcher/);
  await assert.rejects(delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane), /Invalid role; use one of coder, reviewer/);
  const docs = await delegate(run, { role: 'docs', title: 'Docs', brief: 'Write' }, openPane);
  await assert.rejects(delegate(run, { role: 'reviewer', title: 'Review', brief: 'Review' }, openPane), /busy with docs task/);
  finishTask(run, docs.id, { status: 'completed', text: 'Done' });
  // A run started with different settings keeps its own.
  const other = createRun(state, project, 'w1', agents({ agents: { reviewer: { exclusive: false } } }));
  const first = await delegate(other, { role: 'reviewer', title: 'Review A', brief: 'Review' }, openPane);
  assert.ok(first.id);
  assert.ok((await delegate(run, { role: 'coder', title: 'Code', brief: 'Implement' }, openPane)).id, 'a non-exclusive reviewer holds no lease');
});

test('runs from before agents.json stay readable but cannot dispatch', async t => {
  const { run } = fixture(t);
  const legacy = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8'));
  legacy.config = { orchestratorModel: 'openai-codex/gpt-6.1-sol', maxParallel: 3 };
  rmSync(join(run, 'run.json'));
  writeFileSync(join(run, 'run.json'), JSON.stringify(legacy));
  assert.equal(readRun(run).legacy, true);
  assert.deepEqual(listTasks(run), []);
  await assert.rejects(delegate(run, { role: 'coder', title: 'Code', brief: 'Implement' }, openPane), /older plugin version/);
});

test('a dispatch lock left by a dead process is replaced; a live one still blocks', async t => {
  const { run, state } = fixture(t);
  mkdirSync(join(state, 'dispatch.lock'));
  writeFileSync(join(state, 'dispatch.lock', 'owner'), '2147483647');
  assert.ok((await delegate(run, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane)).id);
  mkdirSync(join(state, 'dispatch.lock'));
  writeFileSync(join(state, 'dispatch.lock', 'owner'), String(process.pid));
  await assert.rejects(delegate(run, { role: 'researcher', title: 'Other', brief: 'Find' }, openPane), /Another dispatch/);
});

test('recovering a lost worker records interrupted and frees the checkout; live ones need confirmation', async t => {
  const { run } = fixture(t);
  const lost = await delegate(run, { role: 'coder', title: 'Code', brief: 'Implement' }, openPane);
  assert.throws(() => recoverTask(run, lost.id), /--confirm/);
  writeFileSync(join(run, 'tasks', lost.id, 'started.json'), JSON.stringify({ pid: 2147483647 }));
  assert.equal(recoverTask(run, lost.id).status, 'interrupted');
  assert.throws(() => recoverTask(run, lost.id), /already interrupted/);
  const next = await delegate(run, { role: 'coder', title: 'Again', brief: 'Implement' }, openPane);
  assert.equal(recoverTask(run, next.id, { confirmed: true }).status, 'interrupted');
});

test('tasks are listed in creation order', async t => {
  const { run } = fixture(t);
  const ids = [];
  for (const title of ['One', 'Two', 'Three']) {
    const task = await delegate(run, { role: 'researcher', title, brief: 'Find' }, openPane);
    finishTask(run, task.id, { status: 'completed', text: 'Done' });
    ids.push(task.id);
    await new Promise(resolve => setTimeout(resolve, 5)); // distinct createdAt timestamps
  }
  assert.deepEqual(listTasks(run).map(task => task.id), ids);
});

test('pruning removes runs idle for longer than the limit, but never active or leased ones', async t => {
  const { run: old, state, project } = fixture(t);
  const recent = createRun(state, project, 'w1', DEFAULTS);
  const leased = createRun(state, project, 'w1', DEFAULTS);
  const running = createRun(state, project, 'w1', DEFAULTS);
  mkdirSync(join(recent, 'sessions'));
  await delegate(leased, { role: 'coder', title: 'Code', brief: 'Implement' }, openPane);
  const worker = await delegate(running, { role: 'researcher', title: 'Find', brief: 'Find' }, openPane);
  writeFileSync(join(worker.directory, 'started.json'), JSON.stringify({ pid: process.pid }));
  const week = 7 * 24 * 3600_000, now = Date.now() + 30 * 24 * 3600_000;
  const age = (dir, ms) => {
    const when = new Date(now - ms);
    for (const entry of readdirSync(dir, { recursive: true })) utimesSync(join(dir, entry), when, when);
    utimesSync(dir, when, when);
  };
  for (const dir of [old, leased, running]) age(dir, week + 60_000);
  age(recent, week + 60_000);
  utimesSync(join(recent, 'sessions'), new Date(now - 1000), new Date(now - 1000)); // a Pi session still in use
  const preview = pruneRuns(state, { maxAgeMs: week, now, dryRun: true });
  assert.deepEqual(preview.removed.map(item => item.dir), [old]);
  assert.ok(existsSync(old), 'dry run deletes nothing');
  const result = pruneRuns(state, { maxAgeMs: week, now });
  assert.deepEqual(result.removed.map(item => item.dir), [old]);
  assert.ok(!existsSync(old));
  assert.deepEqual(Object.fromEntries(result.kept.map(item => [item.dir, item.reason])),
    { [recent]: 'recent activity', [leased]: 'holds the checkout lease', [running]: 'a worker is still running' });
  assert.deepEqual(pruneRuns(join(state, 'missing'), { maxAgeMs: week }), { removed: [], kept: [] });
});
