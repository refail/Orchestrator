import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveDashboard } from '../src/dashboard.mjs';
import { copyRoot } from './fixtures/agents.mjs';

async function start(t, options = {}) {
  const root = copyRoot(t);
  const skillsDir = mkdtempSync(join(tmpdir(), 'herdr-skills-'));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  for (const name of ['security-and-hardening', 'code-review-and-quality']) {
    mkdirSync(join(skillsDir, name));
    writeFileSync(join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n`);
  }
  const dashboard = await serveDashboard({ root, skillsDir, open: false, log: () => {}, ...options });
  t.after(() => dashboard.stop());
  const base = dashboard.url.split('#')[0].replace(/\/$/, '');
  const api = (method, path, body, headers = {}) => fetch(`${base}${path}`, { method,
    headers: { 'x-token': dashboard.token, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { root, dashboard, base, api };
}
// fetch() cannot forge Host; use a raw request for rebinding checks.
const raw = (base, headers) => new Promise((resolve, reject) => {
  const url = new URL(`${base}/api/state`);
  httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers }, response => { response.resume(); resolve(response.statusCode); })
    .on('error', reject).end();
});

test('the dashboard binds to localhost, needs its token, and rejects foreign hosts and origins', async t => {
  const { dashboard, base, api } = await start(t);
  assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+\/#[\w-]{32}$/);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await api('GET', '/api/state', undefined, { 'x-token': 'wrong' })).status, 401);
  assert.equal((await api('GET', '/api/state', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal(await raw(base, { host: 'evil.example', 'x-token': dashboard.token }), 403);
  const state = await (await api('GET', '/api/state')).json();
  assert.ok(state.config.agents.coder);
  assert.ok(state.prompts.coder.trim());
  assert.deepEqual(state.skills.map(skill => skill.name), ['code-review-and-quality', 'security-and-hardening']);
});

test('saving from the dashboard writes agents.json and prompts, and refuses invalid input', async t => {
  const { root, api } = await start(t);
  const { config, prompts } = await (await api('GET', '/api/state')).json();
  const before = readFileSync(join(root, 'agents.json'), 'utf8');
  const unknownSkill = { ...config, agents: { ...config.agents, coder: { ...config.agents.coder, skills: ['nope'] } } };
  const refused = await api('PUT', '/api/state', { config: unknownSkill, prompts });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /unknown skill nope/);
  assert.equal((await api('PUT', '/api/state', { config: { ...config, limits: { maxParallel: 0, maxTasks: 1 } }, prompts })).status, 400);
  assert.equal(readFileSync(join(root, 'agents.json'), 'utf8'), before);
  const { researcher, ...agents } = config.agents;
  const { researcher: _, ...rest } = prompts;
  const reviewer = { ...agents.reviewer, model: 'openai/gpt-6.2', web: true, skills: ['code-review-and-quality'] };
  const saved = await api('PUT', '/api/state', { config: { ...config, agents: { ...agents, reviewer, docs: { ...researcher, description: 'Docs' } } },
    prompts: { ...rest, docs: 'Write docs.', reviewer: 'Review carefully.' } });
  assert.equal(saved.status, 200, await saved.clone().text());
  const disk = JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8'));
  assert.equal(disk.agents.reviewer.model, 'openai/gpt-6.2');
  assert.equal(disk.agents.reviewer.web, true);
  assert.ok(!disk.agents.researcher);
  assert.equal(readFileSync(join(root, 'prompts/docs.md'), 'utf8'), 'Write docs.');
  assert.equal(readFileSync(join(root, 'prompts/reviewer.md'), 'utf8'), 'Review carefully.');
  assert.ok(!existsSync(join(root, 'prompts/researcher.md')));
});

test('the server stops when its tab closes (after a reload grace period) or goes idle', async t => {
  const closing = await start(t, { closeGraceMs: 50 });
  assert.equal((await closing.api('POST', '/api/close')).status, 200);
  await closing.dashboard.done;
  await assert.rejects(fetch(`${closing.base}/`));
  const reloaded = await start(t, { closeGraceMs: 200 });
  await reloaded.api('POST', '/api/close');
  assert.equal((await reloaded.api('POST', '/api/ping')).status, 200, 'a reload within the grace period keeps it alive');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await reloaded.api('POST', '/api/ping')).status, 200);
  const idle = await start(t, { idleMs: 50 });
  await idle.dashboard.done;
});
