import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.mjs';

// The lead's TUI, restricted to the team tools: Pi loads them as an extension,
// Claude Code and OpenCode through the stdio MCP server in src/mcp.mjs.
export function leadLaunch(root, runDir, config, env = process.env) {
  const { harness, model, thinking } = config.orchestrator;
  if (harness === 'pi') return piLaunch(root, runDir, config);
  // Pass the coordinator pane's Herdr env explicitly; MCP clients do not
  // promise to forward their own environment to servers.
  const server = { command: process.execPath, args: [join(root, 'src/cli.mjs'), 'mcp'],
    env: { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('HERDR_'))), HERDR_ORCH_RUN: runDir } };
  if (harness === 'claude') {
    return {
      command: 'claude',
      // Plain MCP handshake for our minimal server (see the 2026-07-28 negotiation in Claude Code's changelog).
      // Room for team_wait's up to 8 full reports (Claude's default cap is 25k tokens).
      env: { MCP_PROTOCOL_NEGOTIATION: 'legacy', MAX_MCP_OUTPUT_TOKENS: '100000' },
      args: [
        // No built-in tools; the team tools are pre-approved and anything else is denied, never prompted.
        '--tools', '', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__team__*',
        '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { team: { type: 'stdio', ...server } } }),
        '--system-prompt-file', join(runDir, 'orchestrator.md'), '--name', 'Feature orchestrator',
        ...(model ? ['--model', model] : []),
        ...(thinking ? ['--effort', thinking] : []),
      ],
    };
  }
  if (harness === 'opencode') {
    // Like the workers: a private server and config, a session created with the
    // lead agent/model/variant (the TUI has no flags for those), and the TUI
    // attached to it. Only the team tools are allowed; nothing ever prompts.
    const rules = [{ action: '*', resource: '*', effect: 'deny' }, ...TOOLS.map(action => ({ action, resource: '*', effect: 'allow' }))];
    const password = randomBytes(24).toString('base64url');
    const id = `ses_lead${randomBytes(12).toString('hex')}`;
    const slash = model.indexOf('/');
    return {
      command: 'opencode', password,
      serve: ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0', '--print-logs', '--log-level', 'error'],
      tui: url => ['--server', url, '--session', id, '--log-level', 'error'],
      session: { id, title: 'Feature orchestrator', agent: 'lead',
        model: { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(thinking ? { variant: thinking } : {}) } },
      configDir: join(runDir, 'opencode-config'),
      env: {
        OPENCODE_LOG_LEVEL: 'error', OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_CONFIG_DIR: join(runDir, 'opencode-config'), OPENCODE_CONFIG: '',
        OPENCODE_CONFIG_PROJECT_DISABLE: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          share: 'disabled', update: 'disable', snapshots: false, default_agent: 'lead', permissions: rules,
          // Unlike workers the lead needs MCP: only skills and plugins are off.
          policies: OPENCODE_POLICIES.filter(policy => policy.action !== 'mcp.use'),
          // OpenCode names MCP tools <server>_<tool>; `mcp opencode` serves bare
          // names so the lead sees team_delegate etc. Code Mode would hide them.
          mcp: { servers: { team: { type: 'local', command: [server.command, ...server.args, 'opencode'], environment: server.env, codemode: false } } },
          agents: {
            lead: { mode: 'primary', description: 'Feature orchestrator', system: readFileSync(join(runDir, 'orchestrator.md'), 'utf8'),
              model: thinking ? `${model}#${thinking}` : model, permissions: rules },
            build: { disabled: true }, plan: { disabled: true }, general: { disabled: true }, explore: { disabled: true },
          },
        }),
      },
    };
  }
  throw new Error(`Unsupported lead harness: ${harness}`);
}

export function piLaunch(root, runDir, config) {
  return {
    command: 'pi', env: {},
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
const CLAUDE_MODES = { readonly: 'default', edit: 'acceptEdits', full: 'auto' };
// No MCP servers, skills or plugins. Since OpenCode 2.2.3 these have their own
// actions; a bare `integration.use` deny no longer covers them and instead
// removes every model provider.
const OPENCODE_POLICIES = ['mcp.use', 'skill.use', 'plugin.use'].map(action => ({ action, resource: '*', effect: 'deny' }));
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
        // Auto mode lets agents that run commands work unattended: a classifier
        // approves routine actions and blocks risky ones instead of prompting.
        '--permission-mode', CLAUDE_MODES[agent.tools],
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
  // V2 schema: https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/config.ts
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
      OPENCODE_DISABLE_AUTOUPDATE: '1', // The TUI's updater ignores `update` in this config.
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG: '',
      OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        share: 'disabled', update: 'disable', snapshots: false, permissions,
        policies: OPENCODE_POLICIES,
        agents: { [`personal-${name}`]: { mode: 'primary', description: `${name} specialist`, system: instructions, permissions } },
      }),
    },
  };
}
