#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.FAKE_ROOT;
const emit = event => console.log(JSON.stringify(event));
if (name === 'herdr') {
  fs.appendFileSync(path.join(root, 'herdr-calls.jsonl'), `${JSON.stringify(args)}\n`);
  if (args[0] === 'pane') {
    const pane = { pane_id: 'w1:p1', terminal_id: 'coordinator-terminal', workspace_id: 'w1', tab_id: 'w1:t1' };
    emit({ result: args[1] === 'process-info'
      ? { process_info: { pane_id: pane.pane_id, foreground_processes: [{ pid: process.ppid }] } }
      : args[1] === 'get' ? { pane } : { panes: [pane] } });
    process.exit(0);
  }
  if (args[0] === 'tab' || args[2] === 'close') { emit({ result: { type: 'ok' } }); process.exit(0); }
  const value = flag => args[args.indexOf(flag) + 1];
  const env = { ...process.env };
  for (let i = 0; i < args.length; i++) if (args[i] === '--env') {
    const setting = args[++i], equal = setting.indexOf('=');
    env[setting.slice(0, equal)] = setting.slice(equal + 1);
  }
  const entrypoint = value('--entrypoint');
  const child = spawn(process.execPath, [path.join(env.HERDR_PLUGIN_ROOT, 'src/cli.mjs'), entrypoint], {
    cwd: value('--cwd'), env, detached: true, stdio: 'ignore',
  });
  child.unref();
  emit({ result: { type: 'plugin_pane_opened', plugin_pane: { plugin_id: 'personal.orchestrator', entrypoint,
    pane: { pane_id: `w1:p${child.pid}`, tab_id: `w1:t${child.pid}`, terminal_id: entrypoint === 'coordinator' ? 'coordinator-terminal' : `terminal-${child.pid}` } } } });
} else if (name === 'pi') {
  fs.writeFileSync(path.join(root, 'pi-launch.json'), JSON.stringify({ cwd: process.cwd(), args, run: process.env.HERDR_ORCH_RUN }));
} else if (name === 'claude') {
  // Interactive TUI: the brief is the last argument; completion goes through the Stop hook.
  if (!args.at(-1).startsWith('Assignment:')) process.exit(2);
  fs.writeFileSync(path.join(root, 'claude-args.json'), JSON.stringify(args));
  fs.writeFileSync('change.txt', 'fake coder change');
  const { command } = JSON.parse(args[args.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0];
  require('node:child_process').spawnSync('sh', ['-c', command], {
    input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Updated change.txt. Tests passed.' }),
  });
} else if (args[0] === 'serve') {
  emit({ url: 'http://127.0.0.1:9' });
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else if (args[0] === 'run') {
  emit({ type: 'text', part: { text: 'Relevant files inspected; no blocking findings.' } });
  emit({ type: 'step_finish', part: { reason: 'stop' } });
} else {
  // OpenCode TUI attached to the session: stays until the outcome is recorded.
  const result = path.join(process.env.HERDR_ORCH_RUN, 'tasks', process.env.HERDR_ORCH_TASK, 'result.json');
  setInterval(() => { if (fs.existsSync(result)) process.exit(0); }, 20);
}
