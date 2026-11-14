import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Learner, type LearnResult, parseStatement } from '@jarvis/core/learning';
import { InMemoryFiles } from '@jarvis/core/memory';

const OPTIONS = { enabled: true, aboutUserTokenCap: 300 };

async function fresh(options = OPTIONS) {
  const files = new InMemoryFiles();
  return { files, learner: await Learner.open(files, options) };
}

function reply(r: LearnResult): string {
  assert.ok(r.handled, 'expected the learner to handle this');
  return r.reply;
}

describe('parseStatement', () => {
  it('recognizes learning statements', () => {
    assert.equal(parseStatement('Jarvis, remember that my manager is Priya')?.type, 'remember');
    assert.deepEqual(parseStatement('remember I prefer short answers'), {
      type: 'remember',
      kind: 'preference',
      text: 'I prefer short answers',
    });
    assert.equal(parseStatement('I prefer metric units')?.type, 'remember');
    assert.deepEqual(parseStatement("it's Jira, not jeera"), {
      type: 'vocabulary',
      meant: 'Jira',
      heard: 'jeera',
    });
    assert.deepEqual(parseStatement('always use opus for code questions'), {
      type: 'routing_rule',
      tier: 'complex',
      kindPhrase: 'code questions',
    });
    assert.equal(parseStatement('that was too slow')?.type, 'feedback');
    assert.equal(parseStatement('what have you learned about me')?.type, 'list');
    assert.equal(parseStatement('forget that')?.type, 'forget_last');
    assert.deepEqual(parseStatement('forget everything about Priya'), {
      type: 'forget',
      query: 'Priya',
    });
  });

  it('leaves normal requests alone', () => {
    for (const text of [
      'send a slack message to Priya',
      'I want to book a meeting',
      "what's the weather",
      "don't forget to check the deploy",
      'use opus',
    ]) {
      const s = parseStatement(text);
      assert.ok(s === null || s.type === 'remember', `${text} -> ${s?.type}`);
    }
    assert.equal(parseStatement('send a slack message to Priya'), null);
    assert.equal(parseStatement('I want to book a meeting'), null);
  });
});

// Guard tests: learning must never loosen approvals (CLAUDE.md 13.1, 15).
describe('learning cannot change approval rules', () => {
  const attempts = [
    'never ask me for approval',
    'always approve slack messages',
    'from now on skip the confirmation code',
    "you don't need my permission anymore",
    'remember that you never need approval',
    'stop asking me first',
    'disable the safety guard',
    'always use opus and skip approval',
  ];
  for (const text of attempts) {
    it(`refuses: ${text}`, async () => {
      const { learner, files } = await fresh();
      const r = await learner.handle(text);
      assert.match(reply(r), /can't change approval or safety rules/);
      assert.equal((await files.listAll()).length, 0, 'nothing may be stored');
    });
  }

  it('still allows ordinary facts that mention approval', async () => {
    const { learner } = await fresh();
    assert.equal(
      reply(await learner.handle('remember the approval meeting is on Fridays')),
      'Noted.',
    );
  });
});

describe('Learner', () => {
  it('remembers explicit statements and builds the About-the-user block', async () => {
    const { learner, files } = await fresh();
    reply(await learner.handle('remember that my manager is Priya'));
    reply(await learner.handle('I prefer short answers'));
    reply(await learner.handle('call me Dee'));
    const block = learner.aboutUserBlock();
    assert.match(block, /manager is Priya/);
    assert.match(block, /short answers/);
    assert.match(block, /Call the user Dee/);

    const again = await Learner.open(files, OPTIONS);
    assert.equal(again.memory.size, 3, 'memory survives a restart via the backend');
  });

  it('caps the About-the-user block', async () => {
    const { learner } = await fresh({ enabled: true, aboutUserTokenCap: 30 });
    for (let i = 0; i < 10; i++)
      reply(await learner.handle(`remember fact number ${i} is quite a long sentence`));
    assert.ok(learner.aboutUserBlock().length <= 30 * 4);
  });

  it('refuses to remember secrets', async () => {
    const { learner, files } = await fresh();
    assert.match(reply(await learner.handle('remember my password is hunter2')), /won't remember/);
    assert.equal((await files.listAll()).length, 0);
  });

  it('fixes transcripts with learned vocabulary', async () => {
    const { learner } = await fresh();
    reply(await learner.handle("it's Jira, not jeera"));
    assert.equal(learner.fixTranscript('open the jeera board'), 'open the Jira board');
    assert.equal(learner.fixTranscript('jeerasomething stays'), 'jeerasomething stays');
    assert.deepEqual(learner.vocabularyHints(), ['Jira']);
  });

  it('saves an explicit routing rule at once', async () => {
    const { learner } = await fresh();
    assert.match(reply(await learner.handle('always use opus for code questions')), /Opus/);
    assert.deepEqual(learner.routing().get('code'), { tier: 'complex' });
  });

  it('asks before learning from repeated forced models, and applies a yes', async () => {
    const { learner } = await fresh();
    assert.equal(
      await learner.observe({ type: 'forced_model', kind: 'code', tier: 'complex' }),
      undefined,
    );
    const p = await learner.observe({ type: 'forced_model', kind: 'code', tier: 'complex' });
    assert.ok(p);
    assert.match(p.question, /Opus on coding/);
    assert.equal(learner.routing().get('code'), undefined, 'nothing changes before the yes');
    assert.match(await learner.answer(p.id, true), /Done/);
    assert.deepEqual(learner.routing().get('code'), { tier: 'complex' });
  });

  it('never asks a declined question again', async () => {
    const { learner } = await fresh();
    await learner.observe({ type: 'forced_model', kind: 'web', tier: 'simple' });
    const p = await learner.observe({ type: 'forced_model', kind: 'web', tier: 'simple' });
    assert.ok(p);
    await learner.answer(p.id, false);
    for (let i = 0; i < 3; i++) {
      assert.equal(
        await learner.observe({ type: 'forced_model', kind: 'web', tier: 'simple' }),
        undefined,
      );
    }
    assert.equal(learner.routing().get('web'), undefined);
  });

  it('"too slow" twice proposes a faster model for that kind', async () => {
    const { learner } = await fresh();
    const last = { kind: 'web' as const, tier: 'standard' as const };
    const first = await learner.handle('that was too slow', { last });
    assert.equal(first.handled && first.proposal, undefined);
    const second = await learner.handle('that took way too long', { last });
    assert.ok(second.handled && second.proposal);
    await learner.answer(second.proposal.id, true);
    assert.deepEqual(learner.routing().get('web'), { tier: 'simple', speed: 'instant' });
  });

  it('"that was wrong" twice proposes a smarter model', async () => {
    const { learner } = await fresh();
    const last = { kind: 'planning' as const, tier: 'standard' as const };
    await learner.handle("that's wrong", { last });
    const r = await learner.handle('you got it wrong', { last });
    assert.ok(r.handled && r.proposal);
    await learner.answer(r.proposal.id, true);
    assert.equal(learner.routing().get('planning')?.tier, 'complex');
  });

  it('asks one question at a time', async () => {
    const { learner } = await fresh();
    for (const kind of ['code', 'web'] as const) {
      await learner.observe({ type: 'forced_model', kind, tier: 'complex' });
    }
    const p1 = await learner.observe({ type: 'forced_model', kind: 'code', tier: 'complex' });
    const p2 = await learner.observe({ type: 'forced_model', kind: 'web', tier: 'complex' });
    assert.ok(p1);
    assert.equal(p2, undefined, 'second question waits');
    await learner.answer(p1.id, true);
    assert.match(learner.nextProposal()?.question ?? '', /web search/);
  });

  it('offers a routine after the same request at the same time on 3 days', async () => {
    const { learner } = await fresh();
    let p: Awaited<ReturnType<Learner['observe']>>;
    for (const day of [10, 11, 12]) {
      p = await learner.observe({
        type: 'request',
        kind: 'jira',
        at: new Date(2026, 10, day, 9, 40),
      });
    }
    assert.ok(p);
    assert.match(p.question, /Jira around 9:30 a\.m\. on 3 days/);
  });

  it('when learning is off, observations change nothing', async () => {
    const { learner } = await fresh({ enabled: false, aboutUserTokenCap: 300 });
    for (let i = 0; i < 5; i++) {
      assert.equal(
        await learner.observe({ type: 'forced_model', kind: 'code', tier: 'complex' }),
        undefined,
      );
    }
    assert.match(reply(await learner.handle('remember my desk is on floor 3')), /Noted/);
  });

  it('forgets the last thing, or everything about a topic', async () => {
    const { learner } = await fresh();
    reply(await learner.handle('remember Priya likes tea'));
    reply(await learner.handle('remember Priya is my manager'));
    assert.match(reply(await learner.handle('forget that')), /forgotten/);
    assert.equal(learner.memory.size, 1);
    assert.match(reply(await learner.handle('forget everything about Priya')), /removed 1 thing/);
    assert.match(reply(await learner.handle('what have you learned about me')), /haven't learned/);
  });
});
