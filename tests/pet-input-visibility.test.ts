import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Learner } from '@jarvis/core/learning';
import { InMemoryFiles } from '@jarvis/core/memory';
import { demoFinish, demoScript, demoTitleQuestion } from '../packages/pet/src/main/demo.ts';
import { cleanAnswer, parseCoreEvent } from '../packages/pet/src/main/events.ts';
import { DEFAULT_PREFS, parsePrefs, visibilityFor } from '../packages/pet/src/main/visibility.ts';

describe('pet visibility', () => {
  const on = DEFAULT_PREFS;
  const off = { ...DEFAULT_PREFS, hideWhenIdle: false };

  it('the wake word always brings the pet back, even after "Hide pet"', () => {
    assert.deepEqual(visibilityFor('LISTENING', true, on), {
      action: 'show',
      clearManualHide: true,
    });
    assert.deepEqual(visibilityFor('FOLLOW_UP', true, off), {
      action: 'show',
      clearManualHide: true,
    });
  });

  it('stays visible while waiting for an approval or an answer', () => {
    for (const s of ['AWAITING_APPROVAL', 'AWAITING_INPUT'] as const) {
      assert.equal(visibilityFor(s, true, on).action, 'show');
    }
  });

  it('respects a manual hide while busy or asleep', () => {
    assert.equal(visibilityFor('THINKING', true, on).action, 'hide');
    assert.equal(visibilityFor('SPEAKING', true, on).action, 'hide');
    assert.equal(visibilityFor('SLEEPING', true, off).action, 'hide');
  });

  it('auto-hides after the idle delay only when "Hide when idle" is on', () => {
    assert.deepEqual(visibilityFor('SLEEPING', false, on), { action: 'hide_later', afterMs: 8000 });
    assert.deepEqual(visibilityFor('MUTED', false, on), { action: 'hide_later', afterMs: 8000 });
    assert.equal(visibilityFor('SLEEPING', false, off).action, 'show');
    assert.equal(visibilityFor('THINKING', false, on).action, 'show');
  });

  it('reads saved settings defensively', () => {
    assert.deepEqual(parsePrefs(undefined), DEFAULT_PREFS);
    assert.deepEqual(parsePrefs({ hideWhenIdle: false, idleSeconds: 30 }), {
      hideWhenIdle: false,
      idleSeconds: 30,
    });
    assert.equal(parsePrefs({ idleSeconds: 0 }).idleSeconds, DEFAULT_PREFS.idleSeconds);
    assert.equal(parsePrefs({ hideWhenIdle: 'yes' }).hideWhenIdle, true);
  });
});

describe('questions shown in the pet', () => {
  const choice = {
    type: 'input_request',
    id: 'q1',
    question: 'Which project?',
    mode: 'choice',
    options: ['PROJ', 'WEB'],
  };

  it('accepts choice and text questions', () => {
    assert.ok(parseCoreEvent(choice));
    assert.ok(
      parseCoreEvent({ type: 'input_request', id: 'q2', question: 'Title?', mode: 'text' }),
    );
    assert.ok(parseCoreEvent({ type: 'input_closed', id: 'q1' }));
  });

  it('refuses malformed questions and anything asking for a secret', () => {
    const bad = [
      { ...choice, options: ['only one'] },
      { ...choice, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      { ...choice, options: ['ok', ''] },
      { ...choice, mode: 'text' }, // text questions have no options
      { ...choice, id: 'bad id with spaces' },
      { ...choice, question: 'What is your Jira password?' },
      { type: 'input_request', id: 'q3', question: 'Read me the one-time code', mode: 'text' },
      { type: 'input_request', id: 'q4', question: 'Paste your API key', mode: 'text' },
    ];
    for (const raw of bad) assert.equal(parseCoreEvent(raw), null, JSON.stringify(raw));
  });

  it('cleans answers before they go to core', () => {
    assert.deepEqual(cleanAnswer('q1', '  PROJ   Platform '), { id: 'q1', value: 'PROJ Platform' });
    assert.equal(cleanAnswer('q1', '   '), null);
    assert.equal(cleanAnswer('q1', 'x'.repeat(501)), null);
    assert.equal(cleanAnswer('../evil', 'ok'), null);
    assert.equal(cleanAnswer('q1', 42), null);
  });

  it('the demo asks twice, then asks for voice approval with the answers filled in', () => {
    const asks = demoScript().filter((s) => 'event' in s && s.event.type === 'input_request');
    assert.equal(asks.length, 1);
    const title = demoTitleQuestion('WEB · Website');
    assert.ok(title.some((s) => 'event' in s && s.event.type === 'input_request'));
    const finish = demoFinish('WEB · Website', 'Login times out');
    const approval = finish.find((s) => 'event' in s && s.event.type === 'approval_request');
    assert.ok(approval && 'event' in approval);
    assert.match(JSON.stringify(approval.event), /WEB.*Login times out/);
    for (const steps of [demoScript(), title, finish]) {
      for (const s of steps)
        if ('event' in s) assert.ok(parseCoreEvent(s.event), JSON.stringify(s.event));
    }
  });
});

describe('remembered answers (stop asking every time)', () => {
  it('offers a default after the same answer twice, then answers for the user', async () => {
    const learner = await Learner.open(new InMemoryFiles(), {
      enabled: true,
      aboutUserTokenCap: 300,
    });
    assert.equal(learner.defaultAnswer('jira.project'), undefined);
    assert.equal(
      await learner.observe({ type: 'answer', topic: 'jira.project', value: 'PROJ' }),
      undefined,
    );
    const p = await learner.observe({ type: 'answer', topic: 'jira.project', value: 'PROJ' });
    assert.ok(p);
    assert.match(p.question, /PROJ for the Jira project/);
    assert.match(await learner.answer(p.id, true), /without asking/);
    assert.equal(learner.defaultAnswer('jira.project'), 'PROJ');
  });

  it('different answers do not become a default, and a no is respected', async () => {
    const learner = await Learner.open(new InMemoryFiles(), {
      enabled: true,
      aboutUserTokenCap: 300,
    });
    await learner.observe({ type: 'answer', topic: 'jira.project', value: 'PROJ' });
    assert.equal(
      await learner.observe({ type: 'answer', topic: 'jira.project', value: 'WEB' }),
      undefined,
    );
    await learner.observe({ type: 'answer', topic: 'slack.channel', value: '#team' });
    const p = await learner.observe({ type: 'answer', topic: 'slack.channel', value: '#team' });
    assert.ok(p);
    await learner.answer(p.id, false);
    assert.equal(learner.defaultAnswer('slack.channel'), undefined);
    for (let i = 0; i < 3; i++) {
      assert.equal(
        await learner.observe({ type: 'answer', topic: 'slack.channel', value: '#team' }),
        undefined,
      );
    }
  });
});
