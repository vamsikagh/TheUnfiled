import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('./evidence-mcp-server.mjs', import.meta.url));
const protocol = '2025-06-18';

export function createEvidenceMcpClient(database, caseId) {
  let child;
  let sequence = 0;
  let starting;
  const pending = new Map();

  function cancel(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  function send(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('The evidence MCP server timed out.')), 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) fail(error);
      });
    });
  }

  async function connect() {
    child = spawn(process.execPath, [executable], {
      env: { ...process.env, TD_MCP_DATABASE: database, TD_MCP_CASE_ID: caseId },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stderr.resume();
    child.stdin.on('error', cancel);
    child.once('error', cancel);
    child.once('close', () => cancel(new Error('The evidence MCP server closed.')));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { cancel(new Error('The evidence MCP server returned invalid JSON.')); return; }
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
    const hello = await send('initialize', { protocolVersion: protocol, capabilities: {},
      clientInfo: { name: 'text-detective', version: '1.0.0' } });
    if (hello.protocolVersion !== protocol || !hello.capabilities?.tools) throw new Error('Unsupported evidence MCP server.');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  return {
    async list() {
      await (starting ??= connect());
      return (await send('tools/list', {})).tools;
    },
    async call(name, args) {
      await (starting ??= connect());
      const result = await send('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(result.content?.[0]?.text || 'The evidence tool failed.');
      return result.structuredContent;
    },
    close() {
      cancel(new Error('The evidence MCP session ended.'));
      child?.stdin.destroy();
      child?.kill();
    },
  };
}
