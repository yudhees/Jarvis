import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { WindowsSapiTts } from '@jarvis/core/tts';

// Spawns Windows PowerShell; the voice is synthesized to memory, nothing is played.
describe('WindowsSapiTts', { skip: process.platform !== 'win32' }, () => {
  const tts = new WindowsSapiTts({ voice: null, rate: 0, timeoutMs: 20000 });
  after(() => tts.close());

  it('lists at least one voice', async () => {
    assert.ok((await tts.voices()).length > 0);
  });

  it('returns 16 kHz PCM of a plausible length', async () => {
    const audio = await tts.synthesize('Testing one two three.');
    assert.equal(audio.sampleRate, 16000);
    const secs = audio.pcm.length / audio.sampleRate;
    assert.ok(secs > 0.5 && secs < 10, `unexpected duration ${secs}s`);
    assert.ok(
      audio.pcm.some((s) => s !== 0),
      'audio should not be silent',
    );
  });

  it('handles non-ASCII text', async () => {
    const audio = await tts.synthesize('Café at 9:30 — résumé.');
    assert.ok(audio.pcm.length > 0);
  });

  it('returns empty audio for empty text without calling the host', async () => {
    assert.equal((await tts.synthesize('   ')).pcm.length, 0);
  });

  it('reports an unknown voice as an error and keeps working', async () => {
    const bad = new WindowsSapiTts({ voice: 'No Such Voice', rate: 0, timeoutMs: 20000 });
    try {
      await assert.rejects(bad.synthesize('hello'), /TTS failed/);
    } finally {
      await bad.close();
    }
    assert.ok((await tts.synthesize('Still fine.')).pcm.length > 0);
  });

  it('rejects at once when aborted', async () => {
    const controller = new AbortController();
    const pending = tts.synthesize(
      'This sentence is long enough to still be working.',
      controller.signal,
    );
    controller.abort(new Error('stop'));
    await assert.rejects(pending, /stop/);
  });
});
