/**
 * Mic test: prints live volume levels from the microphone.
 *
 *   npm run mic-test                    10 seconds on the configured device
 *   npm run mic-test -- --seconds 30
 *   npm run mic-test -- --device 2      use device index 2
 *   npm run mic-test -- --list          list input devices
 */
import { Microphone, meterBar, rmsLevel, SILENCE_DBFS, toDbfs } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { intArg, scriptArgs } from './args.ts';

const args = scriptArgs({ seconds: { type: 'string' } });
if (args.help) {
  console.log('Usage: npm run mic-test -- [--seconds N] [--device N] [--list]');
  process.exit(0);
}
if (args.list) {
  Microphone.devices().forEach((name, i) => {
    console.log(`${i}: ${name}`);
  });
  process.exit(0);
}

const { audio } = loadConfig().jarvis;
const seconds = intArg(args.seconds, 'seconds', 10);
const device = intArg(args.device, 'device', audio.inputDevice);
const mic = new Microphone(audio.frameLength, device);

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
setTimeout(() => controller.abort(), seconds * 1000);

const frameMs = (audio.frameLength / audio.sampleRate) * 1000;
const printEveryFrames = Math.max(1, Math.round(100 / frameMs));
let frames = 0;
let peakDbfs = SILENCE_DBFS;
let windowMax = 0;

for await (const frame of mic.frames(controller.signal, (name) => {
  console.log(
    `Listening on "${name}" for ${seconds} s. Speak, clap, or tap the mic. Ctrl+C stops.`,
  );
})) {
  frames++;
  windowMax = Math.max(windowMax, rmsLevel(frame));
  if (frames % printEveryFrames === 0) {
    const db = toDbfs(windowMax);
    peakDbfs = Math.max(peakDbfs, db);
    process.stdout.write(`\r${meterBar(db)}`);
    windowMax = 0;
  }
}

console.log(`\n\nRead ${frames} frames. Loudest: ${peakDbfs.toFixed(1)} dBFS.`);
if (peakDbfs < -50) {
  console.log(
    'That is very quiet. Check the mic is not muted and the right device is selected (--list).',
  );
  process.exitCode = 1;
} else {
  console.log('Mic OK.');
}
