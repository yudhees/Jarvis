// The Claude CLI's permission prompt tool (--permission-prompt-tool
// mcp__jarvis__permit). The CLI asks it before every MCP tool call; it asks
// Jarvis's core, which runs the gate, the spoken approval and the audit log.
// Plain JavaScript and no dependencies: it is started by the CLI.
// If core cannot be reached or answers badly, the call is denied.
import { createInterface } from 'node:readline';

const URL_ = process.env.JARVIS_PERMIT_URL;
const TOKEN = process.env.JARVIS_PERMIT_TOKEN;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const deny = (message) => ({ behavior: 'deny', message });

async function ask(args) {
  if (!URL_ || !TOKEN) return deny('Jarvis is not reachable, so nothing runs.');
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool_name: args?.tool_name, input: args?.input ?? {} }),
    });
    const answer = await res.json();
    if (answer?.behavior === 'allow' || answer?.behavior === 'deny') return answer;
    return deny('Jarvis gave no clear answer, so it was not done.');
  } catch {
    return deny('Jarvis is not reachable, so nothing runs.');
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'initialize') {
    out({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'jarvis', version: '1.0.0' },
      },
    });
  } else if (m.method === 'tools/list') {
    out({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          {
            name: 'permit',
            description: "Jarvis's permission gate.",
            inputSchema: {
              type: 'object',
              properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
              required: ['tool_name', 'input'],
            },
          },
        ],
      },
    });
  } else if (m.method === 'tools/call') {
    const answer =
      m.params?.name === 'permit' ? await ask(m.params.arguments) : deny('Unknown tool.');
    out({
      jsonrpc: '2.0',
      id: m.id,
      result: { content: [{ type: 'text', text: JSON.stringify(answer) }] },
    });
  } else if (m.id !== undefined) {
    out({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
// Exit with the CLI.
process.stdin.on('end', () => process.exit(0));
