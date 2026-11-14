import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { AudioPlayer, KeywordHit, KeywordSpotter } from '@jarvis/core/audio';
import { BargeIn, Endpointer, parseKeywordLine, WindowsKeywordSpotter } from '@jarvis/core/audio';
import { loadConfig } from '@jarvis/core/config';
import { Learner } from '@jarvis/core/learning';
import { InMemoryFiles } from '@jarvis/core/memory';
import type { Skill } from '@jarvis/core/skills';
import { StateError, StateMachine } from '@jarvis/core/state';
import type { SttProvider } from '@jarvis/core/stt';
import { type TtsProvider, WindowsSapiTts } from '@jarvis/core/tts';
import {
  Conversation,
  isWakeWordOnly,
  type ModelRequest,
  matchCommand,
  type ReplyModel,
  SentenceSplitter,
  stripWakeWord,
  VoiceLoop,
} from '@jarvis/core/voice';
import type { CoreToPetEvent, JarvisState } from '@jarvis/shared';

const { models } = loadConfig();
const RATE = 16000;
const FRAME = 512;

/** A 512-sample frame at roughly the given level (dBFS). */
function frame(dbfs: number): Int16Array {
  const amp = Math.round(32767 * 10 ** (dbfs / 20) * Math.SQRT2);
  const f = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = Math.round(amp * Math.sin((i / FRAME) * Math.PI * 16));
  return f;
}
const QUIET = frame(-80);
const SPEECH = frame(-30);

describe('StateMachine', () => {
  it('follows the spec and rejects skipped steps', () => {
    const seen: JarvisState[] = [];
    const sm = new StateMachine((s) => seen.push(s));
    sm.to('LISTENING');
    sm.to('THINKING');
    sm.to('SPEAKING');
    sm.to('FOLLOW_UP');
    assert.throws(() => sm.to('SPEAKING'), StateError);
    assert.deepEqual(seen, ['LISTENING', 'THINKING', 'SPEAKING', 'FOLLOW_UP']);
  });

  it('kill switches work from any state; muted only goes back to sleep', () => {
    const sm = new StateMachine();
    sm.to('LISTENING');
    sm.to('MUTED');
    assert.throws(() => sm.to('LISTENING'), StateError);
    assert.throws(() => sm.to('ERROR'), StateError);
    sm.to('SLEEPING');
    sm.to('LISTENING');
    sm.to('THINKING');
    sm.to('SLEEPING');
    assert.equal(sm.state, 'SLEEPING');
  });
});

describe('Endpointer', () => {
  const opts = {
    sampleRate: RATE,
    frameLength: FRAME,
    silenceMs: 400,
    startTimeoutMs: 1000,
    maxMs: 5000,
  };

  it('returns the utterance after speech then silence, with a short pre-roll', () => {
    const ep = new Endpointer({ ...opts, floorDbfs: -80 });
    for (let i = 0; i < 10; i++) assert.equal(ep.push(QUIET).type, 'continue');
    const types: string[] = [];
    for (let i = 0; i < 20; i++) types.push(ep.push(SPEECH).type);
    assert.ok(types.includes('speech_start'));
    let r = ep.push(QUIET);
    for (let i = 0; i < 30 && r.type === 'continue'; i++) r = ep.push(QUIET);
    assert.equal(r.type, 'end');
    if (r.type !== 'end') return;
    assert.equal(r.reason, 'silence');
    const seconds = r.pcm.length / RATE;
    // 20 speech frames (0.64 s) + up to 0.3 s pre-roll + a little tail
    assert.ok(seconds > 0.6 && seconds < 1.3, `kept ${seconds} s`);
  });

  it('gives up when nobody speaks', () => {
    const ep = new Endpointer({ ...opts, floorDbfs: -80 });
    let r = ep.push(QUIET);
    for (let i = 0; i < 100 && r.type === 'continue'; i++) r = ep.push(QUIET);
    assert.equal(r.type, 'no_speech');
  });

  it('cuts off at the maximum length', () => {
    const ep = new Endpointer({ ...opts, maxMs: 600, floorDbfs: -80 });
    let r = ep.push(SPEECH);
    for (let i = 0; i < 100 && r.type !== 'end'; i++) r = ep.push(SPEECH);
    assert.equal(r.type, 'end');
    if (r.type === 'end') assert.equal(r.reason, 'max');
  });

  it('a speaker who starts right after the wake word is not mistaken for the noise floor', () => {
    const ep = new Endpointer({ ...opts, floorDbfs: -80 });
    assert.equal(ep.push(SPEECH).type, 'continue');
    ep.push(SPEECH);
    assert.equal(ep.push(SPEECH).type, 'speech_start');
  });
});

describe('spoken commands', () => {
  it('match only the whole utterance', () => {
    assert.equal(matchCommand('Jarvis, stop.'), 'stop');
    assert.equal(matchCommand('stop'), 'stop');
    assert.equal(matchCommand('Stop the deploy'), null);
    assert.equal(matchCommand("That's all, thanks"), null);
    assert.equal(matchCommand("Thanks, that's all."), 'sleep');
    assert.equal(matchCommand('Mute.'), 'mute');
    assert.equal(matchCommand('What are you doing?'), 'status');
  });

  it('strips a wake word Whisper caught', () => {
    assert.equal(stripWakeWord("Jarvis, what's two plus two?"), "what's two plus two?");
    assert.equal(stripWakeWord('Hi Jarvis. Open Slack'), 'Open Slack');
    assert.equal(stripWakeWord('Ask Jarvis later'), 'Ask Jarvis later');
  });
});

describe('SentenceSplitter', () => {
  it('releases whole sentences as they stream and keeps short abbreviations together', () => {
    const s = new SentenceSplitter();
    assert.deepEqual(s.push('Two plus two'), []);
    assert.deepEqual(s.push(' is four. Want'), ['Two plus two is four.']);
    assert.deepEqual(s.push(' more, e.g. a harder one? '), ['Want more, e.g. a harder one?']);
    assert.deepEqual(s.push('Okay'), []);
    assert.equal(s.flush(), 'Okay');
  });
});

/** Streams scripted replies; can call tools like the real model. */
class FakeModel implements ReplyModel {
  readonly requests: ModelRequest[] = [];
  readonly #script: ((req: ModelRequest) => Promise<string> | string)[];

  constructor(...script: ((req: ModelRequest) => Promise<string> | string)[]) {
    this.#script = script;
  }

  async stream(req: ModelRequest, onText: (d: string) => void) {
    this.requests.push(req);
    const step = this.#script.shift();
    assert.ok(step, 'unexpected model call');
    const text = await step(req);
    for (const piece of text.match(/.{1,7}/gs) ?? []) onText(piece);
    return { inputTokens: 10, outputTokens: 5, toolCalls: 0 };
  }
}

const learnerOf = () =>
  Learner.open(new InMemoryFiles(), { enabled: true, aboutUserTokenCap: 300 });
const tierZero = (name: string) => (name === 'memory_search' || name === 'skill_read' ? 0 : 2);

describe('Conversation', () => {
  it('starts on Haiku, streams sentences, and keeps the tier for follow-ups', async () => {
    const model = new FakeModel(
      () => 'Two plus two is four. Anything else?',
      () => 'Eight.',
    );
    const c = new Conversation({ model, models, learner: await learnerOf(), toolTier: tierZero });
    const said: string[] = [];
    const r = await c.ask("what's two plus two", { onSentence: (s) => said.push(s) });
    assert.equal(r.tier, 'simple');
    assert.equal(model.requests[0]?.model, models.tiers.simple);
    assert.deepEqual(said, ['Two plus two is four.', 'Anything else?']);
    await c.ask('and four plus four', { onSentence: (s) => said.push(s) });
    assert.equal(model.requests[1]?.messages.length, 3, 'history carried into the follow-up');
  });

  it('escalates one tier when Haiku says so, and never speaks the marker', async () => {
    const model = new FakeModel(
      () => '[[ESCALATE: needs careful reasoning]]',
      () => 'Here is the careful answer.',
    );
    const c = new Conversation({ model, models, learner: await learnerOf() });
    const said: string[] = [];
    const r = await c.ask('tell me a fun fact', { onSentence: (s) => said.push(s) });
    assert.equal(r.escalations, 1);
    assert.equal(r.tier, 'standard');
    assert.equal(model.requests[1]?.model, models.tiers.standard);
    assert.deepEqual(said, ['Here is the careful answer.']);
  });

  it('a reply that finishes after "stop" does not leak into the next conversation', async () => {
    let release: () => void = () => {};
    const model = new FakeModel(
      () =>
        new Promise<string>((r) => {
          release = () => r('Late answer.');
        }),
      () => 'Fresh answer.',
    );
    const c = new Conversation({ model, models, learner: await learnerOf() });
    const first = c.ask('first question here', { onSentence: () => {} });
    await new Promise((r) => setTimeout(r, 5));
    c.reset(); // the user said "Jarvis, stop"
    release();
    await first;
    await c.ask('second question here', { onSentence: () => {} });
    const msgs = model.requests[1]?.messages ?? [];
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user'],
      'the new conversation starts with the user',
    );
  });

  it('a very short reply is still spoken', async () => {
    const c = new Conversation({
      model: new FakeModel(() => '4'),
      models,
      learner: await learnerOf(),
    });
    const said: string[] = [];
    await c.ask('two plus two, just the number', { onSentence: (s) => said.push(s) });
    assert.deepEqual(said, ['4']);
  });

  it('"use Opus" on its own forces the next request, without a model call', async () => {
    const model = new FakeModel(() => 'Done thinking hard.');
    const c = new Conversation({ model, models, learner: await learnerOf() });
    const said: string[] = [];
    const r1 = await c.ask('Jarvis, use Opus', { onSentence: (s) => said.push(s) });
    assert.equal(r1.model, null);
    const r2 = await c.ask('what is the capital of France', { onSentence: (s) => said.push(s) });
    assert.equal(r2.tier, 'complex');
    assert.equal(r2.decision?.decidedBy, 'forced');
  });
});

describe('Retrieval instead of a full prompt', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-skill-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'SKILL.md');
  const BODY = 'Step one: find the ticket key. Step two: move it to In Review. SECRET_BODY_MARKER';
  writeFileSync(
    file,
    `---\nname: jira-move\ndescription: Move a Jira ticket to another status after a commit\n---\n${BODY}\n`,
  );
  const skill: Skill = {
    id: 'jira-move',
    name: 'jira-move',
    description: 'Move a Jira ticket to another status after a commit',
    plugin: null,
    source: 'custom',
    file,
  };

  it('lists matching skills by name only; the body comes from skill_read', async () => {
    let toolOutput = '';
    const model = new FakeModel(async (req) => {
      const read = req.tools?.find((t) => t.name === 'skill_read');
      assert.ok(read, 'skill_read offered');
      toolOutput = await read.run({ id: 'jira-move' });
      return 'Which ticket should I move?';
    });
    const c = new Conversation({
      model,
      models,
      learner: await learnerOf(),
      skills: [skill],
      toolTier: tierZero,
    });
    await c.ask('move the jira ticket to review after my commit', { onSentence: () => {} });
    const system = `${model.requests[0]?.system ?? ''}\n${model.requests[0]?.context ?? ''}`;
    assert.match(system, /- jira-move: Move a Jira ticket/);
    assert.doesNotMatch(system, /SECRET_BODY_MARKER/, 'skill body not in the prompt');
    assert.match(toolOutput, /SECRET_BODY_MARKER/);
  });

  it('memory_search finds what the user said before', async () => {
    const learner = await learnerOf();
    await learner.handle('Remember that Priya is the design lead');
    let found = '';
    const model = new FakeModel(async (req) => {
      const search = req.tools?.find((t) => t.name === 'memory_search');
      assert.ok(search);
      found = await search.run({ query: 'Priya' });
      return 'Priya is the design lead.';
    });
    const c = new Conversation({ model, models, learner, toolTier: tierZero });
    await c.ask('who is Priya', { onSentence: () => {} });
    assert.match(found, /Priya/);
    assert.match(model.requests[0]?.system ?? '', /call memory_search/);
  });

  it('tools that are not tier 0 in permissions.yaml are not offered (no gate yet)', async () => {
    const model = new FakeModel(() => 'Okay.');
    const c = new Conversation({ model, models, learner: await learnerOf(), toolTier: () => 2 });
    await c.ask('hello there', { onSentence: () => {} });
    assert.equal(model.requests[0]?.tools?.length ?? 0, 0);
    assert.doesNotMatch(model.requests[0]?.system ?? '', /memory_search/);
  });

  it('permissions.yaml has the lookups at tier 0', () => {
    const { permissions } = loadConfig();
    assert.equal(permissions.tools.memory_search, 0);
    assert.equal(permissions.tools.skill_read, 0);
  });
});

/** Mic frames pushed by the test, one at a time. */
class FrameFeed {
  #queue: Int16Array[] = [];
  #wake: (() => void) | undefined;
  opened = 0;
  released = 0;

  push(f: Int16Array, n = 1): void {
    for (let i = 0; i < n; i++) this.#queue.push(f);
    this.#wake?.();
  }

  async *frames(signal: AbortSignal): AsyncGenerator<Int16Array> {
    this.opened++;
    this.#queue = []; // a real mic never delivers audio from while it was closed
    const stop = () => this.#wake?.();
    signal.addEventListener('abort', stop);
    try {
      while (!signal.aborted) {
        const f = this.#queue.shift();
        if (f) {
          yield f;
          continue;
        }
        await new Promise<void>((r) => {
          this.#wake = r;
        });
      }
    } finally {
      this.released++;
      signal.removeEventListener('abort', stop);
    }
  }
}

/** Fires a keyword on marked frames. */
class FakeKeywords implements KeywordSpotter {
  readonly marks = new Map<Int16Array, KeywordHit>();
  /** Samples seen, like the real spotter counts them. */
  samples = 0;
  process(f: Int16Array): KeywordHit | null {
    this.samples += f.length;
    return this.marks.get(f) ?? null;
  }
  release(): void {}
}

const WAKE = frame(-79);
const STOP = frame(-78);

function fakeLoop(
  replyText: string,
  playMs = 30,
  opts: { wakeWord?: boolean; thinkMs?: number; playLevel?: number } = {},
) {
  const feed = new FrameFeed();
  const keywords = new FakeKeywords();
  keywords.marks.set(WAKE, { keyword: 'wake' });
  keywords.marks.set(STOP, { keyword: 'stop' });
  const events: CoreToPetEvent[] = [];
  const states: JarvisState[] = [];
  const played: string[] = [];
  const heardSeconds: number[] = [];
  const stt: SttProvider = {
    transcribe: async (pcm) => {
      heardSeconds.push(pcm.length / RATE);
      return { text: "Jarvis, what's two plus two?", ms: 5 };
    },
    close: async () => {},
  };
  const tts: TtsProvider = {
    synthesize: async (text) => ({ sampleRate: RATE, pcm: Int16Array.from(text, () => 1) }),
    close: async () => {},
  };
  const player: AudioPlayer = {
    play: (pcm, _rate, o) =>
      new Promise((resolve) => {
        played.push(String(pcm.length));
        const level = opts.playLevel;
        const meter = level ? setInterval(() => o?.onLevel?.(level), 10) : undefined;
        o?.signal?.addEventListener('abort', () => clearInterval(meter));
        setTimeout(() => clearInterval(meter), playMs);
        const t = setTimeout(() => resolve('done'), playMs);
        o?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve('stopped');
        });
      }),
  };
  let resets = 0;
  const asked: string[] = [];
  const loop = new VoiceLoop({
    frames: (s) => feed.frames(s),
    keywords: opts.wakeWord === false ? null : keywords,
    stt,
    tts,
    player,
    conversation: {
      ask: async (text, o) => {
        asked.push(text);
        if (opts.thinkMs) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, opts.thinkMs);
            o.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          });
        }
        for (const s of replyText.split('|')) o.onSentence(s);
        return {
          reply: replyText,
          tier: 'simple',
          model: 'm',
          decision: null,
          escalations: 0,
          usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
          firstSentenceMs: 1,
        };
      },
      reset: () => {
        resets++;
      },
    },
    timing: {
      sampleRate: RATE,
      frameLength: FRAME,
      silenceMs: 300,
      startTimeoutMs: 1000,
      maxRecordMs: 5000,
      followUpMs: 500,
      fillerMs: 5000,
    },
    emit: (e) => {
      events.push(e);
      if (e.type === 'state') states.push(e.state);
    },
  });
  return {
    feed,
    loop,
    keywords,
    events,
    states,
    played,
    asked,
    heardSeconds,
    resets: () => resets,
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick();
  }
}

/** Speech then enough quiet to end it (silenceMs 300 = 10 frames). */
function say(feed: FrameFeed): void {
  feed.push(SPEECH, 15);
  feed.push(QUIET, 12);
}

describe('VoiceLoop', () => {
  it('wake, listen, answer aloud, follow-up window, back to sleep', async () => {
    const t = fakeLoop('Two plus two is four.|Anything else?');
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    say(t.feed);
    await until(() => t.states.includes('FOLLOW_UP'));
    assert.deepEqual(t.asked, ["what's two plus two?"], 'wake word stripped before asking');
    assert.equal(t.played.length, 2, 'both sentences spoken');
    assert.ok(t.events.some((e) => e.type === 'transcript_final'));
    // Silence through the follow-up window (500 ms = 16 frames) ends the conversation.
    t.feed.push(QUIET, 20);
    await until(() => t.loop.state === 'SLEEPING');
    assert.deepEqual(t.states, ['LISTENING', 'THINKING', 'SPEAKING', 'FOLLOW_UP', 'SLEEPING']);
    assert.ok(t.resets() >= 1, 'conversation reset when it ends');
    quit.abort();
    await running;
  });

  it('the stop keyword cuts Jarvis off mid-sentence', async () => {
    const t = fakeLoop('A very long answer that goes on.|And on.', 2000);
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    say(t.feed);
    await until(() => t.loop.state === 'SPEAKING');
    const t0 = performance.now();
    t.feed.push(STOP);
    await until(() => t.loop.state === 'SLEEPING');
    assert.ok(performance.now() - t0 < 500, 'stopped at once, not after playback');
    await tick(50);
    assert.equal(t.played.length, 1, 'the second sentence never played');
    quit.abort();
    await running;
  });

  it('saying the wake word while Jarvis speaks interrupts and listens again', async () => {
    const t = fakeLoop('A long answer.', 2000);
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    say(t.feed);
    await until(() => t.loop.state === 'SPEAKING');
    t.feed.push(WAKE);
    await until(() => t.loop.state === 'LISTENING');
    quit.abort();
    await running;
  });

  it('mute releases the mic; unmute opens it again; the kill switch works', async () => {
    const t = fakeLoop('Okay.');
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 5);
    await until(() => t.feed.opened === 1);
    t.loop.mute();
    await until(() => t.feed.released === 1);
    assert.equal(t.loop.state, 'MUTED');
    t.feed.push(WAKE);
    await tick(30);
    assert.equal(t.loop.state, 'MUTED', 'no wake word while muted');
    t.loop.stop();
    assert.equal(t.loop.state, 'MUTED', 'stop does not unmute');
    t.loop.toggleMute();
    await until(() => t.feed.opened === 2);
    assert.equal(t.loop.state, 'SLEEPING');
    quit.abort();
    await running;
  });

  it('nobody speaks after the wake word: back to sleep without a reply', async () => {
    const t = fakeLoop('Should not be said.');
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    t.feed.push(QUIET, 40);
    await until(() => t.states.at(-1) === 'SLEEPING');
    assert.deepEqual(t.asked, []);
    quit.abort();
    await running;
  });
});

describe('VoiceLoop without a wake-word account', () => {
  it('"Jarvis, what\'s two plus two" in one breath: the request audio is replayed, not lost', async () => {
    const t = fakeLoop('Four.');
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    // The whole sentence is spoken before the recognizer reports the wake word.
    const phraseStart = 20 * FRAME;
    t.feed.push(SPEECH, 40);
    t.feed.push(QUIET, 3);
    const late = frame(-77);
    t.keywords.marks.set(late, { keyword: 'wake', startSample: phraseStart });
    t.feed.push(late);
    t.feed.push(QUIET, 12);
    await until(() => t.asked.length === 1);
    const heard = t.heardSeconds[0] ?? 0;
    assert.ok(heard > 1.2, `the whole request was transcribed (${heard.toFixed(2)} s)`);
    quit.abort();
    await running;
  });

  it('hotkey only: the mic stays closed while asleep and opens on the talk key', async () => {
    const t = fakeLoop('Okay.', 30, { wakeWord: false });
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    await tick(30);
    assert.equal(t.feed.opened, 0, 'no mic while asleep');
    t.loop.talk();
    await until(() => t.feed.opened === 1);
    assert.equal(t.loop.state, 'LISTENING');
    say(t.feed);
    await until(() => t.states.includes('FOLLOW_UP'));
    t.feed.push(QUIET, 20);
    await until(() => t.loop.state === 'SLEEPING');
    await until(() => t.feed.released === 1);
    assert.equal(t.asked.length, 1);
    quit.abort();
    await running;
  });

  it('the talk key interrupts Jarvis while it speaks', async () => {
    const t = fakeLoop('A very long answer.', 2000);
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    say(t.feed);
    await until(() => t.loop.state === 'SPEAKING');
    t.loop.talk();
    assert.equal(t.loop.state, 'LISTENING');
    quit.abort();
    await running;
  });
});

describe('parseKeywordLine (Windows recognizer)', () => {
  it('the wake word alone waits for the request; in one breath it replays', () => {
    assert.deepEqual(parseKeywordLine('wake 0.97 0.000 jarvis', RATE), { keyword: 'wake' });
    assert.deepEqual(parseKeywordLine('wake 0.93 16.510 hey jarvis', RATE), { keyword: 'wake' });
    assert.deepEqual(parseKeywordLine('wake 0.74 2.450 Jarvis watts two plus two', RATE), {
      keyword: 'wake',
      startSample: 39200,
    });
    assert.deepEqual(parseKeywordLine('stop 0.95 25.680 jarvis stop', RATE), { keyword: 'stop' });
    assert.equal(parseKeywordLine('ignored other 0.80 I told Jarvis', RATE), null);
    assert.equal(parseKeywordLine('ready', RATE), null);
  });
});

describe('WindowsKeywordSpotter (live)', { skip: process.platform !== 'win32' }, () => {
  it('hears "Jarvis" and ignores ordinary speech that mentions it', async () => {
    const spotter = new WindowsKeywordSpotter({ sampleRate: RATE, minConfidence: 0.6 });
    const tts = new WindowsSapiTts({ voice: null, rate: 0, timeoutMs: 20000 });
    try {
      await spotter.start();
      const hits: KeywordHit[] = [];
      const feedPhrase = async (text: string) => {
        const a = await tts.synthesize(text);
        const all = new Int16Array(a.pcm.length + RATE);
        all.set(a.pcm);
        for (let i = 0; i < all.length; i += FRAME) {
          const hit = spotter.process(all.slice(i, i + FRAME));
          if (hit) hits.push(hit);
          await tick(4); // faster than real time is fine
        }
      };
      await feedPhrase('I told Jarvis about it yesterday.');
      await feedPhrase('Jarvis');
      for (let i = 0; i < 100 && hits.length === 0; i++) {
        const hit = spotter.process(new Int16Array(FRAME));
        if (hit) hits.push(hit);
        await tick(20);
      }
      assert.deepEqual(
        hits.map((h) => h.keyword),
        ['wake'],
        'one wake, and the sentence that only mentions Jarvis ignored',
      );
    } finally {
      spotter.release();
      await tts.close();
    }
  });
});

describe('heard only the wake word', () => {
  it('keeps listening instead of answering "Jabbies!"', () => {
    assert.equal(isWakeWordOnly('Jabbies!'), true);
    assert.equal(isWakeWordOnly('Hey Javis.'), true);
    assert.equal(isWakeWordOnly('Jarvis'), true);
    assert.equal(isWakeWordOnly('James'), true, 'close enough when it is all that was said');
    assert.equal(isWakeWordOnly('Jarvis, what time is it?'), false);
    assert.equal(isWakeWordOnly('Travis'), false);
    assert.equal(isWakeWordOnly('Hello'), false);
  });
});

describe('talking while Jarvis is busy', () => {
  it('a pause mid-sentence: the half answer is dropped and the whole sentence is heard', async () => {
    const t = fakeLoop('Done.', 30, { thinkMs: 3000 });
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    say(t.feed); // first half, then a pause long enough to end it
    await until(() => t.loop.state === 'THINKING' && t.asked.length === 1);
    t.feed.push(SPEECH, 25); // ...they go on talking
    await until(() => t.loop.state === 'LISTENING');
    t.feed.push(QUIET, 12);
    await until(() => t.heardSeconds.length === 2);
    const [first = 0, second = 0] = t.heardSeconds;
    assert.ok(second > first + 0.6, `second take has both parts (${first} s, then ${second} s)`);
    assert.equal(t.played.length, 0, 'nothing was said for the half sentence');
    quit.abort();
    await running;
  });

  it('talking over Jarvis stops it at once and listens', async () => {
    const t = fakeLoop('A very long answer.|And more.', 3000);
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    say(t.feed);
    await until(() => t.loop.state === 'SPEAKING');
    t.feed.push(SPEECH, 12);
    await until(() => t.loop.state === 'LISTENING');
    await tick(50);
    assert.equal(t.played.length, 1, 'the rest of the answer was not played');
    quit.abort();
    await running;
  });

  it("Jarvis's own voice through the speakers does not interrupt it", async () => {
    const t = fakeLoop('A long answer.', 1500, { playLevel: 0.3 }); // about -10 dBFS out
    const quit = new AbortController();
    const running = t.loop.run(quit.signal);
    t.feed.push(QUIET, 20);
    t.feed.push(WAKE);
    say(t.feed);
    await until(() => t.loop.state === 'SPEAKING');
    for (let i = 0; i < 30; i++) {
      t.feed.push(frame(-30)); // the echo: 20 dB under what is played
      await tick(8);
    }
    assert.equal(t.loop.state, 'SPEAKING');
    quit.abort();
    await running;
  });
});

describe('BargeIn', () => {
  const opts = { frameMs: 32, minSpeechMs: 280 };
  it('needs a moment of real speech, not a click', () => {
    const b = new BargeIn(opts);
    assert.equal(b.push(SPEECH, 0, -70), false);
    assert.equal(b.push(QUIET, 0, -70), false);
    let hit = false;
    for (let i = 0; i < 9; i++) hit = b.push(SPEECH, 0, -70);
    assert.equal(hit, true);
  });

  it('learns the echo level and still hears a louder voice over it', () => {
    const b = new BargeIn(opts);
    const out = 10 ** (-10 / 20); // playing at -10 dBFS
    for (let i = 0; i < 60; i++) assert.equal(b.push(frame(-30), out, -70), false, 'echo');
    let hit = false;
    for (let i = 0; i < 9; i++) hit = b.push(frame(-8), out, -70);
    assert.equal(hit, true, 'the user, 22 dB above the echo');
  });
});
