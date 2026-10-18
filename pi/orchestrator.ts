import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { delegate, listTasks, readRun, waitForTasks } from '../src/team.mjs';
import { openPane, closeWorkerPane } from '../src/herdr.mjs';
import { TOOLS } from '../src/profiles.mjs';
import { listSkills, loadSkill } from '../src/skills.mjs';

export default function (pi: ExtensionAPI) {
  const runDir = process.env.HERDR_ORCH_RUN;
  const run = () => {
    if (!runDir) throw new Error('Missing HERDR_ORCH_RUN; start through personal.orchestrator.start');
    return readRun(runDir);
  };
  const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], details: data });
  pi.registerTool({
    name: 'team_delegate', label: 'Delegate', executionMode: 'sequential',
    description: 'Assign a bounded task to a specialist in its own visible, named Herdr tab running the real agent TUI. Include goal, scope, evidence, and acceptance criteria in brief. Set skills to the agent skills (names from team_skill) the worker must follow. For follow-ups set previousTask to a finished task ID; a fresh worker receives that task/report. Only coder may run checks; coder and simplifier may edit files. Never retry an uncertain launch blindly.',
    parameters: Type.Object({
      role: Type.Union([Type.Literal('coder'), Type.Literal('reviewer'), Type.Literal('researcher'), Type.Literal('security'), Type.Literal('simplifier')]),
      title: Type.String({ minLength: 1, maxLength: 100 }),
      brief: Type.String({ minLength: 1, maxLength: 16000 }),
      previousTask: Type.Optional(Type.String()),
      skills: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
    }),
    async execute(_id, params) {
      run();
      return result(await delegate(runDir, params, openPane));
    },
  });
  pi.registerTool({
    name: 'team_status', label: 'Team status',
    description: 'List assignments and current recorded statuses. Unknown/launch_uncertain is not completion. Use team_wait for full final reports.',
    parameters: Type.Object({}),
    async execute() { const info = run(); return result({ project: info.project, run: info.id, tasks: listTasks(runDir) }); },
  });
  pi.registerTool({
    name: 'team_wait', label: 'Collect reports',
    description: 'Wait up to 60 seconds for recorded worker outcomes. Return full bounded reports. Panes of completed workers are closed once collected; failed/blocked/unknown ones stay open for the user to inspect. If still pending, wait again; do not re-dispatch. Interrupting this tool does not cancel workers.',
    parameters: Type.Object({
      taskIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })),
    }),
    async execute(_id, params, signal) {
      run();
      return result(await waitForTasks(runDir, params.taskIds, params.timeoutMs ?? 30000, signal, closeWorkerPane));
    },
  });
  pi.registerTool({
    name: 'team_skill', label: 'Agent skill',
    description: 'Load an agent skill (engineering workflow instructions). Without name, list available skills with descriptions. Start with using-agent-skills. Skills guide how you coordinate; project work they describe is still delegated.',
    parameters: Type.Object({ name: Type.Optional(Type.String({ maxLength: 64 })) }),
    async execute(_id, params) {
      if (!params.name) return result(listSkills());
      const text = loadSkill(params.name);
      return { content: [{ type: 'text' as const, text }], details: { name: params.name } };
    },
  });
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
