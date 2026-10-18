import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [mode, ...rest] = process.argv.slice(2);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'malformed') console.log('not JSON');
else if (mode === 'serve') {
  // Private OpenCode server: log noise, then its URL; lives until stdin closes.
  console.log('starting');
  emit({ url: 'http://127.0.0.1:9' });
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else if (mode === 'tui') {
  // Visible TUI: stays open until the outcome file exists, or quits at once.
  const [target] = rest;
  if (target !== 'quit') setInterval(() => { if (existsSync(target)) process.exit(0); }, 20);
} else if (mode === 'slow') {
  emit({ type: 'step_start' });
  setTimeout(() => emit({ type: 'text', part: { text: 'Late report' } }), 1500);
} else if (mode === 'claude') {
  // Interactive Claude: runs the real Stop hook from --settings, then exits or idles.
  const [event, then] = rest;
  const settings = JSON.parse(rest[rest.indexOf('--settings') + 1]);
  if (event !== 'none') {
    const { command } = settings.hooks[event][0].hooks[0];
    const input = { hook_event_name: event, session_id: 's1', transcript_path: '/t.jsonl', last_assistant_message: 'Updated change.txt. Tests passed.' };
    if (event === 'StopFailure') input.error = 'rate_limit';
    for (const text of [input.last_assistant_message, 'Second turn']) { // a later turn must not overwrite the report
      const hook = spawnSync('sh', ['-c', command], { input: JSON.stringify({ ...input, last_assistant_message: text }), encoding: 'utf8' });
      if (hook.status !== 0 || hook.stdout) { console.error(`hook failed: ${hook.stderr}${hook.stdout}`); process.exit(3); }
    }
  }
  if (then === 'stay') setInterval(() => {}, 1000);
} else {
  emit({ type: 'text', part: { text: 'Found src/router.js — café' } });
  if (mode !== 'incomplete') emit({ type: 'step_finish', part: { reason: 'stop' } });
  if (mode === 'failure') { console.error('Authentication failed'); process.exitCode = 1; }
}
