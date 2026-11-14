import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  CONVERSATION_GAP_MS,
  HistoryLog,
  type HistorySource,
  historyToJsonl,
  readHistory,
  redactSecrets,
  toHistoryTurn,
} from '@jarvis/core/usage';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'jarvis-history-'));
  temps.push(d);
  return d;
};

const answered = (heard: string, reply: string): HistorySource => ({
  heard,
  raw: `Hey Jarvis, ${heard}`,
  sttMs: 900,
  firstAudioMs: 1500,
  totalMs: 3000,
  stopped: false,
  result: {
    reply,
    tier: 'simple',
    model: 'claude-haiku-5-5',
    decision: { speed: 'instant', decidedBy: 'estimate', kind: 'chat' },
    escalations: 0,
    usage: { inputTokens: 100, outputTokens: 20, toolCalls: 0 },
  },
});

describe('conversation history', () => {
  it('keeps what was heard, the reply, the model and the timings', () => {
    const t = toHistoryTurn(answered('what time is it', 'It is ten past three.'));
    assert.equal(t.outcome, 'answered');
    assert.equal(t.heard, 'Hey Jarvis, what time is it');
    assert.equal(t.text, 'what time is it');
    assert.equal(t.reply, 'It is ten past three.');
    assert.equal(t.model, 'claude-haiku-5-5');
    assert.equal(t.decidedBy, 'estimate');
    assert.equal(t.firstWordMs, 1500);
    assert.equal(t.inputTokens, 100);
  });

  it('marks failures, stops and spoken commands', () => {
    const failed = toHistoryTurn({ ...answered('hi', ''), result: undefined, error: 'CLI died' });
    assert.equal(failed.outcome, 'error');
    assert.equal(failed.error, 'CLI died');
    assert.equal(toHistoryTurn({ ...answered('hi', 'Hel'), stopped: true }).outcome, 'stopped');
    const mute = toHistoryTurn({ ...answered('mute', ''), result: undefined, command: 'mute' });
    assert.equal(mute.outcome, 'command');
    assert.equal(mute.command, 'mute');
  });

  it('blanks keys, tokens, spoken passwords and card numbers', () => {
    assert.equal(redactSecrets('my password is hunter2 ok'), 'my password is [removed] ok');
    assert.equal(redactSecrets('use sk-ant-abcdefghijklmnop1234'), 'use [removed]');
    assert.equal(redactSecrets('card 4111 1111 1111 1111 please'), 'card [removed] please');
    assert.equal(redactSecrets('call 555 123 4567 at 3'), 'call 555 123 4567 at 3');
    const t = toHistoryTurn(answered('the api key is ghp_abcdefghijklmnopqrstuvwx', 'ok'));
    assert.doesNotMatch(JSON.stringify(t), /ghp_/);
  });

  it('groups turns into conversations and reads the newest first', () => {
    const dir = tempDir();
    const log = new HistoryLog(dir, 30);
    const base = new Date(2026, 10, 14, 9, 0, 0);
    const at = (ms: number) => new Date(base.getTime() + ms);
    log.record(answered('first question', 'one'), at(0));
    log.record(answered('follow up', 'two'), at(10_000));
    log.record(answered('much later', 'three'), at(10_000 + CONVERSATION_GAP_MS + 60_000));
    const all = readHistory(dir, null);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.turns[0]?.text, 'much later');
    assert.deepEqual(
      all[1]?.turns.map((t) => t.text),
      ['first question', 'follow up'],
    );
    assert.equal(readHistory(dir, 1).length, 1);
  });

  it('reads the last N across days and skips damaged lines', () => {
    const dir = tempDir();
    const log = new HistoryLog(dir, 30);
    for (let day = 1; day <= 12; day++) {
      log.record(answered(`day ${day}`, 'ok'), new Date(2026, 10, day, 12));
    }
    appendFileSync(path.join(dir, 'history', '2026-11-12.jsonl'), '{"broken\n{"at":1}\n');
    const recent = readHistory(dir, 10);
    assert.equal(recent.length, 10);
    assert.equal(recent[0]?.turns[0]?.text, 'day 12');
    assert.equal(recent[9]?.turns[0]?.text, 'day 3');
  });

  it('deletes whole days past the retention period', () => {
    const dir = tempDir();
    const log = new HistoryLog(dir, 30);
    log.record(answered('old', 'x'), new Date(2026, 8, 1, 12));
    log.record(answered('new', 'y'), new Date(2026, 10, 14, 12));
    log.prune(new Date(2026, 10, 14, 13));
    assert.equal(existsSync(path.join(dir, 'history', '2026-09-01.jsonl')), false);
    assert.equal(existsSync(path.join(dir, 'history', '2026-11-14.jsonl')), true);
  });

  it('exports one conversation per line as chat messages plus details', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'history'), { recursive: true });
    const log = new HistoryLog(dir, 30);
    log.record(answered('two plus two', 'Four.'), new Date(2026, 10, 14, 9));
    const lines = historyToJsonl(readHistory(dir, null)).trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0] ?? '');
    assert.deepEqual(row.messages, [
      { role: 'user', content: 'two plus two' },
      { role: 'assistant', content: 'Four.' },
    ]);
    assert.equal(row.turns[0].model, 'claude-haiku-5-5');
    assert.match(readFileSync(path.join(dir, 'history', '2026-11-14.jsonl'), 'utf8'), /Four/);
  });
});
