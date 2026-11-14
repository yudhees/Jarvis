/**
 * Shows what the Windows speech recognizer hears from your mic, to tune the
 * wake word. Say "Hey Jarvis", "Jarvis", and some ordinary sentences.
 *
 *   npm run wake-test               30 seconds
 *   npm run wake-test -- --gain 4   boost a quiet mic 4x before recognizing
 *   npm run wake-test -- --seconds 60
 */
import { Microphone, meterBar, rmsLevel, toDbfs, WindowsKeywordSpotter } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { intArg, scriptArgs } from './args.ts';

const args = scriptArgs({ gain: { type: 'string' }, seconds: { type: 'string' } });
const { jarvis } = loadConfig();
const gain = Number(args.gain ?? jarvis.keywords.gain);
const seconds = intArg(args.seconds, 'seconds', 30);

const spotter = new WindowsKeywordSpotter({
  sampleRate: jarvis.audio.sampleRate,
  minConfidence: jarvis.keywords.minConfidence,
  gain,
  debug: (line) => {
    if (line.startsWith('debug audio')) return;
    process.stdout.write(`\r${' '.repeat(70)}\r`);
    const shown = line.replace(/^debug speech at.*/, '(speech starts)');
    console.log(`  ${shown}`);
  },
});
await spotter.start();
console.log(
  `Listening for ${seconds} s (gain ${gain}x, min confidence ${jarvis.keywords.minConfidence}). ` +
    'Say "Hey Jarvis", "Jarvis", and an ordinary sentence. Ctrl+C stops.\n' +
    'Lines: "wake"/"stop" = it would react; "ignored" = heard but not a wake word.\n',
);
const mic = new Microphone(jarvis.audio.frameLength, jarvis.audio.inputDevice);
const controller = new AbortController();
setTimeout(() => controller.abort(), seconds * 1000);
let wakes = 0;
let loudest = -96;
let frames = 0;
for await (const frame of mic.frames(controller.signal)) {
  const hit = spotter.process(frame);
  if (hit?.keyword === 'wake') wakes++;
  const dbfs = toDbfs(rmsLevel(frame) * gain);
  loudest = Math.max(loudest, dbfs);
  if (++frames % 4 === 0) process.stdout.write(`\r${meterBar(dbfs)} ${dbfs.toFixed(1)} dBFS  `);
}
spotter.release();
console.log(`\n\nWake words: ${wakes}. Loudest (after gain): ${loudest.toFixed(1)} dBFS.`);
if (loudest < -30) console.log('Your mic is quiet. Try: npm run wake-test -- --gain 4');
