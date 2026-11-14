/**
 * Talk to Jarvis by typing: same routing, memory, learning, skills and model
 * calls as the voice loop, without the mic (CLAUDE.md 14, phase 1).
 *
 *   npm run repl                 replies printed
 *   npm run repl -- --speak      replies also spoken
 *   npm run repl -- --local      memory kept only while running
 *
 * Uses your Claude subscription through Claude Code (brain.provider in jarvis.yaml).
 */
import { createInterface } from 'node:readline';
import { PvSpeakerPlayer } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { WindowsSapiTts } from '@jarvis/core/tts';
import { matchCommand, openConversation, SpeechQueue } from '@jarvis/core/voice';
import { scriptArgs } from './args.ts';

const args = scriptArgs({ speak: { type: 'boolean' }, local: { type: 'boolean' } });
const config = loadConfig();
const { jarvis } = config;

let opened: Awaited<ReturnType<typeof openConversation>>;
try {
  opened = await openConversation(config, {
    local: args.local === true,
    projectDir: process.cwd(),
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const { conversation } = opened;
conversation.warm(); // start the model while you type
const tts = args.speak
  ? new WindowsSapiTts({
      voice: jarvis.voice.voice,
      rate: jarvis.voice.rate,
      timeoutMs: jarvis.voice.requestTimeoutSeconds * 1000,
    })
  : undefined;
const player = args.speak ? new PvSpeakerPlayer(jarvis.audio.outputDevice) : undefined;

console.log(
  `Brain: ${opened.brain}. Memory: ${opened.memory}. ${opened.skillCount} skills found.\nType :quit to exit, :new for a new conversation.\n`,
);
const MODEL_LETTER = { simple: 'H', standard: 'S', complex: 'O' } as const;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => process.stdout.write('You: ');
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!process.stdin.isTTY) console.log(line);
  if (line === ':quit') break;
  if (line === ':new') {
    conversation.reset();
    conversation.warm();
    console.log('(new conversation)');
  } else if (line) {
    const command = matchCommand(line);
    if (command) {
      console.log(`(spoken command: ${command})`);
      if (command !== 'status') conversation.reset();
    } else {
      const controller = new AbortController();
      const queue =
        tts && player ? new SpeechQueue({ tts, player, signal: controller.signal }) : undefined;
      const t0 = performance.now();
      try {
        const r = await conversation.ask(line, {
          onSentence: (s) => {
            console.log(`Jarvis: ${s}`);
            queue?.say(s);
          },
          onModel: (tier, model) => console.log(`  [${MODEL_LETTER[tier]} ${model}]`),
        });
        await queue?.done();
        const parts = [`${Math.round(performance.now() - t0)} ms`];
        if (r.firstSentenceMs !== null)
          parts.push(`first sentence ${Math.round(r.firstSentenceMs)} ms`);
        if (r.decision)
          parts.push(`${r.decision.kind}, ${r.decision.decidedBy}, ${r.decision.speed}`);
        if (r.escalations) parts.push(`escalated ${r.escalations}x`);
        if (r.usage.inputTokens)
          parts.push(`${r.usage.inputTokens}+${r.usage.outputTokens} tokens`);
        if (r.usage.toolCalls) parts.push(`${r.usage.toolCalls} lookups`);
        console.log(`  (${parts.join(', ')})`);
      } catch (err) {
        console.log(`  [error: ${(err as Error).message}]`);
      }
    }
  }
  prompt();
}
rl.close();
await tts?.close();
await opened.close();
