/**
 * Speaker test: synthesizes a sentence with the configured voice and plays it
 * through core's playback (the same path Jarvis will use to speak).
 *
 *   npm run speaker-test
 *   npm run speaker-test -- --text "Something else"
 *   npm run speaker-test -- --voice "Microsoft Zira Desktop"
 *   npm run speaker-test -- --device 1
 *   npm run speaker-test -- --list      list output devices and voices
 */
import { meterBar, PvSpeakerPlayer, toDbfs } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { WindowsSapiTts } from '@jarvis/core/tts';
import { intArg, scriptArgs } from './args.ts';

const args = scriptArgs({ text: { type: 'string' }, voice: { type: 'string' } });
if (args.help) {
  console.log('Usage: npm run speaker-test -- [--text "..."] [--voice NAME] [--device N] [--list]');
  process.exit(0);
}

const { audio, voice } = loadConfig().jarvis;
const tts = new WindowsSapiTts({
  voice: typeof args.voice === 'string' ? args.voice : voice.voice,
  rate: voice.rate,
  timeoutMs: voice.requestTimeoutSeconds * 1000,
});

try {
  if (args.list) {
    console.log('Output devices:');
    PvSpeakerPlayer.devices().forEach((name, i) => {
      console.log(`  ${i}: ${name}`);
    });
    console.log('Voices:');
    for (const name of await tts.voices()) console.log(`  ${name}`);
    process.exit(0);
  }

  const text =
    typeof args.text === 'string'
      ? args.text
      : 'Hello. This is Jarvis. If you can hear this, the speakers are working.';
  const player = new PvSpeakerPlayer(intArg(args.device, 'device', audio.outputDevice));

  const t0 = performance.now();
  await tts.voices(); // start the host, so the next number is the per-reply cost
  const t1 = performance.now();
  const speech = await tts.synthesize(text);
  const t2 = performance.now();
  const secs = speech.pcm.length / speech.sampleRate;
  console.log(`Voice host start: ${Math.round(t1 - t0)} ms (once per run)`);
  console.log(`Synthesis: ${Math.round(t2 - t1)} ms for ${secs.toFixed(1)} s of audio`);
  console.log(`Saying: "${text}"`);

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  let loudest = 0;
  const result = await player.play(speech.pcm, speech.sampleRate, {
    signal: controller.signal,
    onLevel: (level) => {
      loudest = Math.max(loudest, level);
      process.stdout.write(`\r${meterBar(toDbfs(level))}`);
    },
  });
  console.log(`\n\nPlayback ${result}. Loudest: ${toDbfs(loudest).toFixed(1)} dBFS.`);
  if (result === 'done') console.log('Speaker OK if you heard the sentence.');
} finally {
  await tts.close();
}
