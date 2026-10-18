import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('installation refuses outside Herdr before touching registration', () => {
  const script = fileURLToPath(new URL('../install.sh', import.meta.url));
  for (const extra of [{ HERDR_ENV: '' }, { HERDR_ENV: '1', HERDR_SOCKET_PATH: '' }]) {
    const result = spawnSync('sh', [script], { env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nothing was installed/);
    assert.equal(result.stdout, '');
  }
});
