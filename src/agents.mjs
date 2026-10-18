import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent definitions live in agents.json; each agent's prompt is prompts/<name>.md.
// Runs snapshot both (see snapshotAgents) so later edits never change a live run.
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HARNESSES = ['claude', 'opencode'];
// readonly: read/search · edit: + file edits · full: + shell commands.
export const TOOL_PRESETS = ['readonly', 'edit', 'full'];
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const VARIANT = /^[a-z0-9][a-z0-9-]{0,19}$/;
const SKILL = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_KEYS = ['description', 'harness', 'model', 'effort', 'tools', 'web', 'skills', 'timeoutMinutes', 'exclusive', 'diff'];

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function only(value, keys, where) {
  if (!plain(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}: unknown setting "${key}"`);
}
function integer(value, min, max, where) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${where} must be a whole number from ${min} to ${max}`);
  return value;
}

export function checkAgent(name, agent) {
  if (!NAME.test(name) || name === 'orchestrator') throw new Error(`Invalid agent name "${name}": use lowercase letters, digits and dashes (not "orchestrator")`);
  only(agent, AGENT_KEYS, name);
  const fail = message => { throw new Error(`${name}: ${message}`); };
  const { description, harness, model = null, effort = null, tools, web = false, skills = [], timeoutMinutes, exclusive = true, diff = false } = agent;
  if (typeof description !== 'string' || !description.trim() || description.length > 300) fail('description is required (at most 300 characters)');
  if (!HARNESSES.includes(harness)) fail(`harness must be one of ${HARNESSES.join(', ')}`);
  if (model !== null && (typeof model !== 'string' || !MODEL.test(model))) fail('model must be a model ID like provider/model');
  if (model === null && harness === 'opencode') fail('OpenCode agents need a model');
  if (effort !== null) {
    if (harness === 'claude' && !CLAUDE_EFFORT.includes(effort)) fail(`effort must be one of ${CLAUDE_EFFORT.join(', ')}`);
    if (harness === 'opencode' && (typeof effort !== 'string' || !VARIANT.test(effort))) fail('effort must be an OpenCode model variant such as medium');
  }
  if (!TOOL_PRESETS.includes(tools)) fail(`tools must be one of ${TOOL_PRESETS.join(', ')}`);
  for (const [key, value] of [['web', web], ['exclusive', exclusive], ['diff', diff]]) if (typeof value !== 'boolean') fail(`${key} must be true or false`);
  if (!Array.isArray(skills) || skills.length > 8 || new Set(skills).size !== skills.length || !skills.every(skill => typeof skill === 'string' && SKILL.test(skill))) {
    fail('skills must be at most 8 distinct skill names');
  }
  if (typeof timeoutMinutes !== 'number' || !(timeoutMinutes > 0) || timeoutMinutes > 240) fail('timeoutMinutes must be more than 0 and at most 240');
  if (tools !== 'readonly' && !exclusive) fail('agents that edit files must hold the checkout (exclusive)');
  return { description: description.trim(), harness, model, effort, tools, web, skills: [...skills], timeoutMinutes, exclusive, diff };
}

export function checkAgents(config) {
  only(config, ['orchestrator', 'limits', 'agents'], 'agents.json');
  only(config.orchestrator, ['model', 'thinking'], 'orchestrator');
  const { model, thinking } = config.orchestrator;
  if (typeof model !== 'string' || !MODEL.test(model)) throw new Error('orchestrator: model must be a model ID like provider/model');
  if (!THINKING.includes(thinking)) throw new Error(`orchestrator: thinking must be one of ${THINKING.join(', ')}`);
  only(config.limits, ['maxParallel', 'maxTasks'], 'limits');
  const limits = {
    maxParallel: integer(config.limits.maxParallel, 1, 8, 'limits.maxParallel'),
    maxTasks: integer(config.limits.maxTasks, 1, 100, 'limits.maxTasks'),
  };
  if (!plain(config.agents)) throw new Error('agents must be an object of named agents');
  const names = Object.keys(config.agents);
  if (!names.length || names.length > 20) throw new Error('Define 1–20 agents');
  const agents = {};
  for (const name of names) agents[name] = checkAgent(name, config.agents[name]);
  return { orchestrator: { model, thinking }, limits, agents };
}

function checkPrompts(prompts, names) {
  if (!plain(prompts)) throw new Error('Prompts must be an object');
  for (const name of ['orchestrator', ...names]) {
    const text = prompts[name];
    if (typeof text !== 'string' || !text.trim() || text.length > 64_000 || text.includes('\0')) throw new Error(`${name}: prompt is required (at most 64000 characters)`);
  }
  return Object.fromEntries(['orchestrator', ...names].map(name => [name, prompts[name]]));
}

const promptPath = (root, name) => join(root, 'prompts', `${name}.md`);
export function loadAgents(root = ROOT) {
  const config = checkAgents(JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8')));
  const names = Object.keys(config.agents);
  const prompts = Object.fromEntries(['orchestrator', ...names].map(name => {
    try { return [name, readFileSync(promptPath(root, name), 'utf8')]; } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Missing prompt file prompts/${name}.md for agent ${name}`);
      throw error;
    }
  }));
  return { config, prompts: checkPrompts(prompts, names) };
}

function replace(path, text) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { flag: 'wx' });
  renameSync(temp, path);
}
// Validate everything first, then write prompts and finally agents.json, so a
// failed save never leaves a config that points at missing prompts.
export function saveAgents(root, config, prompts) {
  const previous = loadAgents(root);
  config = checkAgents(config);
  const names = Object.keys(config.agents);
  prompts = checkPrompts(prompts, names);
  for (const [name, text] of Object.entries(prompts)) if (previous.prompts[name] !== text) replace(promptPath(root, name), text);
  replace(join(root, 'agents.json'), `${JSON.stringify(config, null, 2)}\n`);
  for (const name of Object.keys(previous.config.agents)) {
    if (!names.includes(name)) try { unlinkSync(promptPath(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { config, prompts };
}

export function checkSnapshot(snapshot) {
  only(snapshot, ['orchestrator', 'limits', 'agents', 'prompts'], 'run configuration');
  const config = checkAgents({ orchestrator: snapshot.orchestrator, limits: snapshot.limits, agents: snapshot.agents });
  return { ...config, prompts: checkPrompts(snapshot.prompts, Object.keys(config.agents)) };
}
export function snapshotAgents(root = ROOT) {
  const { config, prompts } = loadAgents(root);
  return { ...config, prompts };
}

const CAPABILITIES = {
  readonly: 'read-only: can read and search files, cannot edit or run commands',
  edit: 'can read and edit files, cannot run commands or tests',
  full: 'can read and edit files and run commands/tests',
};
// The orchestrator's view of its team, appended to its prompt for each run.
export function teamSection(config) {
  const lines = Object.entries(config.agents).map(([name, agent]) => {
    const notes = [CAPABILITIES[agent.tools], agent.web ? 'has web access' : 'no web access',
      agent.exclusive ? 'holds the checkout' : 'can run alongside others', agent.diff ? 'receives the git diff' : null,
      agent.skills.length ? `always follows: ${agent.skills.join(', ')}` : null].filter(Boolean);
    return `- **${name}** — ${agent.description} (${notes.join('; ')}; times out after ${agent.timeoutMinutes} min)`;
  });
  return `## Your specialists\n\nUse these exact role names with team_delegate:\n\n${lines.join('\n')}\n\n` +
    `Only one specialist that holds the checkout may run at a time, across all runs. At most ${config.limits.maxParallel} ` +
    `assignments run in parallel and ${config.limits.maxTasks} in total for this feature. Do not pass skills that need tools a role lacks.\n`;
}
