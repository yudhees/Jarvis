/**
 * Speech-to-text test.
 *
 *   npm run stt-test             Windows voice speaks sample requests, Whisper writes them down
 *   npm run stt-test -- --mic 5  record 5 seconds from your mic and show what Whisper heard
 *   npm run stt-test -- --noise 5     add room noise 5 dB below the speech, with 1 s of
 *                                     noise alone before and after (where Whisper invents words)
 *   npm run stt-test -- --plain       ignore the stt.vad / beamSize / suppressNonSpeech settings
 *   npm run stt-test -- --beam 1      try another beam size than stt.beamSize
 *
 * Nothing is written to disk; audio stays in memory.
 */
import { Microphone, meterBar, rmsLevel, toDbfs } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { resolveWhisper, serverArgs, WhisperCppStt } from '@jarvis/core/stt';
import { WindowsSapiTts } from '@jarvis/core/tts';
import { intArg, scriptArgs } from './args.ts';

const args = scriptArgs({
  mic: { type: 'string' },
  noise: { type: 'string' },
  plain: { type: 'boolean' },
  beam: { type: 'string' },
  'vad-model': { type: 'string' },
});
const { jarvis } = loadConfig();
const plain = args.plain === true;
const { serverExe, modelPath, vadModelPath } = resolveWhisper(jarvis.dataDir, jarvis.stt.model, {
  vad: !plain && jarvis.stt.vad,
});

/** Words Jarvis should expect; later these also come from the learner. */
const HINTS = ['Jarvis', 'Jira', 'Slack', 'MongoDB', 'GitHub', 'PROJ', 'Sonnet', 'Opus', 'Haiku'];

const stt = new WhisperCppStt({
  serverExe,
  modelPath,
  port: jarvis.stt.port + 1, // its own server, never a running Jarvis's (different settings)
  threads: jarvis.stt.threads,
  language: jarvis.stt.language,
  vadModelPath: typeof args['vad-model'] === 'string' ? args['vad-model'] : vadModelPath,
  beamSize: plain
    ? 1
    : args.beam !== undefined
      ? intArg(args.beam, 'beam', 1)
      : jarvis.stt.beamSize,
  suppressNonSpeech: !plain && jarvis.stt.suppressNonSpeech,
});

/**
 * Mixes in steady room noise (pink-ish: fan, traffic, hum) `snrDb` below the
 * speech level, with 1 s of noise alone before and after.
 */
function addNoise(speech: Int16Array, sampleRate: number, snrDb: number): Int16Array {
  const pad = sampleRate;
  const out = new Int16Array(speech.length + pad * 2);
  let speechPower = 0;
  for (const s of speech) speechPower += s * s;
  const speechRms = Math.sqrt(speechPower / speech.length);
  const noiseRms = speechRms / 10 ** (snrDb / 20);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  let low = 0;
  const raw = new Float32Array(out.length);
  let power = 0;
  for (let i = 0; i < out.length; i++) {
    low = 0.97 * low + rand(); // low-pass: rumbly, like a fan
    const hum = 0.3 * Math.sin((2 * Math.PI * 100 * i) / sampleRate);
    const v = low + rand() * 0.5 + hum;
    raw[i] = v;
    power += v * v;
  }
  const scale = noiseRms / Math.sqrt(power / raw.length);
  for (let i = 0; i < out.length; i++) {
    const s = i >= pad && i < pad + speech.length ? (speech[i - pad] ?? 0) : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s + (raw[i] ?? 0) * scale)));
  }
  return out;
}
const noiseDb = args.noise === undefined ? undefined : Number(args.noise);
if (noiseDb !== undefined && !Number.isFinite(noiseDb)) {
  console.error('--noise needs a number of dB, like --noise 5');
  process.exit(2);
}
console.log(`whisper-server ${serverArgs(stt.options).slice(12).join(' ') || '(plain)'}`);
if (noiseDb !== undefined) console.log(`Noise ${noiseDb} dB below the speech.`);

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
    let extra = 0;
    try {
      // Noise alone: the right answer is nothing at all.
      if (noiseDb !== undefined) {
        const r = await stt.transcribe(addNoise(new Int16Array(16000), 16000, noiseDb), 16000, {
          hints: HINTS,
        });
        console.log(`noise only, heard: ${r.text || '(nothing, correct)'}\n`);
        extra += words(r.text).length;
      }
      for (const text of samples) {
        const speech = await tts.synthesize(text);
        const pcm =
          noiseDb === undefined ? speech.pcm : addNoise(speech.pcm, speech.sampleRate, noiseDb);
        const r = await stt.transcribe(pcm, speech.sampleRate, { hints: HINTS });
        const acc = wordAccuracy(text, r.text);
        total += acc;
        extra += Math.max(0, words(r.text).length - words(text).length);
        const secs = (pcm.length / speech.sampleRate).toFixed(1);
        console.log(`said:  ${text}`);
        console.log(`heard: ${r.text}`);
        console.log(
          `       ${Math.round(acc * 100)}% words right, ${r.ms} ms for ${secs} s of speech\n`,
        );
      }
    } finally {
      await tts.close();
    }
    console.log(
      `Average: ${Math.round((total / samples.length) * 100)}% of words right, ${extra} extra words heard.`,
    );
  }
} finally {
  await stt.close();
}
