/**
 * Jarvis core: the voice loop (phase 1).
 *
 *   npm start               say "Jarvis", then your request
 *   npm start -- --local    memory kept only while running (nothing saved)
 *
 * Ctrl+Alt+J stops, Ctrl+Alt+M mutes or unmutes, Ctrl+C quits.
 */
import { parseArgs } from 'node:util';
import type { CoreToPetEvent } from '@jarvis/shared';
import { Microphone, PorcupineSpotter, PvSpeakerPlayer } from './audio/index.ts';
import { loadConfig } from './config/index.ts';
import { WindowsHotkeys } from './hotkey/index.ts';
import { readSecret } from './secrets/index.ts';
import { resolveWhisper, WhisperCppStt } from './stt/index.ts';
import { WindowsSapiTts } from './tts/index.ts';
import { type TurnLog, VoiceLoop } from './voice/index.ts';
import { MissingKeyError, openConversation } from './voice/open.ts';

const { values: args } = parseArgs({ options: { local: { type: 'boolean' } }, strict: true });
const config = loadConfig();
const { jarvis } = config;

const picovoiceKey = await readSecret('picovoice');
if (!picovoiceKey) {
  console.error('No Picovoice AccessKey saved. Run: npm run set-key -- picovoice');
  process.exit(1);
}

let opened: Awaited<ReturnType<typeof openConversation>>;
try {
  opened = await openConversation(config, { local: args.local, projectDir: process.cwd() });
} catch (err) {
  console.error(
    err instanceof MissingKeyError ? err.message : `Startup failed: ${(err as Error).message}`,
  );
  process.exit(1);
}
const { conversation, learner } = opened;

const { serverExe, modelPath } = resolveWhisper(jarvis.dataDir, jarvis.stt.model);
const stt = new WhisperCppStt({
  serverExe,
  modelPath,
  port: jarvis.stt.port,
  threads: jarvis.stt.threads,
  language: jarvis.stt.language,
  idleStopMs: jarvis.stt.idleStopSeconds * 1000,
});
const tts = new WindowsSapiTts({
  voice: jarvis.voice.voice,
  rate: jarvis.voice.rate,
  timeoutMs: jarvis.voice.requestTimeoutSeconds * 1000,
});
const player = new PvSpeakerPlayer(jarvis.audio.outputDevice);
const keywords = new PorcupineSpotter({ accessKey: picovoiceKey, ...jarvis.keywords });
const mic = new Microphone(keywords.frameLength, jarvis.audio.inputDevice);
if (keywords.frameLength !== jarvis.audio.frameLength) {
  console.log(`Note: Porcupine uses ${keywords.frameLength}-sample frames.`);
}

const STATE_LABEL: Record<string, string> = {
  SLEEPING: 'asleep',
  LISTENING: 'listening...',
  THINKING: 'thinking...',
  SPEAKING: 'speaking',
  FOLLOW_UP: `listening for a follow-up (${jarvis.listening.followUpSeconds} s)`,
  MUTED: 'muted (Ctrl+Alt+M to unmute)',
  ERROR: 'error',
};
const MODEL_LETTER = { simple: 'H', standard: 'S', complex: 'O' } as const;

/** Console view until the pet bridge (phase 4). Levels are not printed. */
function show(event: CoreToPetEvent): void {
  switch (event.type) {
    case 'state':
      console.log(`  [${STATE_LABEL[event.state] ?? event.state}]`);
      break;
    case 'transcript_final':
      console.log(`You:    ${event.text}`);
      break;
    case 'reply_text':
      console.log(`Jarvis: ${event.text}`);
      break;
    case 'model_selected':
      console.log(`  [${MODEL_LETTER[event.tier]} ${event.model}, ${event.speed}]`);
      break;
    case 'error':
      console.log(`  [error: ${event.message}]`);
      break;
  }
}

function logTurn(t: TurnLog): void {
  const ms = (n: number | null) => (n === null ? '-' : `${Math.round(n)} ms`);
  const r = t.result;
  const parts = [
    `speech-to-text ${ms(t.sttMs)}`,
    `first word ${ms(t.firstAudioMs)}`,
    `total ${ms(t.totalMs)}`,
  ];
  if (r?.decision) parts.push(`${r.decision.kind}, decided by ${r.decision.decidedBy}`);
  if (r?.escalations) parts.push(`escalated ${r.escalations}x`);
  if (r?.usage.inputTokens) parts.push(`${r.usage.inputTokens}+${r.usage.outputTokens} tokens`);
  if (t.command) parts.push(`command: ${t.command}`);
  if (t.stopped) parts.push('stopped');
  console.log(`  (${parts.join(', ')})`);
}

const loop = new VoiceLoop({
  frames: (signal) => mic.frames(signal),
  keywords,
  stt,
  tts,
  player,
  conversation,
  timing: {
    sampleRate: jarvis.audio.sampleRate,
    frameLength: keywords.frameLength,
    silenceMs: jarvis.listening.silenceMs,
    startTimeoutMs: jarvis.listening.startTimeoutSeconds * 1000,
    maxRecordMs: jarvis.listening.maxRecordSeconds * 1000,
    followUpMs: jarvis.listening.followUpSeconds * 1000,
    fillerMs: jarvis.latency.normalSeconds * 1000,
  },
  emit: show,
  fixTranscript: (text) => learner.fixTranscript(text),
  hints: () => learner.vocabularyHints(),
  onWake: () => {
    stt.start().catch(() => {}); // load Whisper while the user is talking
  },
  onTurn: logTurn,
  onError: (err) => console.error(err),
});

const hotkeys = new WindowsHotkeys();
try {
  const taken = await hotkeys.start((action) => {
    if (action === 'stop') loop.stop();
    else loop.toggleMute();
  });
  for (const key of taken) console.log(`Hotkey for ${key} is used by another program.`);
} catch (err) {
  console.log(`Hotkeys unavailable: ${(err as Error).message}`);
}

const quit = new AbortController();
let closing = false;
process.on('SIGINT', () => {
  if (closing) process.exit(1);
  closing = true;
  quit.abort();
});

console.log(
  `Jarvis is ready. Memory: ${opened.memory}. ${opened.skillCount} skills found.\n` +
    `Say "${jarvis.keywords.wake === 'jarvis' ? 'Jarvis' : 'the wake word'}", then your request. ` +
    'Ctrl+Alt+J stops, Ctrl+Alt+M mutes, Ctrl+C quits.',
);
try {
  await loop.run(quit.signal);
} finally {
  hotkeys.close();
  keywords.release();
  await Promise.allSettled([stt.close(), tts.close()]);
  console.log('Bye.');
}
