import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { encodeWav } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import {
  cleanTranscript,
  installFile,
  resolveWhisper,
  serverArgs,
  VAD_MODEL,
  WhisperCppStt,
} from '@jarvis/core/stt';
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

describe('serverArgs', () => {
  const base = {
    serverExe: 'whisper-server.exe',
    modelPath: 'm.bin',
    port: 8178,
    threads: 4,
    language: 'en',
  };
  it('binds to 127.0.0.1 and adds nothing extra by default', () => {
    const args = serverArgs(base);
    assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
    for (const flag of ['--vad', '-bs', '-sns']) assert.ok(!args.includes(flag), flag);
    assert.ok(!serverArgs({ ...base, beamSize: 1 }).includes('-bs'), 'beam 1 is greedy');
  });
  it('turns on VAD with padding, beam search and non-speech suppression', () => {
    const args = serverArgs({
      ...base,
      vadModelPath: 'vad.bin',
      beamSize: 5,
      suppressNonSpeech: true,
    });
    assert.equal(args[args.indexOf('-vm') + 1], 'vad.bin');
    assert.ok(args.includes('--vad'));
    assert.ok(Number(args[args.indexOf('-vp') + 1]) >= 100, 'pad keeps the first sound');
    assert.equal(args[args.indexOf('-bs') + 1], '5');
    assert.ok(args.includes('-sns'));
  });
});

describe('resolveWhisper with VAD', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-stt-'));
  mkdirSync(path.join(dir, 'whisper'));
  mkdirSync(path.join(dir, 'models'));
  const server = path.join(dir, 'whisper-server.exe');
  writeFileSync(server, '');
  writeFileSync(path.join(dir, 'models', 'm.bin'), '');
  writeFileSync(installFile(dir), JSON.stringify({ build: 'x', server, cli: server }));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('works without the VAD model and says how to get it', () => {
    const r = resolveWhisper(dir, 'm.bin', { vad: true });
    assert.equal(r.vadModelPath, undefined);
    assert.match(r.vadMissing ?? '', /setup-whisper/);
  });
  it('finds the VAD model once it is installed, and ignores it when VAD is off', () => {
    const vad = path.join(dir, 'models', VAD_MODEL.file);
    writeFileSync(vad, '');
    assert.equal(resolveWhisper(dir, 'm.bin', { vad: true }).vadModelPath, vad);
    assert.equal(resolveWhisper(dir, 'm.bin').vadModelPath, undefined);
  });
});

const { jarvis } = loadConfig();
const installed = existsSync(installFile(jarvis.dataDir));
const vadInstalled = installed && existsSync(path.join(jarvis.dataDir, 'models', VAD_MODEL.file));

describe('WhisperCppStt with VAD (live)', {
  skip: !vadInstalled || process.platform !== 'win32',
}, () => {
  it('hears nothing in steady background noise', async () => {
    const { serverExe, modelPath, vadModelPath } = resolveWhisper(
      jarvis.dataDir,
      jarvis.stt.model,
      { vad: true },
    );
    const stt = new WhisperCppStt({
      serverExe,
      modelPath,
      vadModelPath,
      port: jarvis.stt.port + 8,
      threads: jarvis.stt.threads,
      language: 'en',
    });
    try {
      const noise = new Int16Array(48000);
      let low = 0;
      let seed = 1;
      for (let i = 0; i < noise.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        low = 0.97 * low + (seed / 0x7fffffff - 0.5);
        noise[i] = Math.round((low + 0.3 * Math.sin((2 * Math.PI * 100 * i) / 16000)) * 800);
      }
      assert.equal((await stt.transcribe(noise, 16000)).text, '');
    } finally {
      await stt.close();
    }
  });
});

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
