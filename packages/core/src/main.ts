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
import { RequestLog } from './router/index.ts';
import { readSecret } from './secrets/index.ts';
import { resolveWhisper, WhisperCppStt } from './stt/index.ts';
import { WindowsSapiTts } from './tts/index.ts';
import { HistoryLog, UsageLog } from './usage/index.ts';
import { type TurnLog, VoiceLoop, WAKE_HINT } from './voice/index.ts';
import { LockdownError, MissingKeyError, openConversation } from './voice/open.ts';

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
  opened = await openConversation(config, {
    local: args.local,
    projectDir: process.cwd(),
    selfTest: true,
  });
} catch (err) {
  console.error(
    err instanceof MissingKeyError || err instanceof LockdownError
      ? err.message
      : `Startup failed: ${(err as Error).message}`,
  );
  process.exit(1);
}
const { conversation, learner } = opened;

const { serverExe, modelPath, vadModelPath, vadMissing } = resolveWhisper(
  jarvis.dataDir,
  jarvis.stt.model,
  { vad: jarvis.stt.vad },
);
if (vadMissing) console.warn(vadMissing);
const stt = new WhisperCppStt({
  serverExe,
  modelPath,
  port: jarvis.stt.port,
  threads: jarvis.stt.threads,
  language: jarvis.stt.language,
  idleStopMs: jarvis.stt.idleStopSeconds * 1000,
  vadModelPath,
  beamSize: jarvis.stt.beamSize,
  suppressNonSpeech: jarvis.stt.suppressNonSpeech,
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

// Daily totals for the Settings window's Usage tab (numbers only, kept 30 days).
const usage = new UsageLog(jarvis.dataDir, jarvis.retention.transcriptDays);
usage.prune();
// Conversation text for the History tab (secrets blanked, kept as long as transcripts).
const history = new HistoryLog(jarvis.dataDir, jarvis.retention.transcriptDays);
history.prune();
// Retention also runs once a day for a Jarvis left running (CLAUDE.md 10.7).
setInterval(
  () => {
    usage.prune();
    history.prune();
  },
  24 * 60 * 60 * 1000,
).unref();

const requestLog = new RequestLog(path.join(jarvis.dataDir, 'routing'), jarvis.routing.logDays);

/** One line per answered request in the routing log (no transcript in it). */
function recordTurn(t: TurnLog): void {
  const r = t.result;
  if (!r?.decision || !r.tier || !r.model) return;
  requestLog.write({
    at: new Date().toISOString(),
    kind: r.decision.kind,
    words: (t.heard.match(/S+/g) ?? []).length,
    tier: r.tier,
    speed: r.decision.speed,
    model: r.model,
    decidedBy: r.decision.decidedBy,
    classifier: r.classifier && {
      tier: r.classifier.classification?.tier ?? null,
      raised: r.classifier.raised,
      ms: Math.round(r.classifier.ms),
    },
    escalations: r.escalations,
    sttMs: Math.round(t.sttMs),
    firstWordMs: t.firstAudioMs === null ? null : Math.round(t.firstAudioMs),
    totalMs: Math.round(t.totalMs),
    latencyBudgetMs: t.latencyBudgetMs ?? 0,
    latencyMiss: t.latencyMiss ?? false,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    lookups: r.usage.toolCalls,
    stopped: t.stopped,
  });
}

function logTurn(t: TurnLog): void {
  recordTurn(t);
  usage.record(t);
  history.record(t);
  const ms = (n: number | null) => (n === null ? '-' : `${Math.round(n)} ms`);
  const r = t.result;
  const parts = [
    `speech-to-text ${ms(t.sttMs)}`,
    `first word ${ms(t.firstAudioMs)}`,
    `total ${ms(t.totalMs)}`,
  ];
  if (r?.decision) parts.push(`${r.decision.kind}, decided by ${r.decision.decidedBy}`);
  if (r?.escalations) parts.push(`escalated ${r.escalations}x`);
  if (r?.classifier) {
    const said = r.classifier.classification?.tier ?? 'too slow';
    parts.push(`classifier: ${said} in ${Math.round(r.classifier.ms)} ms`);
  }
  if (t.latencyMiss) parts.push(`over the ${(t.latencyBudgetMs ?? 0) / 1000} s budget`);
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
    else if (event.type === 'voice_test') {
      // Settings window: listen once, report, answer nothing (VoiceLoop.testVoice).
      if (!loop.testVoice()) {
        bridge.send({
          type: 'voice_test_result',
          outcome: 'nothing',
          heard: '',
          text: '',
          sttMs: 0,
          detail: loop.state === 'MUTED' ? 'muted' : 'busy',
        });
      }
    } else if (event.type === 'quit') {
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
  instantMs: jarvis.latency.instantSeconds * 1000,
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

// Spoken approval goes to the voice loop: it asks, listens, and matches strictly.
opened.setApprover((request) => loop.approver.ask(request));

console.log(
  `Jarvis is ready. Brain: ${opened.brain}. Memory: ${opened.memory}. ${opened.skillCount} skills found.\n` +
    `Tools: ${opened.toolNames.join(', ') || 'none'}. Services: ${opened.services}. Files: ${opened.folders.join(', ') || 'off'}.${opened.dryRun ? ' DRY RUN: approved changes are only logged.' : ''}\n` +
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
  await Promise.allSettled([stt.close(), tts.close(), opened.close()]);
  console.log('Bye.');
  if (process.connected) process.disconnect?.(); // the supervisor's channel would keep us alive
}
