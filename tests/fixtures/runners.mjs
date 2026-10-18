import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// A worker runner outlives its recorded outcome until its helpers stop. Wait for
// every runner of a run before deleting its files: a fake TUI watching a deleted
// result.json would otherwise wait forever and leak the runner and its server.
// A runner still alive at the deadline is killed (with its process group) and
// fails the test.
export async function runnersExited(runDir, timeoutMs = 5000) {
  const pids = readdirSync(join(runDir, 'tasks')).flatMap(id => {
    try { return [JSON.parse(readFileSync(join(runDir, 'tasks', id, 'started.json'), 'utf8')).pid]; } catch { return []; }
  });
  const deadline = Date.now() + timeoutMs;
  for (const pid of pids) {
    while (alive(pid)) {
      if (Date.now() > deadline) {
        for (const target of [-pid, pid]) try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
        throw new Error(`Worker runner ${pid} did not exit after its task finished`);
      }
      await sleep(20);
    }
  }
}
