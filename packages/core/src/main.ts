/**
 * Jarvis core: the voice loop (phase 1).
 *
 *   npm start               say "Jarvis" (or press Ctrl+Alt+L), then your request
 *   npm start -- --local    memory kept only while running (nothing saved)
 *
 * Ctrl+Alt+L talks, Ctrl+Alt+J stops, Ctrl+Alt+M mutes or unmutes, Ctrl+C quits.
 */
import { parseArgs } from 'node:util';
import type { CoreToPetEvent } from '@jarvis/shared';
import {
  type KeywordSpotter,
  Microphone,
  PorcupineSpotter,
  PvSpeakerPlayer,
  WindowsKeywordSpotter,
} from './audio/index.ts';
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

/** How Jarvis hears its name: Windows' own recognizer, Picovoice, or the hotkey only. */
async function openKeywords(): Promise<{ spotter: KeywordSpotter | null; how: string }> {
  const k = jarvis.keywords;
  if (k.provider === 'picovoice') {
    const accessKey = await readSecret('picovoice');
    if (accessKey) {
      const spotter = new PorcupineSpotter({ accessKey, ...k });
      if (spotter.frameLength !== jarvis.audio.frameLength) {
        throw new Error(`Porcupine needs audio.frameLength ${spotter.frameLength}`);
      }
      return { spotter, how: 'Say "Jarvis" (Picovoice)' };
    }
    console.log('No Picovoice AccessKey saved; using the Windows recognizer instead.');
  }
  if (k.provider !== 'none') {
    const spotter = new WindowsKeywordSpotter({
      sampleRate: jarvis.audio.sampleRate,
      minConfidence: k.minConfidence,
      gain: k.gain,
    });
    try {
      await spotter.start();
      return { spotter, how: 'Say "Jarvis" (Windows speech recognizer)' };
    } catch (err) {
      console.log(`Windows speech recognizer unavailable: ${(err as Error).message}`);
    }
  }
  return { spotter: null, how: 'Press Ctrl+Alt+L' };
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
const { spotter: keywords, how: wakeHow } = await openKeywords();
const mic = new Microphone(jarvis.audio.frameLength, jarvis.audio.inputDevice);

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
    frameLength: jarvis.audio.frameLength,
    silenceMs: jarvis.listening.silenceMs,
    startTimeoutMs: jarvis.listening.startTimeoutSeconds * 1000,
    maxRecordMs: jarvis.listening.maxRecordSeconds * 1000,
    followUpMs: jarvis.listening.followUpSeconds * 1000,
    fillerMs: jarvis.latency.normalSeconds * 1000,
  },
  emit: show,
  fixTranscript: (text) => learner.fixTranscript(text),
  hints: () => ['Jarvis', ...learner.vocabularyHints()],
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
    else if (action === 'talk') loop.talk();
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
  `Jarvis is ready. Brain: ${opened.brain}. Memory: ${opened.memory}. ${opened.skillCount} skills found.\n` +
    `${wakeHow}, then your request (or Ctrl+Alt+L). ` +
    'Ctrl+Alt+J stops, Ctrl+Alt+M mutes, Ctrl+C quits.',
);
try {
  await loop.run(quit.signal);
} finally {
  hotkeys.close();
  keywords?.release();
  await Promise.allSettled([stt.close(), tts.close(), opened.model.close?.()]);
  console.log('Bye.');
}
