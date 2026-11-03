import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { listTasks, readRun } from '../src/team.mjs';
import { teamTools, toolText, TOOLS } from '../src/tools.mjs';

export default function (pi: ExtensionAPI) {
  const runDir = process.env.HERDR_ORCH_RUN;
  const run = () => {
    if (!runDir) throw new Error('Missing HERDR_ORCH_RUN; start through personal.orchestrator.start');
    return readRun(runDir);
  };
  // Shared with the MCP server that Claude Code and OpenCode leads use. Pi
  // validates arguments against plain JSON Schema, so no TypeBox is needed.
  for (const tool of teamTools(runDir)) {
    pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.inputSchema,
      ...(tool.sequential ? { executionMode: 'sequential' as const } : {}),
      async execute(_id, params, signal) {
        const value = await tool.execute(params, signal);
        return { content: [{ type: 'text' as const, text: toolText(value) }], details: typeof value === 'string' ? { name: params.name } : value };
      },
    });
  }
  const restrict = () => { pi.setActiveTools(TOOLS); };
  pi.on('session_start', () => { run(); restrict(); });
  pi.on('before_agent_start', restrict);
  pi.on('tool_call', event => {
    if (!TOOLS.includes(event.toolName)) return { block: true, reason: 'Coordination-only session. Delegate project work to a specialist.' };
  });
  pi.on('user_bash', () => ({ result: {
    output: 'Shell execution is disabled in the orchestrator. Delegate to a specialist.',
    exitCode: 1, cancelled: false, truncated: false,
  } }));
  pi.registerCommand('team', {
    description: 'Show this feature run, tasks, and active coordination tools without a model call',
    handler: async () => {
      const info = run(); restrict();
      pi.sendMessage({ customType: 'orchestrator-status', content: JSON.stringify({ project: info.project, run: info.id, tools: pi.getActiveTools(), tasks: listTasks(runDir) }, null, 2), display: true }, { triggerTurn: false });
    },
  });
}
