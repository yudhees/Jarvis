/**
 * Speech-to-text test.
 *
 *   npm run stt-test             Windows voice speaks sample requests, Whisper writes them down
 *   npm run stt-test -- --mic 5  record 5 seconds from your mic and show what Whisper heard
 *
 * Nothing is written to disk; audio stays in memory.
 */
import { Microphone, meterBar, rmsLevel, toDbfs } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { resolveWhisper, WhisperCppStt } from '@jarvis/core/stt';
import { WindowsSapiTts } from '@jarvis/core/tts';
import { intArg, scriptArgs } from './args.ts';

const args = scriptArgs({ mic: { type: 'string' } });
const { jarvis } = loadConfig();
const { serverExe, modelPath } = resolveWhisper(jarvis.dataDir, jarvis.stt.model);

/** Words Jarvis should expect; later these also come from the learner. */
const HINTS = ['Jarvis', 'Jira', 'Slack', 'MongoDB', 'GitHub', 'PROJ', 'Sonnet', 'Opus', 'Haiku'];

const stt = new WhisperCppStt({
  serverExe,
  modelPath,
  port: jarvis.stt.port,
  threads: jarvis.stt.threads,
  language: jarvis.stt.language,
});

/** Lowercase words without punctuation, for a fair comparison. */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

function wordAccuracy(expected: string, heard: string): number {
  const want = words(expected);
  const got = new Set(words(heard));
  return want.filter((w) => got.has(w)).length / want.length;
}

try {
  const t0 = performance.now();
  await stt.start();
  console.log(
    `Whisper ready in ${Math.round(performance.now() - t0)} ms (model ${jarvis.stt.model}).\n`,
  );

  if (args.mic !== undefined) {
    const seconds = intArg(args.mic, 'mic', 5);
    const mic = new Microphone(jarvis.audio.frameLength, jarvis.audio.inputDevice);
    const frames: Int16Array[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), seconds * 1000);
    for await (const frame of mic.frames(controller.signal, (name) =>
      console.log(
        `Recording ${seconds} s from "${name}". Say something like "move PROJ-142 to In Review".`,
      ),
    )) {
      frames.push(frame);
      process.stdout.write(`\r${meterBar(toDbfs(rmsLevel(frame)))}`);
    }
    const pcm = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) {
      pcm.set(f, o);
      o += f.length;
    }
    const r = await stt.transcribe(pcm, 16000, { hints: HINTS });
    console.log(`\n\nHeard (${r.ms} ms): ${r.text || '(nothing)'}`);
  } else {
    const samples = [
      'What time is it in Tokyo?',
      'Move PROJ-142 to In Review and tell the team on Slack.',
      'Create a Jira ticket for the login timeout.',
      'Why is the orders MongoDB query slow?',
      'Remind me to check the deploy in ten minutes.',
    ];
    const tts = new WindowsSapiTts({ voice: jarvis.voice.voice, rate: 0, timeoutMs: 20000 });
    let total = 0;
    try {
      for (const text of samples) {
        const speech = await tts.synthesize(text);
        const r = await stt.transcribe(speech.pcm, speech.sampleRate, { hints: HINTS });
        const acc = wordAccuracy(text, r.text);
        total += acc;
        const secs = (speech.pcm.length / speech.sampleRate).toFixed(1);
        console.log(`said:  ${text}`);
        console.log(`heard: ${r.text}`);
        console.log(
          `       ${Math.round(acc * 100)}% words right, ${r.ms} ms for ${secs} s of speech\n`,
        );
      }
    } finally {
      await tts.close();
    }
    console.log(`Average: ${Math.round((total / samples.length) * 100)}% of words right.`);
  }
} finally {
  await stt.close();
}
