import { randomBytes } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = ['team_delegate', 'team_status', 'team_wait', 'team_skill'];

export function piLaunch(root, runDir, config) {
  return {
    command: 'pi',
    args: [
      '--model', config.orchestrator.model, '--thinking', config.orchestrator.thinking,
      '--no-extensions', '--extension', join(root, 'pi/orchestrator.ts'),
      '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-approve', '--tools', TOOLS.join(','),
      // Snapshotted by createRun: the edited prompt plus this run's team.
      '--system-prompt', join(runDir, 'orchestrator.md'),
      '--session-dir', join(runDir, 'sessions'), '--name', 'Feature orchestrator',
    ],
  };
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const CLAUDE_TOOLS = { readonly: ['Read', 'Glob', 'Grep'], edit: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], full: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] };
// OpenCode v2 permission actions; `edit` covers edit/write/patch.
const OPENCODE_TOOLS = { readonly: ['read', 'glob', 'grep'], edit: ['read', 'glob', 'grep', 'edit'], full: ['read', 'glob', 'grep', 'edit', 'shell'] };

// Workers run their real TUI in the visible pane. Completion still comes from a
// machine-readable channel: a Claude Stop hook, or a headless OpenCode client
// attached to the same private server session that the TUI displays.
export function workerLaunch(name, agent, brief, instructions, configDir, title = 'Assignment') {
  if (!agent) throw new Error(`Unknown role: ${name}`);
  if (agent.harness === 'claude') {
    const tools = [...CLAUDE_TOOLS[agent.tools], ...(agent.web ? ['WebFetch', 'WebSearch'] : [])];
    const hook = { type: 'command', command: `${quote(process.execPath)} ${quote(join(ROOT, 'src/cli.mjs'))} claude-hook` };
    return {
      command: 'claude', env: {},
      args: [
        '--permission-mode', agent.tools === 'readonly' ? 'default' : 'acceptEdits',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--tools', tools.join(','),
        '--append-system-prompt', instructions,
        '--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }], StopFailure: [{ hooks: [hook] }] } }),
        ...(agent.model ? ['--model', agent.model] : []),
        ...(agent.effort ? ['--effort', agent.effort] : []),
        brief, // Always starts with "Assignment:", never parsed as a flag.
      ],
    };
  }
  if (!isAbsolute(configDir || '')) throw new Error('OpenCode requires a private config directory');
  // V2 schema: https://github.com/anomalyco/opencode/blob/v2.0.30/packages/schema/src/config.ts
  // Deny by default, including renamed shell/subagent tools and external paths.
  const allowed = [...OPENCODE_TOOLS[agent.tools], ...(agent.web ? ['webfetch', 'websearch'] : [])];
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
      '--model', agent.effort ? `${agent.model}#${agent.effort}` : agent.model, '--agent', `personal-${name}`],
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
        agents: { [`personal-${name}`]: { mode: 'primary', description: `${name} specialist`, system: instructions, permissions } },
      }),
    },
  };
}
