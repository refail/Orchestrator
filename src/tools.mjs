import { delegate, listTasks, readRun, waitForTasks, markWaiting, MAX_WAIT_MS } from './team.mjs';
import { openPane, closeWorkerPane, agentStates } from './herdr.mjs';
import { listSkills, loadSkill } from './skills.mjs';

// The lead's only tools. The Pi extension registers them directly; Claude Code
// and OpenCode leads reach the same definitions through src/mcp.mjs.
export const TOOLS = ['team_delegate', 'team_status', 'team_wait', 'team_skill'];

export function teamTools(runDir, { open = openPane, close = closeWorkerPane, states = agentStates } = {}) {
  const inspect = async () => { try { return await states(); } catch { return undefined; } };
  const run = () => {
    if (!runDir) throw new Error('Missing HERDR_ORCH_RUN; start through personal.orchestrator.start');
    return readRun(runDir);
  };
  // Role names come from this run's agent snapshot (agents.json at start).
  const roles = runDir ? Object.keys(run().config?.agents ?? {}) : [];
  return [{
    name: 'team_delegate', label: 'Delegate', sequential: true,
    description: 'Assign a bounded task to a specialist in its own visible, named Herdr tab running the real agent TUI. Include goal, scope, evidence, and acceptance criteria in brief. Set skills to the agent skills (names from team_skill) the worker must follow. For follow-ups set previousTask to a finished task ID; a fresh worker receives that task/report. Each role\'s capabilities are listed under "Your specialists" in your instructions. Never retry an uncertain launch blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        role: roles.length ? { type: 'string', enum: roles } : { type: 'string' },
        title: { type: 'string', minLength: 1, maxLength: 100 },
        brief: { type: 'string', minLength: 1, maxLength: 16000 },
        previousTask: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      },
      required: ['role', 'title', 'brief'],
    },
    execute: async params => { run(); return delegate(runDir, params, open); },
  }, {
    name: 'team_status', label: 'Team status',
    description: 'List assignments and current recorded statuses. Unknown/launch_uncertain is not completion. waiting: true means the worker\'s tab needs the user (a prompt or question). Use team_wait for full final reports.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => { const info = run(); return { project: info.project, run: info.id, tasks: markWaiting(listTasks(runDir), await inspect()) }; },
  }, {
    name: 'team_wait', label: 'Collect reports',
    description: 'Wait for recorded worker outcomes (default 10 minutes, at most 15). Returns as soon as any listed task that was still running finishes, needs attention, or starts waiting for the user in its tab (waiting: true; tell the user), with full bounded reports, so react to each result and wait again for the rest. Panes of completed workers are closed once collected; failed/blocked/unknown ones stay open for the user to inspect. If still pending, wait again; do not re-dispatch. Interrupting this tool does not cancel workers.',
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_WAIT_MS },
      },
      required: ['taskIds'],
    },
    execute: async (params, signal) => { run(); return waitForTasks(runDir, params.taskIds, params.timeoutMs ?? 10 * 60_000, signal, close, inspect); },
  }, {
    name: 'team_skill', label: 'Agent skill',
    description: 'Load an agent skill (engineering workflow instructions). Without name, list available skills with descriptions. Start with using-agent-skills. Skills guide how you coordinate; project work they describe is still delegated.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 64 } } },
    // Skill text is returned as-is; everything else is JSON.
    execute: async params => (params.name ? loadSkill(params.name) : listSkills()),
  }];
}

export const toolText = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
