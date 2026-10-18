import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, checkConfig, piLaunch, workerLaunch, TOOLS } from '../src/profiles.mjs';

test('Pi uses the requested model/high reasoning and only coordination tools', () => {
  const { command, args } = piLaunch('/plugin', '/state/run', DEFAULT_CONFIG);
  assert.equal(command, 'pi');
  assert.equal(args[args.indexOf('--model') + 1], 'openai-codex/gpt-6.1-sol');
  assert.equal(args[args.indexOf('--thinking') + 1], 'high');
  assert.equal(args[args.indexOf('--tools') + 1], TOOLS.join(','));
  for (const flag of ['--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-approve']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(args.includes('/plugin/pi/orchestrator.ts'));
});

test('OpenCode roles select exact models and deny shell, writes, nested agents and MCP tools', () => {
  for (const role of ['reviewer', 'researcher']) {
    const launch = workerLaunch(role, DEFAULT_CONFIG, 'brief', 'role instructions', '/private-config');
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
    assert.notEqual(workerLaunch(role, DEFAULT_CONFIG, 'b', 'i', '/c').env.OPENCODE_PASSWORD, launch.env.OPENCODE_PASSWORD);
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

test('Claude runs its interactive TUI with normal permissions, a completion hook and its default model', () => {
  const launch = workerLaunch('coder', DEFAULT_CONFIG, 'Assignment: brief', 'role instructions');
  assert.equal(launch.command, 'claude');
  assert.equal(launch.args.at(-1), 'Assignment: brief');
  for (const flag of ['--print', '-p', '--output-format', '--dangerously-skip-permissions', '--model', '--permission-prompts']) {
    assert.ok(!launch.args.includes(flag), flag);
  }
  assert.ok(launch.args.includes('acceptEdits'));
  assert.ok(launch.args.includes('--strict-mcp-config'));
  assert.equal(launch.args[launch.args.indexOf('--append-system-prompt') + 1], 'role instructions');
  const { hooks } = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]);
  for (const event of ['Stop', 'StopFailure']) assert.match(hooks[event][0].hooks[0].command, /'[^']*\/src\/cli\.mjs' claude-hook$/);
  assert.equal(workerLaunch('coder', { ...DEFAULT_CONFIG, coderModel: 'sonnet' }, 'Assignment: b', 'i').args.at(-2), 'sonnet');
});

test('security runs read-only Claude on Opus 5.5 with medium effort', () => {
  const { command, args } = workerLaunch('security', DEFAULT_CONFIG, 'Assignment: audit', 'role instructions');
  assert.equal(command, 'claude');
  assert.equal(args.at(-1), 'Assignment: audit');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(args.includes('--strict-mcp-config'));
  const { hooks } = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.match(hooks.Stop[0].hooks[0].command, /claude-hook$/);
  assert.ok(!workerLaunch('coder', DEFAULT_CONFIG, 'Assignment: b', 'i').args.includes('--effort'));
});

test('simplifier runs OpenCode gpt-6.1-sol medium and may edit, but not shell or .env files', () => {
  const launch = workerLaunch('simplifier', DEFAULT_CONFIG, 'brief', 'role instructions', '/private-config');
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
    const other = JSON.parse(workerLaunch(role, DEFAULT_CONFIG, 'b', 'i', '/c').env.OPENCODE_CONFIG_CONTENT).agents[`personal-${role}`];
    assert.ok(!other.permissions.some(rule => rule.action === 'edit' && rule.effect === 'allow'), role);
  }
});

test('configuration and role validation fail closed', () => {
  assert.throws(() => checkConfig({ maxParallel: 0 }), /maxParallel/);
  assert.throws(() => checkConfig({ unknown: true }), /Unknown/);
  assert.throws(() => checkConfig({ toString: true }), /Unknown/);
  assert.throws(() => checkConfig({ reviewerModel: '--bad' }), /reviewerModel/);
  assert.throws(() => checkConfig({ securityModel: null }), /securityModel/);
  assert.equal(checkConfig({ simplifierModel: 'openai/gpt-6.1-sol#high' }).simplifierModel, 'openai/gpt-6.1-sol#high');
  assert.throws(() => workerLaunch('shell', DEFAULT_CONFIG, '', ''), /Unknown role/);
  assert.throws(() => workerLaunch('researcher', DEFAULT_CONFIG, 'brief', 'instructions'), /config directory/);
});
