import { createInterface } from 'node:readline';
import { toolText } from './tools.mjs';

// Minimal Model Context Protocol server: newline-delimited JSON-RPC 2.0 over
// stdio, tools only. Claude Code and OpenCode leads use it to reach the same
// team tools that the Pi extension registers. Stdout carries protocol only.
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export async function serveMcp(tools, { input = process.stdin, output = process.stdout, log = line => process.stderr.write(`${line}\n`) } = {}) {
  const running = new Map(), calls = new Set();
  const send = message => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const fail = (id, code, message) => send({ id, error: { code, message } });
  async function call(id, params) {
    const tool = tools.find(item => item.name === params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    const controller = new AbortController();
    running.set(id, controller);
    let result;
    try {
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      result = { content: [{ type: 'text', text: toolText(await tool.execute(args, controller.signal)) }] };
    } catch (error) {
      // Tool failures are results the model can read, not protocol errors.
      result = { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
    } finally { running.delete(id); }
    if (!controller.signal.aborted) send({ id, result }); // A cancelled request gets no response.
  }
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
    const { id, method, params } = message ?? {};
    if (method === 'notifications/cancelled') { running.get(params?.requestId)?.abort(); continue; }
    if (id === undefined || id === null) continue; // Other notifications, e.g. notifications/initialized.
    if (method === 'initialize') {
      const protocolVersion = VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0];
      send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'herdr-team', version: '1.0.0' } } });
    } else if (method === 'ping') send({ id, result: {} });
    else if (method === 'tools/list') send({ id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    else if (method === 'tools/call') { const pending = call(id, params); calls.add(pending); pending.finally(() => calls.delete(pending)); }
    else { log(`team MCP: unsupported method ${method}`); fail(id, -32601, `Method not found: ${method}`); }
  }
  // The client closed stdin: stop waiting calls and let delegations finish.
  for (const controller of running.values()) controller.abort();
  await Promise.allSettled(calls);
}
