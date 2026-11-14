import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { meterBar, rmsLevel, SILENCE_DBFS, toDbfs } from '@jarvis/core/audio';

describe('rmsLevel', () => {
  it('is 0 for silence and empty ranges', () => {
    assert.equal(rmsLevel(new Int16Array(100)), 0);
    assert.equal(rmsLevel(new Int16Array(0)), 0);
    assert.equal(rmsLevel(new Int16Array([1000, 1000]), 5, 2), 0);
  });

  it('is about 1 for a full-scale square wave', () => {
    const pcm = Int16Array.from({ length: 100 }, (_, i) => (i % 2 ? 32767 : -32768));
    assert.ok(Math.abs(rmsLevel(pcm) - 1) < 0.001);
  });

  it('clamps the range to the buffer', () => {
    const pcm = new Int16Array([16384, 16384]);
    assert.ok(Math.abs(rmsLevel(pcm, -10, 99) - 0.5) < 0.001);
  });
});

describe('toDbfs', () => {
  it('maps 1 to 0 dBFS, 0.5 to about -6, and 0 to the floor', () => {
    assert.equal(toDbfs(1), 0);
    assert.ok(Math.abs(toDbfs(0.5) + 6.02) < 0.01);
    assert.equal(toDbfs(0), SILENCE_DBFS);
  });
});

describe('meterBar', () => {
  it('is empty at -60 dBFS and full at 0', () => {
    assert.ok(meterBar(-60, 10).startsWith('[..........]'));
    assert.ok(meterBar(0, 10).startsWith('[##########]'));
  });
});
