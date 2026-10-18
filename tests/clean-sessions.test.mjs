import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findOldSessions, deleteSessions } from '../bin/clean-sessions.mjs';
import { createRun } from '../src/team.mjs';
import { DEFAULTS } from './fixtures/agents.mjs';

const DAY = 86_400_000;
const ID = '0b1a3f6e-2c4d-4e5f-8a9b-0c1d2e3f4a5b', NEW_ID = '1c2b4a7f-3d5e-4f60-9b0c-1d2e3f4a5b6c';
function file(path, ageDays, text = 'x') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  const when = new Date(Date.now() - ageDays * DAY);
  utimesSync(path, when, when);
  return path;
}

test('finds and deletes only sessions idle past the limit, and verifies OpenCode deletions', t => {
  const home = mkdtempSync(join(tmpdir(), 'clean-sessions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const claude = join(home, '.claude'), pi = join(home, '.pi/agent/sessions/--project--');
  const oldPi = file(join(pi, '2026-01-01_a.jsonl'), 10), newPi = file(join(pi, '2026-10-17_b.jsonl'), 1);
  const oldClaude = file(join(claude, 'projects/-proj', `${ID}.jsonl`), 9);
  file(join(claude, 'projects/-proj', ID, 'subagents/a.jsonl'), 9);
  file(join(claude, 'file-history', ID, 'v1'), 9);
  const newClaude = file(join(claude, 'projects/-proj', `${NEW_ID}.jsonl`), 2);
  const memory = file(join(claude, 'projects/-proj/memory/MEMORY.md'), 30);
  const notes = file(join(claude, 'projects/-proj/notes.jsonl'), 30);
  // OpenCode: a real SQLite store and a fake CLI that deletes from it (but refuses one id).
  const db = join(home, '.local/share/opencode/opencode.db');
  mkdirSync(join(db, '..'), { recursive: true });
  const old = Date.now() - 10 * DAY;
  execFileSync('sqlite3', [db, `create table session (id text primary key, parent_id text, directory text, title text, time_updated integer);
    insert into session values ('ses_old', null, '/gone', 'Old', ${old}), ('ses_stuck', null, '${home}', 'Stuck', ${old}),
    ('ses_child', 'ses_old', '/gone', 'Child', ${old}), ('ses_new', null, '${home}', 'New', ${Date.now()});`]);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh\n[ "$3" = ses_stuck ] && exit 1\nexec sqlite3 '${db}' "delete from session where id = '$3' or parent_id = '$3'"\n`, { mode: 0o700 });
  const state = join(home, 'state');
  mkdirSync(join(home, 'project'));
  const run = createRun(state, join(home, 'project'), 'w1', DEFAULTS);
  for (const name of ['run.json', 'orchestrator.md', 'tasks', '']) utimesSync(join(run, name), new Date(old), new Date(old));
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}`, HERDR_PLUGIN_STATE_DIR: state };

  const found = findOldSessions({ env, days: 7 });
  assert.deepEqual(found.map(item => item.tool).sort(), ['claude', 'opencode', 'opencode', 'orchestrator', 'pi']);
  assert.deepEqual(found.find(item => item.tool === 'claude').paths, [oldClaude, join(claude, 'projects/-proj', ID), join(claude, 'file-history', ID)]);
  assert.ok(existsSync(oldPi), 'finding deletes nothing');

  const { deleted, failed } = deleteSessions(found, { env, days: 7 });
  assert.equal(deleted, 4);
  assert.deepEqual(failed.map(item => item.id), ['ses_stuck']);
  for (const path of [oldPi, oldClaude, join(claude, 'file-history', ID), run]) assert.ok(!existsSync(path), path);
  for (const path of [newPi, newClaude, memory, notes]) assert.ok(existsSync(path), path);
  const left = execFileSync('sqlite3', [db, 'select id from session order by id'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(left, ['ses_new', 'ses_stuck']);
});
