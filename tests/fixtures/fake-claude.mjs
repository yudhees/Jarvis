// A stand-in for `claude -p --input-format stream-json` used by tests.
// Replies are scripted by the user's text; it also reports how it was started.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
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
      tools: process.env.FAKE_CLI_TOOLS ? process.env.FAKE_CLI_TOOLS.split(',') : [],
      mcp_servers: [],
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
        turn,
      }),
    );
  } else if (content.includes('<lookup_result')) {
    say(`Found it: ${content.includes('design lead') ? 'Priya is the design lead.' : 'nothing.'}`);
  } else if (content.includes('who is priya')) {
    say('[[LOOKUP memory_search: Priya]]');
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
