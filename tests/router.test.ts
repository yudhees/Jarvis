import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyKind,
  kindFromPhrase,
  type LearnedRouting,
  parseEscalation,
  parseModelCommand,
  type RequestKind,
  route,
  speedCue,
} from '@jarvis/core/router';

describe('classifyKind', () => {
  const cases: [string, RequestKind][] = [
    ['send a slack message to Priya', 'slack'],
    ['create a jira ticket for the login bug', 'jira'],
    ['review my pull request', 'github'],
    ['why does this python function throw', 'code'],
    ["what's on my calendar tomorrow", 'calendar'],
    ['turn the volume down', 'system'],
    ["what's the weather", 'web'],
    ['plan the migration to the new database', 'planning'],
    ['draft a thank you letter', 'writing'],
    ['what is 12 * 7', 'math'],
    ['how are you today', 'chat'],
  ];
  for (const [text, kind] of cases)
    it(`${text} -> ${kind}`, () => assert.equal(classifyKind(text), kind));

  it('maps phrases for learned rules', () => {
    assert.equal(kindFromPhrase('code questions'), 'code');
    assert.equal(kindFromPhrase('small talk'), 'chat');
    assert.equal(kindFromPhrase('stuff'), undefined);
  });
});

describe('parseModelCommand', () => {
  it('reads a forced model for this request', () => {
    assert.deepEqual(parseModelCommand('Jarvis, use Opus'), { tier: 'complex', rest: '' });
    assert.deepEqual(parseModelCommand('use sonnet to summarize the thread'), {
      tier: 'standard',
      rest: 'summarize the thread',
    });
  });
  it('leaves standing preferences to the learner', () => {
    assert.equal(parseModelCommand('use opus for code questions'), null);
    assert.equal(parseModelCommand('send the file'), null);
  });
});

describe('speedCue', () => {
  it('detects quick and take-your-time cues', () => {
    assert.equal(speedCue('quickly, what time is it'), 'instant');
    assert.equal(speedCue('take your time and research flights'), 'background');
    assert.equal(speedCue('summarize the doc'), undefined);
  });
});

describe('route', () => {
  const learned = new Map<RequestKind, LearnedRouting>([['code', { tier: 'complex' }]]);

  it('forced model wins over everything', () => {
    const d = route({ text: 'fix this bug', forced: 'simple', learned });
    assert.equal(d.tier, 'simple');
    assert.equal(d.decidedBy, 'forced');
  });

  it('applies what the user taught for that kind', () => {
    const d = route({ text: 'help me debug this python function please', learned });
    assert.deepEqual([d.kind, d.tier, d.decidedBy], ['code', 'complex', 'learned']);
  });

  it('follow-ups keep the tier, but a learned higher tier still applies', () => {
    assert.equal(route({ text: 'and the next one', followUpTier: 'standard' }).tier, 'standard');
    const d = route({ text: 'now debug the function', followUpTier: 'standard', learned });
    assert.equal(d.tier, 'complex');
  });

  it('never lowers a follow-up below the conversation tier', () => {
    const lower = new Map<RequestKind, LearnedRouting>([['code', { tier: 'simple' }]]);
    assert.equal(
      route({ text: 'debug it', followUpTier: 'complex', learned: lower }).tier,
      'complex',
    );
  });

  it('short chat with no task verb is simple and instant', () => {
    const d = route({ text: 'how are you' });
    assert.deepEqual([d.tier, d.speed, d.decidedBy], ['simple', 'instant', 'estimate']);
    assert.equal(d.needsClassifier, false);
  });

  // Haiku first, then climb only on evidence (CLAUDE.md 7).
  const ladder: [string, 'simple' | 'standard' | 'complex'][] = [
    ['what time is it in Tokyo', 'simple'],
    ["what's the weather tomorrow", 'simple'],
    ['turn the volume down a bit', 'simple'],
    ['what is 12 times 7', 'simple'],
    ['send a slack message to Priya saying I am running late', 'standard'],
    ['create a jira ticket for the broken login page', 'standard'],
    ["what's on my calendar tomorrow", 'standard'],
    ['draft a thank you letter to the team', 'standard'],
    ['debug why the login service times out under load and find the root cause', 'complex'],
    ['plan the migration of our billing database to postgres step by step', 'complex'],
    ['review the pull request for the payment refactor and compare the trade-offs', 'complex'],
  ];
  for (const [text, tier] of ladder) {
    it(`ladder: "${text}" -> ${tier}`, () => assert.equal(route({ text }).tier, tier));
  }

  it('flags unsure estimates for the Haiku classifier, never lowering them', () => {
    const d = route({ text: 'can you help me with this python function' });
    assert.equal(d.kind, 'code');
    assert.equal(d.tier, 'standard');
    assert.equal(d.needsClassifier, true);
  });

  it('every decision carries a reason', () => {
    for (const [text] of ladder) assert.ok(route({ text }).reason.length > 0);
  });

  it('a spoken cue beats a learned speed', () => {
    const slow = new Map<RequestKind, LearnedRouting>([['web', { speed: 'background' }]]);
    const d = route({ text: 'quick, search the news', learned: slow });
    assert.deepEqual([d.speed, d.speedFrom], ['instant', 'cue']);
    assert.equal(
      route({ text: 'search the news about rockets', learned: slow }).speed,
      'background',
    );
  });
});

describe('parseEscalation', () => {
  it('detects a small model asking for a bigger one', () => {
    assert.deepEqual(parseEscalation('[[ESCALATE: needs multi-step planning]] '), {
      reason: 'needs multi-step planning',
    });
    assert.ok(parseEscalation('[[escalate]]'));
  });
  it('ignores normal replies, including ones that mention escalation later', () => {
    assert.equal(parseEscalation('It is 3 p.m. in Tokyo.'), null);
    assert.equal(parseEscalation('I would not [[ESCALATE]] this.'), null);
  });
});
