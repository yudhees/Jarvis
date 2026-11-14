import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { encodeWav } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { cleanTranscript, installFile, resolveWhisper, WhisperCppStt } from '@jarvis/core/stt';
import { WindowsSapiTts } from '@jarvis/core/tts';

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono 16-bit header and the samples', () => {
    const wav = encodeWav(Int16Array.from([0, 1000, -1000]), 16000);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 6);
    assert.equal(wav.readInt16LE(46), 1000);
    assert.equal(wav.length, 50);
  });
});

describe('cleanTranscript', () => {
  it('removes Whisper non-speech markers', () => {
    assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
    assert.equal(cleanTranscript('(silence) Hello  there [MUSIC]'), 'Hello there');
    assert.equal(cleanTranscript('*coughs* Move the ticket'), 'Move the ticket');
    assert.equal(cleanTranscript('(speaking in foreign language)'), '');
  });
});

const { jarvis } = loadConfig();
const installed = existsSync(installFile(jarvis.dataDir));

// Runs the real local model; skipped until `npm run setup-whisper` has run.
describe('WhisperCppStt (live)', { skip: !installed || process.platform !== 'win32' }, () => {
  it('hears the Windows voice, and unloads itself when idle', async () => {
    const { serverExe, modelPath } = resolveWhisper(jarvis.dataDir, jarvis.stt.model);
    const stt = new WhisperCppStt({
      serverExe,
      modelPath,
      port: jarvis.stt.port + 7, // avoid clashing with a running Jarvis
      threads: jarvis.stt.threads,
      language: 'en',
      idleStopMs: 800,
    });
    const tts = new WindowsSapiTts({ voice: null, rate: 0, timeoutMs: 20000 });
    try {
      const speech = await tts.synthesize('Create a Jira ticket for the login timeout.');
      const r = await stt.transcribe(speech.pcm, speech.sampleRate, { hints: ['Jira'] });
      assert.match(r.text, /jira ticket/i);
      assert.match(r.text, /login timeout/i);
      assert.equal(stt.running, true);
      await new Promise((res) => setTimeout(res, 1500));
      assert.equal(stt.running, false, 'the model should be unloaded after the idle time');
      assert.equal(
        (await stt.transcribe(new Int16Array(100), 16000)).text,
        '',
        'too short to hear',
      );
    } finally {
      await tts.close();
      await stt.close();
    }
  });
});
