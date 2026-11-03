import test from 'node:test';
import assert from 'node:assert/strict';
import { piLaunch, leadLaunch, workerLaunch } from '../src/profiles.mjs';
import { TOOLS } from '../src/tools.mjs';
import { DEFAULTS } from './fixtures/agents.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const A = DEFAULTS.agents;

test('Pi uses the requested model/high reasoning and only coordination tools', () => {
  const { command, args } = piLaunch('/plugin', '/state/run', DEFAULTS);
  assert.equal(command, 'pi');
  assert.equal(args[args.indexOf('--model') + 1], 'openai-codex/gpt-6.1-sol');
  assert.equal(args[args.indexOf('--thinking') + 1], 'high');
  assert.equal(args[args.indexOf('--tools') + 1], TOOLS.join(','));
  for (const flag of ['--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-approve']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(args.includes('/plugin/pi/orchestrator.ts'));
  assert.equal(args[args.indexOf('--system-prompt') + 1], '/state/run/orchestrator.md', 'the run snapshot, not the editable file');
  const low = piLaunch('/plugin', '/state/run', { ...DEFAULTS, orchestrator: { model: 'anthropic/claude-opus-5-5', thinking: 'low' } }).args;
  assert.equal(low[low.indexOf('--model') + 1], 'anthropic/claude-opus-5-5');
  assert.equal(low[low.indexOf('--thinking') + 1], 'low');
});

test('a Claude Code lead gets only the pre-approved team MCP tools, the run prompt and the Herdr env', () => {
  const config = { ...DEFAULTS, orchestrator: { harness: 'claude', model: null, thinking: 'high' } };
  const lead = leadLaunch('/plugin', '/state/run', config, { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/sock', OPENAI_API_KEY: 'secret' });
  const { command, args, env } = lead;
  assert.equal(command, 'claude');
  assert.equal(args[args.indexOf('--tools') + 1], '', 'no built-in tools');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk', 'unlisted tools are denied, never prompted');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__team__*');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--system-prompt-file') + 1], '/state/run/orchestrator.md', 'the run snapshot, not the editable file');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.ok(!args.includes('--model'), 'empty model uses the Claude default');
  for (const flag of ['--dangerously-skip-permissions', 'bypassPermissions', 'auto', '--append-system-prompt']) assert.ok(!args.includes(flag), flag);
  const { team } = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers;
  assert.equal(team.type, 'stdio');
  assert.deepEqual(team.args, ['/plugin/src/cli.mjs', 'mcp']);
  assert.deepEqual(team.env, { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/sock', HERDR_ORCH_RUN: '/state/run' }, 'only Herdr variables are forwarded');
  assert.equal(env.MCP_PROTOCOL_NEGOTIATION, 'legacy');
  const model = leadLaunch('/plugin', '/state/run', { ...config, orchestrator: { harness: 'claude', model: 'claude-opus-5-5', thinking: null } }, {}).args;
  assert.equal(model[model.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.ok(!model.includes('--effort'));
  assert.equal(leadLaunch('/plugin', '/state/run', { ...DEFAULTS, orchestrator: { harness: 'pi', ...DEFAULTS.orchestrator } }).command, 'pi');
});

test('an OpenCode lead allows only the team MCP tools, with its own agent, model and variant', t => {
  const runDir = mkdtempSync(join(tmpdir(), 'herdr-lead-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  writeFileSync(join(runDir, 'orchestrator.md'), 'Coordinate the team.');
  const config = { ...DEFAULTS, orchestrator: { harness: 'opencode', model: 'openai/gpt-6.1-sol', thinking: 'high' } };
  const lead = leadLaunch('/plugin', runDir, config, { HERDR_SOCKET_PATH: '/sock', HOME: '/home/me' });
  assert.equal(lead.command, 'opencode');
  assert.deepEqual(lead.serve.slice(0, 2), ['serve', '--stdio']);
  assert.equal(lead.serve[lead.serve.indexOf('--hostname') + 1], '127.0.0.1');
  assert.deepEqual(lead.tui('http://127.0.0.1:1').slice(0, 4), ['--server', 'http://127.0.0.1:1', '--session', lead.session.id]);
  assert.match(lead.session.id, /^ses_lead[0-9a-f]{24}$/);
  assert.deepEqual(lead.session.model, { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' });
  assert.equal(lead.session.agent, 'lead');
  assert.equal(lead.env.OPENCODE_PASSWORD, lead.password);
  assert.equal(lead.env.OPENCODE_CONFIG_DIR, join(runDir, 'opencode-config'));
  assert.equal(lead.env.OPENCODE_CONFIG_PROJECT_DISABLE, 'true');
  const content = JSON.parse(lead.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(content.default_agent, 'lead');
  assert.equal(content.agents.lead.system, 'Coordinate the team.', 'the run snapshot prompt');
  assert.equal(content.agents.lead.model, 'openai/gpt-6.1-sol#high');
  for (const name of ['build', 'plan', 'general', 'explore']) assert.equal(content.agents[name].disabled, true, name);
  const rules = content.agents.lead.permissions;
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
  assert.deepEqual(rules.filter(rule => rule.effect === 'allow').map(rule => rule.action), TOOLS);
  assert.deepEqual(content.permissions, rules);
  assert.ok(!content.policies.some(policy => policy.action === 'mcp.use'), 'the lead needs its MCP server');
  assert.ok(content.policies.some(policy => policy.action === 'skill.use' && policy.effect === 'deny'));
  const { team } = content.mcp.servers;
  assert.deepEqual(team.command, [process.execPath, '/plugin/src/cli.mjs', 'mcp', 'opencode']);
  assert.deepEqual(team.environment, { HERDR_SOCKET_PATH: '/sock', HERDR_ORCH_RUN: runDir });
  assert.equal(team.codemode, false);
  const plain = leadLaunch('/plugin', runDir, { ...config, orchestrator: { harness: 'opencode', model: 'openai/gpt-6.1-sol', thinking: null } }, {});
  assert.equal(plain.session.model.variant, undefined);
  assert.equal(JSON.parse(plain.env.OPENCODE_CONFIG_CONTENT).agents.lead.model, 'openai/gpt-6.1-sol');
});

test('OpenCode workers keep model providers but load no MCP servers, skills or plugins', () => {
  const { policies } = JSON.parse(workerLaunch('reviewer', A.reviewer, 'b', 'i', '/c').env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(policies.map(policy => [policy.action, policy.effect]), [['mcp.use', 'deny'], ['skill.use', 'deny'], ['plugin.use', 'deny']]);
  assert.ok(!policies.some(policy => policy.action === 'integration.use'), 'since OpenCode 2.2.3 this removes every provider');
});

test('OpenCode roles select exact models and deny shell, writes, nested agents and MCP tools', () => {
  for (const role of ['reviewer', 'researcher']) {
    const launch = workerLaunch(role, A[role], 'brief', 'role instructions', '/private-config');
    assert.equal(launch.command, 'opencode');
    assert.equal(launch.input, 'brief');
    // Private localhost server, a headless client for the report, and a TUI on the same session.
    assert.deepEqual(launch.serve.slice(0, 2), ['serve', '--stdio']);
    assert.equal(launch.serve[launch.serve.indexOf('--hostname') + 1], '127.0.0.1');
    assert.ok(launch.serve.includes('--print-logs'));
    const run = launch.run('http://127.0.0.1:1234'), tui = launch.tui('http://127.0.0.1:1234');
    assert.equal(run[0], 'run');
    assert.equal(run[run.indexOf('--server') + 1], 'http://127.0.0.1:1234');
    assert.equal(run[run.indexOf('--format') + 1], 'json');
    assert.equal(run[run.indexOf('--agent') + 1], `personal-${role}`);
    assert.equal(run[run.indexOf('--model') + 1], `openai/gpt-${role === 'reviewer' ? '6.1' : '5.6'}-sol`);
    assert.match(run[run.indexOf('--session') + 1], /^ses_/);
    assert.equal(tui[tui.indexOf('--session') + 1], run[run.indexOf('--session') + 1]);
    assert.equal(tui[tui.indexOf('--server') + 1], 'http://127.0.0.1:1234');
    for (const args of [launch.serve, run, tui]) {
      for (const flag of ['--pure', '--auto', '--standalone']) assert.ok(!args.includes(flag), flag);
      assert.equal(args[args.indexOf('--log-level') + 1], 'error');
    }
    assert.ok(launch.env.OPENCODE_PASSWORD.length >= 32);
    assert.equal(launch.env.OPENCODE_SERVER_PASSWORD, launch.env.OPENCODE_PASSWORD);
    assert.notEqual(workerLaunch(role, A[role], 'b', 'i', '/c').env.OPENCODE_PASSWORD, launch.env.OPENCODE_PASSWORD);
    assert.equal(launch.env.OPENCODE_CONFIG_DIR, '/private-config');
    assert.equal(launch.env.OPENCODE_CONFIG_PROJECT_DISABLE, 'true');
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    const agent = config.agents[`personal-${role}`];
    assert.equal(agent.system, 'role instructions');
    const rules = agent.permissions;
    assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
    assert.ok(rules.some(rule => rule.action === 'grep' && rule.effect === 'allow'));
    assert.ok(rules.some(rule => rule.action === 'read' && rule.resource === '*.env' && rule.effect === 'deny'));
    assert.equal(config.share, 'disabled');
    assert.equal(config.snapshots, false);
    assert.equal(config.update, 'disable');
  }
});

test('Claude runs its interactive TUI in auto mode for full tools, with a completion hook and its default model', () => {
  const launch = workerLaunch('coder', A.coder, 'Assignment: brief', 'role instructions');
  assert.equal(launch.command, 'claude');
  assert.equal(launch.args.at(-1), 'Assignment: brief');
  for (const flag of ['--print', '-p', '--output-format', '--dangerously-skip-permissions', '--model', '--permission-prompts']) {
    assert.ok(!launch.args.includes(flag), flag);
  }
  assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(launch.args.includes('--strict-mcp-config'));
  assert.equal(launch.args[launch.args.indexOf('--append-system-prompt') + 1], 'role instructions');
  const { hooks } = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]);
  for (const event of ['Stop', 'StopFailure']) assert.match(hooks[event][0].hooks[0].command, /'[^']*\/src\/cli\.mjs' claude-hook$/);
  assert.equal(launch.args[launch.args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep,Bash');
  assert.equal(workerLaunch('coder', { ...A.coder, model: 'sonnet' }, 'Assignment: b', 'i').args.at(-2), 'sonnet');
});

test('security runs read-only Claude on Opus 5.5 with medium effort', () => {
  const { command, args } = workerLaunch('security', A.security, 'Assignment: audit', 'role instructions');
  assert.equal(command, 'claude');
  assert.equal(args.at(-1), 'Assignment: audit');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(args.includes('--strict-mcp-config'));
  const { hooks } = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.match(hooks.Stop[0].hooks[0].command, /claude-hook$/);
  assert.ok(!workerLaunch('coder', A.coder, 'Assignment: b', 'i').args.includes('--effort'));
});

test('simplifier runs OpenCode gpt-6.1-sol medium and may edit, but not shell or .env files', () => {
  const launch = workerLaunch('simplifier', A.simplifier, 'brief', 'role instructions', '/private-config');
  assert.equal(launch.command, 'opencode');
  const run = launch.run('http://127.0.0.1:1234');
  assert.equal(run[run.indexOf('--model') + 1], 'openai/gpt-6.1-sol#medium');
  assert.equal(run[run.indexOf('--agent') + 1], 'personal-simplifier');
  const rules = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).agents['personal-simplifier'].permissions;
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
  assert.ok(rules.some(rule => rule.action === 'edit' && rule.resource === '*' && rule.effect === 'allow'));
  assert.ok(rules.some(rule => rule.action === 'edit' && rule.resource === '*.env' && rule.effect === 'deny'));
  assert.ok(!rules.some(rule => rule.action === 'shell' || (rule.action === '*' && rule.effect === 'allow')));
  for (const role of ['reviewer', 'researcher']) {
    const other = JSON.parse(workerLaunch(role, A[role], 'b', 'i', '/c').env.OPENCODE_CONFIG_CONTENT).agents[`personal-${role}`];
    assert.ok(!other.permissions.some(rule => rule.action === 'edit' && rule.effect === 'allow'), role);
  }
});

test('tool presets and web access map to each harness', () => {
  const claudeTools = agent => { const { args } = workerLaunch('x', agent, 'Assignment: b', 'i'); return args[args.indexOf('--tools') + 1]; };
  assert.equal(claudeTools({ ...A.security, tools: 'edit' }), 'Read,Edit,Write,Glob,Grep');
  assert.equal(claudeTools({ ...A.security, web: true }), 'Read,Glob,Grep,WebFetch,WebSearch');
  assert.equal(workerLaunch('x', { ...A.security, tools: 'edit' }, 'Assignment: b', 'i').args[1], 'acceptEdits');
  const allowed = agent => JSON.parse(workerLaunch('runner', agent, 'b', 'i', '/c').env.OPENCODE_CONFIG_CONTENT)
    .agents['personal-runner'].permissions.filter(rule => rule.effect === 'allow' && rule.resource === '*').map(rule => rule.action);
  assert.deepEqual(allowed({ ...A.reviewer, tools: 'full', web: true }), ['read', 'glob', 'grep', 'edit', 'shell', 'webfetch', 'websearch']);
  assert.deepEqual(allowed(A.reviewer), ['read', 'glob', 'grep']);
});

test('unknown roles and missing OpenCode config directories fail closed', () => {
  assert.throws(() => workerLaunch('shell', undefined, '', ''), /Unknown role/);
  assert.throws(() => workerLaunch('researcher', A.researcher, 'brief', 'instructions'), /config directory/);
});
