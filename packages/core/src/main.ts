/**
 * Jarvis core: the voice loop (phase 1).
 *
 *   npm start               say "Jarvis" (or press Ctrl+Alt+L), then your request
 *   npm start -- --local    memory kept only while running (nothing saved)
 *
 * Ctrl+Alt+L talks, Ctrl+Alt+J stops, Ctrl+Alt+M mutes or unmutes, Ctrl+C quits.
 */
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CoreToPetEvent } from '@jarvis/shared';
import {
  type KeywordSpotter,
  Microphone,
  PorcupineSpotter,
  PvSpeakerPlayer,
  WindowsKeywordSpotter,
} from './audio/index.ts';
import { PetBridge, PetProcess, stopOrphanedHelpers } from './bridge/index.ts';
import { defaultConfigDir, LIVE_SETTINGS, loadConfig, watchJarvisConfig } from './config/index.ts';
import { WindowsHotkeys } from './hotkey/index.ts';
import { readSecret } from './secrets/index.ts';
import { resolveWhisper, WhisperCppStt } from './stt/index.ts';
import { WindowsSapiTts } from './tts/index.ts';
import { type TurnLog, VoiceLoop, WAKE_HINT } from './voice/index.ts';
import { MissingKeyError, openConversation } from './voice/open.ts';

const { values: args } = parseArgs({ options: { local: { type: 'boolean' } }, strict: true });
const config = loadConfig();

// Only one Jarvis at a time: two on one mic hear and answer each other. A port
// on 127.0.0.1 is the lock; Windows frees it when this process ends, even on a crash.
const INSTANCE_LOCK_PORT = 48178;
const instanceLock = createServer();
await new Promise<void>((resolve) => {
  instanceLock.once('error', () => {
    console.error('Jarvis is already running in another terminal. Stop it there first (Ctrl+C).');
    process.exit(1);
  });
  instanceLock.listen(INSTANCE_LOCK_PORT, '127.0.0.1', () => resolve());
});
instanceLock.unref();
const { jarvis } = config;

// Helpers left behind by a Jarvis that was closed without cleaning up.
const stale = stopOrphanedHelpers(
  path.resolve(import.meta.dirname, '..', '..', '..'),
  jarvis.dataDir,
);
if (stale > 0) console.log(`Stopped ${stale} leftover helper process(es) from an earlier run.`);

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
  if (k.provider === 'whisper') {
    return { spotter: null, how: 'Say "Jarvis" (Whisper)' };
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

const quit = new AbortController();
let petAskedToQuit = false;
// Run by the supervisor (npm run jarvis): it asks for a clean stop over IPC
// before reloading, so every helper process is closed properly.
process.on('message', (m) => {
  if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'quit') quit.abort();
});

// The pet (CLAUDE.md 11, 12): core sends every event to it; it can only ask
// core to stop, mute, unmute or quit. Never to approve anything.
const greeting = `Ready. ${wakeHow.replace(/ \(.*\)$/, '')}, or press Ctrl+Alt+L.`;
const bridge = new PetBridge({
  onEvent: (event) => {
    if (event.type === 'stop') loop.stop();
    else if (event.type === 'mute') loop.mute();
    else if (event.type === 'unmute') loop.unmute();
    else if (event.type === 'quit') {
      // Asked by the pet (its Stop button or Quit): the pet stays open, so it
      // can start Jarvis again.
      petAskedToQuit = true;
      quit.abort();
    }
  },
  onConnect: () => {
    console.log('  [pet connected]');
    bridge.send({ type: 'state', state: loop.state });
    bridge.send({ type: 'reply_text', text: greeting });
  },
});
let pet: PetProcess | undefined;
if (jarvis.pet.enabled) {
  try {
    const port = await bridge.listen();
    pet = new PetProcess(port, bridge.token, (line) => console.log(`  [pet: ${line}]`));
    pet.start();
  } catch (err) {
    console.log(`Pet unavailable: ${(err as Error).message}`);
  }
}

// Read by the loop each time it starts listening, so a settings change applies
// from the next request on.
const timing = {
  sampleRate: jarvis.audio.sampleRate,
  frameLength: jarvis.audio.frameLength,
  silenceMs: jarvis.listening.silenceMs,
  startTimeoutMs: jarvis.listening.startTimeoutSeconds * 1000,
  maxRecordMs: jarvis.listening.maxRecordSeconds * 1000,
  followUpMs: jarvis.listening.followUpSeconds * 1000,
  fillerMs: jarvis.latency.normalSeconds * 1000,
  bargeIn: jarvis.listening.bargeIn,
};
const loop = new VoiceLoop({
  frames: (signal) => mic.frames(signal),
  keywords,
  wakeByTranscript: jarvis.keywords.provider === 'whisper',
  stt,
  tts,
  player,
  conversation,
  timing,
  emit: (event) => {
    show(event);
    bridge.send(event);
  },
  fixTranscript: (text) => learner.fixTranscript(text),
  hints: () => [WAKE_HINT, ...learner.vocabularyHints()],
  onWake: () => {
    stt.start().catch(() => {}); // load Whisper while the user is talking
  },
  onTurn: logTurn,
  onError: (err) => console.error(err),
});

// The Settings window (and hand edits) change jarvis.yaml; the voice and the
// listening timings apply at once (LIVE_SETTINGS), everything else on restart.
const stopWatching = watchJarvisConfig(
  defaultConfigDir(),
  (next) => {
    tts.setVoice(next.voice.voice, next.voice.rate);
    timing.silenceMs = next.listening.silenceMs;
    timing.followUpMs = next.listening.followUpSeconds * 1000;
    timing.bargeIn = next.listening.bargeIn;
    console.log(`  [settings reloaded: ${[...LIVE_SETTINGS].join(', ')}]`);
  },
  (message) => console.log(`  [${message}]`),
);

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
// Say hello once. Spoken without the name, and through the loop, so Jarvis does
// not hear its own voice as a wake word.
void loop.announce('Ready.').catch(() => {});

try {
  await loop.run(quit.signal);
} finally {
  stopWatching();
  hotkeys.close();
  if (!petAskedToQuit) pet?.stop();
  await bridge.close();
  keywords?.release();
  await Promise.allSettled([stt.close(), tts.close(), opened.model.close?.()]);
  console.log('Bye.');
  if (process.connected) process.disconnect?.(); // the supervisor's channel would keep us alive
}
