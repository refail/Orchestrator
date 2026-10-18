import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Agent Skills location shared by Pi, Claude Code and OpenCode.
export const SKILLS_DIR = join(homedir(), '.agents/skills');
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function loadSkill(name, dir = SKILLS_DIR) {
  if (typeof name !== 'string' || name.length > 64 || !NAME.test(name)) throw new Error('Invalid skill name');
  try { return readFileSync(join(dir, name, 'SKILL.md'), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error(`Unknown skill: ${name}; call team_skill without a name to list skills`);
    throw error;
  }
}
export function listSkills(dir = SKILLS_DIR) {
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => NAME.test(name)).sort().flatMap(name => {
    let text;
    try { text = loadSkill(name, dir); } catch { return []; }
    const description = /^description:\s*(.+)$/m.exec(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '')?.[1]?.trim();
    return description ? [{ name, description }] : [];
  });
}
