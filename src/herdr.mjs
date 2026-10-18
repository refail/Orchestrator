import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const exec = promisify(execFile);
export const PLUGIN_ID = 'personal.orchestrator';
export function requireHerdr(env = process.env) {
  if (env.HERDR_ENV !== '1' || !env.HERDR_SOCKET_PATH) throw new Error('Run this from a Herdr-managed pane (HERDR_ENV=1). No live pane was touched.');
}
export function invocation(env = process.env) {
  requireHerdr(env);
  const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  const workspace = context.workspace_id;
  const cwd = context.workspace_cwd || context.focused_pane_cwd;
  if (typeof workspace !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Missing explicit project/workspace plugin context');
  if (env.HERDR_WORKSPACE_ID && workspace !== env.HERDR_WORKSPACE_ID) throw new Error('Workspace context mismatch');
  const project = realpathSync(cwd);
  if (!statSync(project).isDirectory()) throw new Error('Project context must be a directory');
  return { project, workspace };
}
async function call(args, env) {
  const { stdout } = await exec(env.HERDR_BIN_PATH || 'herdr', args, { env, timeout: 30_000, maxBuffer: 512_000 });
  const response = JSON.parse(stdout);
  if (response.error || !response.result) throw new Error(response.error?.message || 'Missing Herdr receipt');
  return response.result;
}
export async function currentPane(env = process.env) {
  requireHerdr(env);
  if (!env.HERDR_PANE_ID) throw new Error('Missing HERDR_PANE_ID; use a fresh Herdr-managed pane');
  const { pane } = await call(['pane', 'get', env.HERDR_PANE_ID], env);
  if (pane?.pane_id !== env.HERDR_PANE_ID || typeof pane.terminal_id !== 'string' || !pane.terminal_id || !pane.workspace_id ||
      (env.HERDR_WORKSPACE_ID && pane.workspace_id !== env.HERDR_WORKSPACE_ID) ||
      (env.HERDR_TAB_ID && pane.tab_id !== env.HERDR_TAB_ID)) {
    throw new Error('Current pane identity changed; use a fresh Herdr-managed pane');
  }
  const { process_info: info } = await call(['pane', 'process-info', '--pane', env.HERDR_PANE_ID], env);
  if (info?.pane_id !== pane.pane_id || !info.foreground_processes?.some(item => item.pid === process.pid)) {
    throw new Error('The named Herdr pane does not own this process; use a fresh pane');
  }
  return pane;
}
export async function openPane({ workspace, anchor, project, entrypoint, focus, placement = 'tab', label, env: paneEnv = {} }, env = process.env) {
  requireHerdr(env);
  if (!['worker', 'coordinator', 'status'].includes(entrypoint) || !workspace || !project) throw new Error('Invalid pane launch context');
  if (entrypoint === 'worker') {
    if (!anchor) throw new Error('Missing coordinator terminal receipt; inspect the run before retrying');
    const { panes } = await call(['pane', 'list'], env);
    const owners = panes.filter(pane => pane.terminal_id === anchor);
    if (owners.length !== 1) throw new Error('Coordinator terminal is missing or ambiguous; refusing to target a reused workspace ID');
    workspace = owners[0].workspace_id;
  }
  const args = ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', entrypoint,
    '--workspace', workspace, '--cwd', project, '--placement', placement, focus ? '--focus' : '--no-focus'];
  for (const [key, value] of Object.entries(paneEnv)) args.push('--env', `${key}=${value}`);
  // Herdr 0.7.1 wraps plugin pane receipts in result.plugin_pane.
  const { plugin_pane: receipt } = await call(args, env);
  if (typeof receipt?.pane?.terminal_id !== 'string' || !receipt.pane.terminal_id) {
    throw new Error('Missing stable plugin pane terminal identity');
  }
  if (label) {
    // Cosmetic: a failed rename must not make an opened worker look uncertain.
    try {
      await call(['pane', 'rename', receipt.pane.pane_id, label], env);
      if (placement === 'tab' && receipt.pane.tab_id) await call(['tab', 'rename', receipt.pane.tab_id, label], env);
      receipt.pane.label = label;
    } catch (error) { receipt.rename_error = String(error.message).slice(0, 500); }
  }
  return receipt;
}
// Pane IDs can be reused after renumbering; close only the pane that still owns
// this worker's stable terminal.
export async function closeWorkerPane(terminalId, env = process.env) {
  requireHerdr(env);
  if (typeof terminalId !== 'string' || !terminalId) throw new Error('Missing worker terminal identity');
  const { panes } = await call(['pane', 'list'], env);
  const owners = panes.filter(pane => pane.terminal_id === terminalId);
  if (owners.length > 1) throw new Error('Worker terminal is ambiguous; not closing anything');
  if (!owners.length) return false;
  await call(['plugin', 'pane', 'close', owners[0].pane_id], env);
  return true;
}
