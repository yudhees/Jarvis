import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '@jarvis/core/config';
import { Learner } from '@jarvis/core/learning';
import { InMemoryFiles } from '@jarvis/core/memory';
import {
  type Classification,
  type Classifier,
  classifyWithin,
  parseClassification,
  RequestLog,
  type RequestRecord,
  route,
} from '@jarvis/core/router';
import {
  Conversation,
  type ModelRequest,
  type ReplyModel,
  ReplyModelClassifier,
} from '@jarvis/core/voice';
import type { ModelTier, Speed } from '@jarvis/shared';

const { models } = loadConfig();
const SAMPLES = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'router.samples.json'), 'utf8'),
) as { text: string; tier: ModelTier; speed: Speed }[];

describe('router samples (phase 2 done-when)', () => {
  it('routes at least 27 of the 30 samples right (tier and speed)', () => {
    assert.equal(SAMPLES.length, 30);
    const misses = SAMPLES.filter((s) => {
      const d = route({ text: s.text });
      return d.tier !== s.tier || d.speed !== s.speed;
    }).map((s) => {
      const d = route({ text: s.text });
      return `${s.text}: want ${s.tier}/${s.speed}, got ${d.tier}/${d.speed}`;
    });
    assert.ok(misses.length <= 3, `misses:\n${misses.join('\n')}`);
  });
});

/** Says the same thing every time; records what it was asked. */
class FakeModel implements ReplyModel {
  readonly requests: ModelRequest[] = [];
  readonly #reply: (req: ModelRequest) => string;
  constructor(reply: (req: ModelRequest) => string = () => 'Okay.') {
    this.#reply = reply;
  }
  async stream(req: ModelRequest, onText: (d: string) => void) {
    this.requests.push(req);
    onText(this.#reply(req));
    return { inputTokens: 1, outputTokens: 1, toolCalls: 0 };
  }
}

class SpyClassifier implements Classifier {
  calls: string[] = [];
  readonly #answer: Classification | null;
  readonly #delayMs: number;
  constructor(answer: Classification | null, delayMs = 0) {
    this.#answer = answer;
    this.#delayMs = delayMs;
  }
  async classify(text: string) {
    this.calls.push(text);
    if (this.#delayMs) await new Promise((r) => setTimeout(r, this.#delayMs));
    return this.#answer;
  }
}

const learner = () => Learner.open(new InMemoryFiles(), { enabled: false, aboutUserTokenCap: 300 });

describe('the Haiku classifier (rule 4)', () => {
  it('is never called for requests the rules are sure about, and only once otherwise', async () => {
    for (const s of SAMPLES) {
      const spy = new SpyClassifier({ tier: 'complex', needsTools: false, reason: 'x' });
      const c = new Conversation({
        model: new FakeModel(),
        models,
        learner: await learner(),
        classifier: spy,
      });
      await c.ask(s.text, { onSentence: () => {} });
      const unsure = route({ text: s.text }).needsClassifier;
      assert.equal(spy.calls.length, unsure ? 1 : 0, `${s.text} (unsure: ${unsure})`);
    }
  });

  it('may raise the tier, and the reply then comes from the bigger model', async () => {
    const spy = new SpyClassifier({
      tier: 'complex',
      needsTools: false,
      reason: 'needs real debugging',
    });
    const model = new FakeModel();
    const c = new Conversation({ model, models, learner: await learner(), classifier: spy });
    const r = await c.ask('why does this regex not match dates', { onSentence: () => {} });
    assert.equal(r.decision?.decidedBy, 'classifier');
    assert.equal(r.tier, 'complex');
    assert.equal(model.requests[0]?.model, models.tiers.complex);
    assert.match(r.decision?.reason ?? '', /needs real debugging/);
  });

  it('never lowers the estimate', async () => {
    const out = await classifyWithin(
      new SpyClassifier({ tier: 'simple', needsTools: false, reason: '' }),
      'x',
      'standard',
      500,
    );
    assert.equal(out.tier, 'standard');
    assert.equal(out.raised, false);
  });

  it('too slow (over 1.5 s) or invalid: the estimate stands', async () => {
    const slow = await classifyWithin(
      new SpyClassifier({ tier: 'complex', needsTools: false, reason: '' }, 300),
      'x',
      'standard',
      50,
    );
    assert.deepEqual([slow.tier, slow.classification], ['standard', null]);
    const invalid = await classifyWithin(new SpyClassifier(null), 'x', 'standard', 500);
    assert.equal(invalid.tier, 'standard');
  });

  it('reads only the JSON it asked for', () => {
    assert.deepEqual(
      parseClassification('{"tier":"complex","needs_tools":true,"reason":"many steps"}'),
      {
        tier: 'complex',
        needsTools: true,
        reason: 'many steps',
      },
    );
    assert.equal(parseClassification('```json\n{"tier":"simple"}\n```')?.tier, 'simple');
    assert.equal(parseClassification('{"tier":"huge"}'), null);
    assert.equal(parseClassification('I think it is complex'), null);
  });

  it('runs on any reply model, on its own (no conversation context mixed in)', async () => {
    const model = new FakeModel(() => '{"tier":"standard","needs_tools":false,"reason":"code"}');
    const k = new ReplyModelClassifier(model, models.classifier);
    assert.equal((await k.classify('write a regex'))?.tier, 'standard');
    await k.classify('fix this bug');
    const second = model.requests[1];
    assert.equal(second?.model, models.classifier);
    assert.match(second?.system ?? '', /JSON only/);
    assert.equal(second?.context, '');
    assert.equal(second?.messages.length, 3, 'keeps its own short history so a warm CLI is reused');
  });
});

describe('RequestLog (rule 7)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-routing-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const record: RequestRecord = {
    at: '2026-11-14T10:00:00Z',
    kind: 'math',
    words: 4,
    tier: 'simple',
    speed: 'instant',
    model: 'claude-haiku-5-5',
    decidedBy: 'estimate',
    escalations: 0,
    sttMs: 900,
    firstWordMs: 2100,
    totalMs: 4000,
    latencyBudgetMs: 2000,
    latencyMiss: true,
    inputTokens: 10,
    outputTokens: 5,
    lookups: 0,
    stopped: false,
  };

  it('writes one JSON line per request, per day, with no words from the request', () => {
    const log = new RequestLog(dir, 30, () => new Date(2026, 10, 14, 12));
    log.write(record);
    log.write({ ...record, kind: 'jira' });
    const lines = readFileSync(path.join(dir, '2026-11-14.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] ?? '{}').latencyMiss, true);
    assert.ok(!('text' in JSON.parse(lines[0] ?? '{}')));
  });

  it('deletes whole days older than the retention', () => {
    writeFileSync(path.join(dir, '2026-09-01.jsonl'), '{}\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'not a log');
    new RequestLog(dir, 30, () => new Date(2026, 10, 14, 12));
    const left = readdirSync(dir).sort();
    assert.deepEqual(left, ['2026-11-14.jsonl', 'notes.txt']);
  });
});
