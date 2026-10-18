#!/usr/bin/env node
// Delete Pi, Claude Code, OpenCode and orchestrator sessions with no activity
// for N days (default 7). Lists what it found and asks before deleting.
//   clean-sessions [--days N] [--dry-run] [--yes]
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { pruneRuns } from '../src/team.mjs';
import { PLUGIN_ID } from '../src/herdr.mjs';

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPENCODE_ID = /^ses_[A-Za-z0-9]+$/;

const entries = dir => { try { return readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
function size(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
}
const paths = env => {
  const home = env.HOME || homedir();
  return {
    home,
    pi: env.PI_CODING_AGENT_SESSION_DIR || join(home, '.pi/agent/sessions'),
    claude: join(home, '.claude'),
    opencodeDb: join(env.XDG_DATA_HOME || join(home, '.local/share'), 'opencode/opencode.db'),
    runs: env.HERDR_PLUGIN_STATE_DIR || join(env.XDG_STATE_HOME || join(home, '.local/state'), 'herdr/plugins', PLUGIN_ID),
  };
};
const sql = (db, query) => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', `file:${db}?mode=ro`, query], { encoding: 'utf8' }) || '[]');

export function findOldSessions({ env = process.env, days = 7, now = Date.now() } = {}) {
  const where = paths(env), cutoff = now - days * DAY, found = [];
  for (const dir of entries(where.pi).filter(entry => entry.isDirectory())) {
    for (const file of entries(join(where.pi, dir.name))) {
      const path = join(where.pi, dir.name, file.name);
      if (file.isFile() && file.name.endsWith('.jsonl') && lstatSync(path).mtimeMs < cutoff) {
        found.push({ tool: 'pi', label: `${dir.name}/${file.name}`, paths: [path], last: lstatSync(path).mtimeMs });
      }
    }
  }
  for (const run of pruneRuns(where.runs, { maxAgeMs: days * DAY, now, dryRun: true }).removed) {
    found.push({ tool: 'orchestrator', label: run.dir, paths: [run.dir], last: Date.parse(run.lastActivity) });
  }
  // Only files named by a session ID; memory/ and everything else stay.
  for (const project of entries(join(where.claude, 'projects')).filter(entry => entry.isDirectory())) {
    for (const file of entries(join(where.claude, 'projects', project.name))) {
      const id = file.name.slice(0, -'.jsonl'.length);
      const transcript = join(where.claude, 'projects', project.name, file.name);
      if (!file.isFile() || !file.name.endsWith('.jsonl') || !UUID.test(id) || lstatSync(transcript).mtimeMs >= cutoff) continue;
      const extra = [join(where.claude, 'projects', project.name, id), join(where.claude, 'file-history', id),
        join(where.claude, 'session-env', id), join(where.claude, 'debug', `${id}.txt`)].filter(path => existsSync(path));
      found.push({ tool: 'claude', label: `${project.name}/${id}`, paths: [transcript, ...extra], last: lstatSync(transcript).mtimeMs });
    }
  }
  if (existsSync(where.opencodeDb)) {
    // Read-only discovery; deletion goes through OpenCode itself. Children go with their parent.
    for (const row of sql(where.opencodeDb, `select id, directory, title, time_updated from session where parent_id is null and time_updated < ${Math.floor(cutoff)}`)) {
      if (OPENCODE_ID.test(row.id)) found.push({ tool: 'opencode', label: `${row.title} (${row.directory})`, id: row.id, directory: row.directory, paths: [], last: row.time_updated });
    }
  }
  return found.sort((a, b) => a.last - b.last);
}

export function deleteSessions(found, { env = process.env, days = 7, now = Date.now(), log = () => {} } = {}) {
  const where = paths(env), failed = [];
  let deleted = 0;
  for (const item of found.filter(item => item.tool === 'pi' || item.tool === 'claude')) {
    for (const path of item.paths) rmSync(path, { recursive: true, force: true });
    deleted++;
  }
  // Re-checks leases and live workers at deletion time.
  if (found.some(item => item.tool === 'orchestrator')) deleted += pruneRuns(where.runs, { maxAgeMs: days * DAY, now }).removed.length;
  const opencode = found.filter(item => item.tool === 'opencode');
  opencode.forEach((item, index) => {
    log(`OpenCode ${index + 1}/${opencode.length}: ${item.label}`);
    try {
      execFileSync('opencode', ['session', 'delete', item.id], { cwd: existsSync(item.directory) ? item.directory : where.home, stdio: 'ignore', timeout: 60_000, env });
    } catch { /* verified below */ }
    if (sql(where.opencodeDb, `select id from session where id = '${item.id}'`).length) failed.push(item);
    else deleted++;
  });
  return { deleted, failed };
}

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
async function main(args) {
  const usage = 'Usage: clean-sessions [--days N] [--dry-run] [--yes]';
  if (args.includes('--help') || args.includes('-h')) return console.log(usage);
  const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 7;
  if (!(days > 0) || args.some((arg, i) => !['--days', '--dry-run', '--yes'].includes(arg) && args[i - 1] !== '--days')) throw new Error(usage);
  const found = findOldSessions({ days });
  if (!found.length) return console.log(`No Pi, Claude Code, OpenCode or orchestrator sessions idle for more than ${days} days.`);
  if (args.includes('--dry-run')) {
    for (const item of found) console.log(`${new Date(item.last).toISOString().slice(0, 10)}  ${item.tool.padEnd(12)} ${item.label}`);
  }
  console.log(`\nSessions with no activity for more than ${days} days:`);
  for (const tool of ['pi', 'orchestrator', 'claude', 'opencode']) {
    const items = found.filter(item => item.tool === tool);
    if (items.length) console.log(`  ${tool.padEnd(12)} ${String(items.length).padStart(4)}${tool === 'opencode' ? '' : `  ${mb(items.flatMap(item => item.paths).reduce((total, path) => total + size(path), 0))}`}`);
  }
  if (args.includes('--dry-run')) return console.log('\nDry run: nothing deleted.');
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) throw new Error('Not a terminal: pass --yes to delete without asking');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(`\nDelete these ${found.length} sessions permanently? [y/N] `);
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing deleted.');
  }
  const { deleted, failed } = deleteSessions(found, { days, log: line => process.stdout.write(`\r\x1b[2K${line.slice(0, 100)}`) });
  console.log(`\r\x1b[2KDeleted ${deleted} sessions.`);
  if (failed.length) {
    console.log(`${failed.length} OpenCode sessions could not be deleted; try \`opencode session delete <id>\` in their project:`);
    for (const item of failed) console.log(`  ${item.id}  ${item.label}`);
    process.exitCode = 1;
  }
}
// realpath: usually run through a symlink in ~/.local/bin.
if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
