import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { addTurn, emptyDay, readUsage, UsageLog } from '@jarvis/core/usage';
import { yamlScalar } from '../packages/core/src/config/settings.ts';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'jarvis-usage-'));
  temps.push(d);
  return d;
};
const turn = (tier: 'simple' | 'standard' | 'complex', inT: number, outT: number) => ({
  firstAudioMs: 900,
  stopped: false,
  result: { tier, escalations: 0, usage: { inputTokens: inT, outputTokens: outT, toolCalls: 1 } },
});

describe('usage totals', () => {
  it('adds requests and tokens per model tier', () => {
    let day = emptyDay('2026-11-14');
    day = addTurn(day, turn('simple', 100, 20));
    day = addTurn(day, turn('complex', 1000, 300));
    day = addTurn(day, { firstAudioMs: null, stopped: true, command: 'stop' });
    assert.equal(day.requests, 2);
    assert.equal(day.commands, 1);
    assert.equal(day.stopped, 1);
    assert.equal(day.inputTokens, 1100);
    assert.equal(day.byTier.complex.outputTokens, 300);
    assert.equal(day.firstWordCount, 2);
  });

  it('stores numbers only, reads back with empty days filled, and prunes old days', () => {
    const dir = tempDir();
    const log = new UsageLog(dir, 30);
    const now = new Date(2026, 10, 14, 12);
    log.record({ ...turn('standard', 50, 5), heard: 'secret words' } as never, now);
    const file = path.join(dir, 'usage', '2026-11-14.json');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /secret/);
    const days = readUsage(dir, 3, now);
    assert.deepEqual(
      days.map((d) => d.date),
      ['2026-11-12', '2026-11-13', '2026-11-14'],
    );
    assert.equal(days[2]?.byTier.standard.requests, 1);

    const old = path.join(dir, 'usage', '2026-09-01.json');
    writeFileSync(old, '{}');
    log.prune(now);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(file), true);
  });

  it('treats a damaged file as zero instead of failing', () => {
    const dir = tempDir();
    const now = new Date(2026, 10, 14, 12);
    new UsageLog(dir, 30).record(turn('simple', 1, 1), now);
    writeFileSync(path.join(dir, 'usage', '2026-11-14.json'), '{"requests":"lots","byTier":5}');
    const [today] = readUsage(dir, 1, now);
    assert.equal(today?.requests, 0);
  });
});

describe('settings file writing', () => {
  it('writes plain words unquoted and anything risky quoted', () => {
    assert.equal(yamlScalar('windows'), 'windows');
    assert.equal(yamlScalar('Microsoft Zira Desktop'), 'Microsoft Zira Desktop');
    assert.equal(yamlScalar('yes'), '"yes"');
    assert.equal(yamlScalar('a: b # c'), '"a: b # c"');
    assert.equal(yamlScalar(null), 'null');
    assert.equal(yamlScalar(1.5), '1.5');
  });
});
