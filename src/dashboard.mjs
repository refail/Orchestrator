import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, loadAgents, saveAgents, HARNESSES, TOOL_PRESETS, THINKING, CLAUDE_EFFORT } from './agents.mjs';
import { listSkills, SKILLS_DIR } from './skills.mjs';

// On-demand settings page. It lives only while a browser tab uses it: the page
// sends a heartbeat, and the server exits when heartbeats stop, the tab closes
// (with a short grace period so a reload survives), or on Ctrl+C.
export async function serveDashboard({ root = ROOT, skillsDir = SKILLS_DIR, open = true, log = console.log,
  idleMs = 3 * 60_000, closeGraceMs = 5000, port = 0 } = {}) {
  const token = randomBytes(24).toString('base64url');
  const page = readFileSync(join(ROOT, 'src/dashboard.html'), 'utf8');
  let idle, closing, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const touch = () => { clearTimeout(idle); clearTimeout(closing); idle = setTimeout(stop, idleMs); };
  const authorized = request => {
    const given = Buffer.from(String(request.headers['x-token'] ?? ''));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const send = (response, status, body, type = 'application/json') => {
    response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      ...(type === 'text/html' ? { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } : {}) });
    response.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const state = () => ({ ...loadAgents(root), skills: listSkills(skillsDir),
    options: { harnesses: HARNESSES, tools: TOOL_PRESETS, thinking: THINKING, claudeEffort: CLAUDE_EFFORT } });

  const server = createServer(async (request, response) => {
    // Only same-host requests: blocks DNS rebinding and cross-site writes.
    const host = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`)) return send(response, 403, { error: 'Forbidden' });
    const path = new URL(request.url, `http://${host}`).pathname;
    try {
      if (request.method === 'GET' && path === '/') return send(response, 200, page, 'text/html');
      if (!authorized(request)) return send(response, 401, { error: 'Missing or wrong dashboard token; reopen it from the command' });
      touch();
      if (request.method === 'GET' && path === '/api/state') return send(response, 200, state());
      if (request.method === 'POST' && path === '/api/ping') return send(response, 200, { ok: true });
      if (request.method === 'POST' && path === '/api/close') {
        clearTimeout(closing);
        closing = setTimeout(stop, closeGraceMs);
        return send(response, 200, { ok: true });
      }
      if (request.method === 'PUT' && path === '/api/state') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 2_000_000) throw new Error('Request too large'); }
        const { config, prompts } = JSON.parse(body);
        const known = new Set(listSkills(skillsDir).map(skill => skill.name));
        for (const [name, agent] of Object.entries(config?.agents ?? {})) {
          const missing = (agent?.skills ?? []).filter(skill => !known.has(skill));
          if (missing.length) throw new Error(`${name}: unknown skill ${missing.join(', ')}`);
        }
        saveAgents(root, config, prompts);
        log(`Saved ${join(root, 'agents.json')}`);
        return send(response, 200, state());
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) { send(response, 400, { error: error.message }); }
  });
  function stop() {
    clearTimeout(idle); clearTimeout(closing);
    server.close(() => finish());
    server.closeAllConnections();
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  touch();
  // The token travels in the fragment, which browsers never send to servers.
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  log(`Orchestrator settings: ${url}\nIt stops when you close the tab, after ${Math.round(idleMs / 60_000)} idle minutes, or on Ctrl+C.`);
  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => log(`Could not run ${opener}; open the URL yourself.`)).unref();
  }
  return { url, token, stop, done };
}
