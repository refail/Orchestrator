import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgents, saveAgents, checkAgents, teamSection } from '../src/agents.mjs';
import { skillDescription } from '../src/skills.mjs';
import { DEFAULTS, copyRoot } from './fixtures/agents.mjs';
const settings = ({ prompts, ...config }) => config;

test('the shipped agents.json is valid and every agent has a prompt', () => {
  const { config, prompts } = loadAgents();
  assert.ok(prompts.orchestrator.trim());
  for (const name of Object.keys(config.agents)) assert.ok(prompts[name].trim(), name);
});

test('saving adds, renames and deletes agents together with their prompt files', t => {
  const root = copyRoot(t);
  const { config, prompts } = loadAgents(root);
  const { simplifier, ...rest } = config.agents;
  const next = { ...config, agents: { ...rest, tidy: simplifier, docs: { ...config.agents.researcher, description: 'Docs' } } };
  const { simplifier: _, ...kept } = prompts;
  saveAgents(root, next, { ...kept, tidy: 'Tidy up.', docs: 'Write docs.' });
  const saved = loadAgents(root);
  assert.deepEqual(Object.keys(saved.config.agents), [...Object.keys(rest), 'tidy', 'docs']);
  assert.equal(readFileSync(join(root, 'prompts/docs.md'), 'utf8'), 'Write docs.');
  assert.ok(!existsSync(join(root, 'prompts/simplifier.md')));
  assert.ok(!readdirSync(join(root, 'prompts')).some(name => name.endsWith('.tmp')));
});

test('a rejected save changes nothing on disk', t => {
  const root = copyRoot(t);
  const before = readFileSync(join(root, 'agents.json'), 'utf8');
  const { config, prompts } = loadAgents(root);
  const bad = { ...config, agents: { ...config.agents, 'Bad Name': config.agents.coder } };
  assert.throws(() => saveAgents(root, bad, { ...prompts, 'Bad Name': 'x' }), /Invalid agent name/);
  assert.throws(() => saveAgents(root, config, { ...prompts, coder: '  ' }), /coder: prompt is required/);
  assert.equal(readFileSync(join(root, 'agents.json'), 'utf8'), before);
});

test('agent validation fails closed with readable messages', () => {
  const base = settings(DEFAULTS);
  const withAgent = patch => ({ ...base, agents: { ...base.agents, coder: { ...base.agents.coder, ...patch } } });
  for (const [patch, message] of [
    [{ harness: 'shell' }, /coder: harness/],
    [{ model: '--dangerous' }, /coder: model/],
    [{ harness: 'opencode', model: null }, /OpenCode agents need a model/],
    [{ effort: 'extreme' }, /coder: effort/],
    [{ tools: 'root' }, /coder: tools/],
    [{ skills: ['../etc'] }, /coder: skills/],
    [{ timeoutMinutes: 0 }, /timeoutMinutes/],
    [{ exclusive: false }, /must hold the checkout/],
    [{ surprise: true }, /unknown setting "surprise"/],
  ]) assert.throws(() => checkAgents(withAgent(patch)), message);
  assert.throws(() => checkAgents({ ...base, agents: {} }), /1–20 agents/);
  assert.throws(() => checkAgents({ ...base, agents: { orchestrator: base.agents.coder } }), /Invalid agent name/);
  assert.throws(() => checkAgents({ ...base, limits: { maxParallel: 9, maxTasks: 30 } }), /maxParallel/);
  assert.throws(() => checkAgents({ ...base, orchestrator: { model: 'x/y', thinking: 'deep' } }), /thinking/);
  assert.equal(checkAgents(withAgent({ harness: 'opencode', model: 'openai/gpt-6.1-sol', effort: 'medium' })).agents.coder.effort, 'medium');
});

test('the orchestrator sees every agent with its capabilities', () => {
  const section = teamSection(checkAgents(settings(DEFAULTS)));
  for (const name of Object.keys(DEFAULTS.agents)) assert.match(section, new RegExp(`\\*\\*${name}\\*\\*`));
  assert.match(section, /\*\*researcher\*\* .*read-only.*can run alongside others/);
  assert.match(section, /\*\*security\*\* .*always follows: security-and-hardening/);
  assert.match(section, /At most 3 assignments/);
});

test('skill descriptions support YAML block scalars and quotes', () => {
  assert.equal(skillDescription('---\nname: a\ndescription: One line.\n---\nBody'), 'One line.');
  assert.equal(skillDescription('---\nname: a\ndescription: >\n  Folded across\n  two lines.\nlicense: MIT\n---\n'), 'Folded across two lines.');
  assert.equal(skillDescription('---\ndescription: "Quoted: yes"\n---\n'), 'Quoted: yes');
  assert.equal(skillDescription('No frontmatter'), undefined);
});
