import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../../src/agents.mjs';

// Fixed agent snapshot for tests, independent of the editable agents.json.
const agent = (harness, model, effort, tools, extra = {}) => ({
  description: `${tools} test agent`, harness, model, effort, tools, web: false, skills: [], timeoutMinutes: 15, exclusive: true, diff: false, ...extra,
});
export const DEFAULTS = Object.freeze({
  orchestrator: { model: 'openai-codex/gpt-6.1-sol', thinking: 'high' },
  limits: { maxParallel: 3, maxTasks: 30 },
  agents: {
    coder: agent('claude', null, null, 'full', { timeoutMinutes: 30 }),
    reviewer: agent('opencode', 'openai/gpt-6.1-sol', null, 'readonly', { diff: true }),
    researcher: agent('opencode', 'openai/gpt-5.6-sol', null, 'readonly', { exclusive: false }),
    security: agent('claude', 'claude-opus-5-5', 'medium', 'readonly', { skills: ['security-and-hardening'], diff: true }),
    simplifier: agent('opencode', 'openai/gpt-6.1-sol', 'medium', 'edit', { diff: true }),
  },
  prompts: { orchestrator: 'Coordinate.', coder: 'Code.', reviewer: 'Review.', researcher: 'Research.', security: 'Audit.', simplifier: 'Simplify.' },
});
// A copy with limit and per-agent overrides, e.g. config({ limits: { maxParallel: 1 } }).
export function config({ limits = {}, agents = {}, prompts = {} } = {}) {
  const value = structuredClone(DEFAULTS);
  Object.assign(value.limits, limits);
  Object.assign(value.prompts, prompts);
  for (const [name, patch] of Object.entries(agents)) value.agents[name] = patch === null ? undefined : { ...value.agents[name], ...patch };
  for (const name of Object.keys(value.agents)) if (!value.agents[name]) { delete value.agents[name]; delete value.prompts[name]; }
  return value;
}
// A disposable copy of the plugin's agents.json and prompts.
export function copyRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'herdr-agents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, 'agents.json'), join(root, 'agents.json'));
  cpSync(join(ROOT, 'prompts'), join(root, 'prompts'), { recursive: true });
  return root;
}
