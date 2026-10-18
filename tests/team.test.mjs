import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, delegate, taskStatus, listTasks, finishTask, waitForTasks, readTask } from '../src/team.mjs';
import { DEFAULT_CONFIG } from '../src/profiles.mjs';

function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-orch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project with spaces');
  mkdirSync(project);
  const state = join(root, 'state');
  const run = createRun(state, project, 'w1', { ...DEFAULT_CONFIG, ...config });
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
  const other = createRun(state, project, 'w2', DEFAULT_CONFIG);
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
  const { run } = fixture(t, { maxParallel: 1 });
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
  const { run } = fixture(t, { maxParallel: 1 });
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
