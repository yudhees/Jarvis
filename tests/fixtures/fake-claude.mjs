// A stand-in for `claude -p --input-format stream-json` used by tests.
// Replies are scripted by the user's text; it also reports how it was started.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const mcpConfig = flagValue('--mcp-config');
const servers = mcpConfig ? Object.keys(JSON.parse(mcpConfig).mcpServers) : [];
const disallowed = [];
if (args.includes('--disallowed-tools')) {
  for (
    let i = args.indexOf('--disallowed-tools') + 1;
    i < args.length && !args[i].startsWith('--');
    i++
  )
    disallowed.push(args[i]);
}
const message = (text, stopReason) => {
  out({
    type: 'stream_event',
    event: { type: 'message_start', message: { usage: { input_tokens: 7 } } },
  });
  out({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
  out({
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: { output_tokens: 3 },
    },
  });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
};
const say = (text) => {
  out({
    type: 'stream_event',
    event: { type: 'message_start', message: { usage: { input_tokens: 7 } } },
  });
  for (const piece of text.match(/.{1,6}/gs) ?? []) {
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } },
    });
  }
  out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 3 } } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text });
};

let turn = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const content = JSON.parse(line).message.content;
  turn++;
  if (turn === 1) {
    // Like the real CLI: the init report comes with the first message.
    out({
      type: 'system',
      subtype: 'init',
      tools: (process.env.FAKE_CLI_TOOLS ? process.env.FAKE_CLI_TOOLS.split(',') : []).filter(
        (t) => !disallowed.includes(t),
      ),
      mcp_servers: [...servers, ...(process.env.FAKE_CLI_SERVERS?.split(',') ?? [])].map(
        (name) => ({ name, status: 'connected' }),
      ),
    });
  }
  if (content.includes('REPORT')) {
    const flag = (name) => args[args.indexOf(name) + 1];
    say(
      JSON.stringify({
        tools: flag('--tools'),
        settingSources: flag('--setting-sources'),
        strictMcp: args.includes('--strict-mcp-config'),
        noSlash: args.includes('--disable-slash-commands'),
        model: flag('--model'),
        apiKey: process.env.ANTHROPIC_API_KEY ?? null,
        permissionTool: flagValue('--permission-prompt-tool') ?? null,
        permissionMode: flagValue('--permission-mode') ?? null,
        servers,
        disallowed,
        permitUrl: process.env.JARVIS_PERMIT_URL ?? null,
        claudeAi: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
        turn,
      }),
    );
  } else if (content.includes('<lookup_result')) {
    say(`Found it: ${content.includes('design lead') ? 'Priya is the design lead.' : 'nothing.'}`);
  } else if (content.includes('who is priya')) {
    say('[[LOOKUP memory_search: Priya]]');
  } else if (content.includes('ticket')) {
    // Like a turn with an MCP tool call: text, a tool, then the answer.
    message('Let me check.', 'tool_use');
    setTimeout(() => {
      message('You have 3 tickets.', 'end_turn');
      out({ type: 'result', subtype: 'success', is_error: false, result: 'x' });
    }, 50);
  } else if (content.includes('slow')) {
    setTimeout(() => say('Too late.'), 5000);
  } else if (content.includes('error')) {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'not logged in',
    });
  } else {
    say(`Reply ${turn}.`);
  }
});
