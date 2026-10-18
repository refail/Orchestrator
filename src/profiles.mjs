import { randomBytes } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = ['team_delegate', 'team_status', 'team_wait', 'team_skill'];
export const ROLES = ['coder', 'reviewer', 'researcher', 'security', 'simplifier'];
// Skills a role always follows, in addition to those the orchestrator picks.
export const ROLE_SKILLS = Object.freeze({ security: ['security-and-hardening'] });
// Roles that run Claude Code; the others run OpenCode.
export const CLAUDE_ROLES = Object.freeze({
  coder: { tools: 'Read,Edit,Write,Glob,Grep,Bash', mode: 'acceptEdits' },
  security: { tools: 'Read,Glob,Grep', mode: 'default', effort: 'medium' },
});
export const DEFAULT_CONFIG = Object.freeze({
  orchestratorModel: 'openai-codex/gpt-6.1-sol',
  coderModel: null,
  reviewerModel: 'openai/gpt-6.1-sol',
  researcherModel: 'openai/gpt-5.6-sol',
  securityModel: 'claude-opus-5-5',
  simplifierModel: 'openai/gpt-6.1-sol#medium', // OpenCode provider/model#variant
  maxParallel: 3,
  maxTasks: 30,
  taskTimeoutMs: 900_000,
});

export function checkConfig(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Config must be an object');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown configuration key: ${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };
  for (const key of ['orchestratorModel', 'coderModel', 'reviewerModel', 'researcherModel', 'securityModel', 'simplifierModel']) {
    if (key === 'coderModel' && config[key] === null) continue;
    if (typeof config[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,199}$/.test(config[key])) {
      throw new Error(`Invalid ${key}`);
    }
  }
  for (const [key, min, max] of [['maxParallel', 1, 8], ['maxTasks', 1, 100], ['taskTimeoutMs', 1000, 3_600_000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}: expected ${min}–${max}`);
  }
  return config;
}

export function piLaunch(root, runDir, config) {
  return {
    command: 'pi',
    args: [
      '--model', config.orchestratorModel, '--thinking', 'high',
      '--no-extensions', '--extension', join(root, 'pi/orchestrator.ts'),
      '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-approve', '--tools', TOOLS.join(','),
      '--system-prompt', join(root, 'prompts/orchestrator.md'),
      '--session-dir', join(runDir, 'sessions'), '--name', 'Feature orchestrator',
    ],
  };
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Workers run their real TUI in the visible pane. Completion still comes from a
// machine-readable channel: a Claude Stop hook, or a headless OpenCode client
// attached to the same private server session that the TUI displays.
export function workerLaunch(role, config, brief, instructions, configDir, title = 'Assignment') {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  if (Object.hasOwn(CLAUDE_ROLES, role)) {
    const { tools, mode, effort } = CLAUDE_ROLES[role];
    const model = config[`${role}Model`];
    const hook = { type: 'command', command: `${quote(process.execPath)} ${quote(join(ROOT, 'src/cli.mjs'))} claude-hook` };
    return {
      command: 'claude', env: {},
      args: [
        '--permission-mode', mode,
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--tools', tools,
        '--append-system-prompt', instructions,
        '--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }], StopFailure: [{ hooks: [hook] }] } }),
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        brief, // Always starts with "Assignment:", never parsed as a flag.
      ],
    };
  }
  if (!isAbsolute(configDir || '')) throw new Error('OpenCode requires a private config directory');
  // V2 schema: https://github.com/anomalyco/opencode/blob/v2.0.30/packages/schema/src/config.ts
  // Deny by default, including renamed shell/subagent tools and external paths.
  // The simplifier may also edit (v2 `edit` covers edit/write/patch), never run shell.
  const allowed = role === 'simplifier' ? ['read', 'glob', 'grep', 'edit'] : ['read', 'glob', 'grep'];
  const permissions = [
    { action: '*', resource: '*', effect: 'deny' },
    ...allowed.map(action => ({ action, resource: '*', effect: 'allow' })),
    ...['read', 'edit'].flatMap(action => ['*.env', '*.env.*'].map(resource => ({ action, resource, effect: 'deny' }))),
  ];
  const password = randomBytes(24).toString('base64url');
  const session = `ses_orch${randomBytes(12).toString('hex')}`;
  const logs = ['--log-level', 'error'];
  return {
    command: 'opencode',
    input: brief,
    // Private server bound to localhost; --stdio stops it when our runner exits.
    serve: ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0', '--print-logs', ...logs],
    run: url => ['run', '--server', url, '--session', session, '--title', title, '--format', 'json', ...logs,
      '--model', config[`${role}Model`], '--agent', `personal-${role}`],
    tui: url => ['--server', url, '--session', session, ...logs],
    env: {
      // A private server/config prevents ambient plugins or a shared service from
      // ignoring our profile. Built-in credential adapters remain available.
      OPENCODE_LOG_LEVEL: 'error',
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG: '',
      OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        share: 'disabled', update: 'disable', snapshots: false, permissions,
        policies: [{ action: 'integration.use', resource: '*', effect: 'deny' }],
        agents: { [`personal-${role}`]: { mode: 'primary', description: role === 'simplifier' ? 'Code simplifier' : `Read-only ${role}`, system: instructions, permissions } },
      }),
    },
  };
}
