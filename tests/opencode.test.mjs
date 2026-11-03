import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { workerLaunch } from '../src/profiles.mjs';
import { DEFAULTS } from './fixtures/agents.mjs';

const version = spawnSync('opencode', ['--version'], { encoding: 'utf8' }).stdout?.trim();
test('installed OpenCode v2 resolves isolated read-only profiles without model calls', { skip: !version, timeout: 30_000 }, async t => {
  assert.match(version, /\bv?2\./, 'This plugin targets OpenCode v2');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-opencode-v2-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(join(root, '.opencode', 'plugins', 'trap.js'), 'throw new Error("Project plugins must not load in a worker");');
  const profiles = { ...DEFAULTS.agents, runner: { ...DEFAULTS.agents.reviewer, tools: 'full', web: true } };
  for (const role of ['reviewer', 'researcher', 'simplifier', 'runner']) {
    const configDir = join(root, role);
    mkdirSync(configDir);
    const launch = workerLaunch(role, profiles[role], 'brief', `Read-only ${role}.`, configDir);
    const password = randomUUID();
    const child = spawn('opencode', ['serve', '--stdio', '--port', '0'], {
      // A dummy key enables the env-key provider; no request is ever sent.
      cwd: root, env: { ...process.env, ...launch.env, PWD: root, OPENCODE_PASSWORD: password, OPENAI_API_KEY: 'sk-test-not-used' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '', buffer = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000); });
    const closed = once(child, 'close');
    const stop = async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await closed; } finally { clearTimeout(timer); }
    };
    t.after(stop);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OpenCode startup timed out: ${stderr}`)), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(buffer.split('\n')[0]).url); } catch (error) { reject(error); }
      });
    });
    const get = async path => {
      const response = await fetch(`${url}/api/${path}?${new URLSearchParams({ 'location[directory]': root })}`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }, signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    };
    // V2 initializes a location asynchronously; its first agent.list can be empty.
    let agent;
    for (let i = 0; i < 60; i++) {
      agent = (await get('agent')).find(item => item.id === `personal-${role}`);
      if (agent) break;
      await sleep(100);
    }
    assert.ok(agent, `OpenCode did not resolve ${role}: ${stderr}`);
    assert.equal(agent.system, `Read-only ${role}.`);
    const action = (tool, path = '*') => agent.permissions.findLast(rule =>
      (rule.action === tool || rule.action === '*') &&
      new RegExp(`^${rule.resource.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(path))?.effect;
    const writes = ['simplifier', 'runner'].includes(role) ? [] : ['edit', 'write', 'patch'];
    const granted = role === 'runner' ? ['shell', 'webfetch', 'websearch'] : [];
    for (const tool of ['shell', 'bash', ...writes, 'subagent', 'skill', 'webfetch', 'websearch', 'browser', 'custom_mcp_tool', 'external_directory']) {
      assert.equal(action(tool), granted.includes(tool) ? 'allow' : 'deny', `${role}: ${tool}`);
    }
    if (role === 'simplifier' || role === 'runner') {
      assert.equal(action('edit', 'src/index.js'), 'allow');
      assert.equal(action('edit', 'secrets.env'), 'deny');
    }
    for (const tool of ['read', 'glob', 'grep']) assert.equal(action(tool, 'src/index.js'), 'allow');
    assert.equal(action('read', 'secrets.env'), 'deny');
    const plugins = await get('plugin');
    assert.ok(plugins.length);
    assert.ok(plugins.every(plugin => plugin.source.type === 'builtin'), 'Worker loaded external plugins');
    assert.ok(!plugins.some(plugin => plugin.state.status === 'failed'), 'Built-in plugin failed');
    // Policies must hide MCP servers, skills and plugins but keep model providers
    // (OpenCode 2.2.3+ made a bare integration.use deny remove every provider).
    const [providerID, ...rest] = profiles[role].model.split('/');
    let models = [];
    for (let i = 0; i < 30 && !models.length; i++) { models = await get('model'); if (!models.length) await sleep(100); }
    assert.ok(models.some(model => model.providerID === providerID && model.id === rest.join('/')), `${role}: model ${profiles[role].model} is unavailable`);
    assert.deepEqual(await get('mcp'), [], `${role}: MCP servers loaded`);
    await stop();
  }
});

test('installed OpenCode runs an isolated lead: its agent, model and variant, the team MCP server, and nothing else (no model calls)', { skip: !version, timeout: 60_000 }, async t => {
  const { createRun, readRun } = await import('../src/team.mjs');
  const { leadLaunch } = await import('../src/profiles.mjs');
  const { opencodeLeadSession } = await import('../src/cli.mjs');
  const { TOOLS } = await import('../src/tools.mjs');
  const { ROOT } = await import('../src/agents.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-opencode-lead-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project'));
  const runDir = createRun(join(root, 'state'), join(root, 'project'), 'w1', { ...DEFAULTS, orchestrator: { harness: 'opencode', model: 'openai/gpt-6.1-sol', thinking: 'high' } });
  const run = readRun(runDir);
  const lead = leadLaunch(ROOT, runDir, run.config, { HERDR_ENV: '1' });
  // Private data/state dirs keep the test session out of your OpenCode history.
  const env = { ...process.env, ...lead.env, OPENAI_API_KEY: 'sk-test-not-used', XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'xdg-state') };
  const helpers = [];
  t.after(() => { for (const helper of helpers) { helper.stdin.end(); try { process.kill(-helper.pid, 'SIGKILL'); } catch { /* gone */ } } });
  const url = await opencodeLeadSession(lead, run, env, helpers);
  const get = async path => {
    const response = await fetch(`${url}/api/${path}?${new URLSearchParams({ 'location[directory]': run.project })}`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${lead.password}`).toString('base64')}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  };
  const session = await get(`session/${lead.session.id}`);
  assert.equal(session.agent, 'lead');
  assert.deepEqual(session.model, { id: 'gpt-6.1-sol', providerID: 'openai', variant: 'high' });
  let mcp = [];
  for (let i = 0; i < 80 && mcp[0]?.status?.status !== 'connected'; i++) { mcp = await get('mcp'); await sleep(100); }
  assert.deepEqual(mcp, [{ name: 'team', status: { status: 'connected' } }], 'our MCP server, started by OpenCode with the run env');
  const agents = await get('agent');
  assert.deepEqual(agents.filter(agent => !agent.hidden).map(agent => agent.id), ['lead'], 'build/plan cannot be selected');
  const rules = agents.find(agent => agent.id === 'lead').permissions;
  const effect = action => rules.findLast(rule => rule.action === action || rule.action === '*')?.effect;
  for (const tool of TOOLS) assert.equal(effect(tool), 'allow', tool);
  for (const tool of ['read', 'edit', 'shell', 'webfetch', 'skill', 'subagent', 'execute', 'external_directory']) assert.equal(effect(tool), 'deny', tool);
  const models = await get('model');
  assert.ok(models.some(model => model.providerID === 'openai' && model.id === 'gpt-6.1-sol'), 'providers stay available');
});
