import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BargeIn } from '../packages/core/src/audio/index.ts';
import { isOwnEcho } from '../packages/core/src/voice/echo-text.ts';

describe('isOwnEcho (what Whisper wrote down vs. what Jarvis just said)', () => {
  // The real conversation of 2026-11-14: every "user" line after the first was
  // the start of Jarvis's previous reply, heard back through the speakers.
  const real: [heard: string, said: string][] = [
    [
      "I don't have.",
      "I don't have your location saved, so I can't check the weather yet. Which city should I look up?",
    ],
    [
      "The weather's...",
      "The weather search is already open in Vivaldi. I can't read the forecast from here.",
    ],
    ['Sorry.', 'Sorry, I missed the end of that. Did you want me to read the weather to you?'],
    ['No prop.', 'No problem. The weather search is still open in Vivaldi.'],
    ["I'm not sure.", "I'm not sure I caught that. Do you need anything else?"],
    ["That's fine.", "That's fine. The weather search is still open in Vivaldi."],
    ['Okay.', "Okay, I'll call you there with our internet."],
    ['Say what you need.', "Got it. Just say what you need when you're ready."],
  ];
  for (const [heard, said] of real) {
    it(`"${heard}" is Jarvis's own voice`, () => assert.equal(isOwnEcho(heard, said), true));
  }

  it('the user answering is not taken for an echo', () => {
    const said = "I don't have your location saved. Which city should I look up?";
    assert.equal(isOwnEcho('Chennai', said), false);
    assert.equal(isOwnEcho('show me the weather in Chennai', said), false);
    assert.equal(isOwnEcho('open Slack', 'Opened a search in Vivaldi.'), false);
    assert.equal(isOwnEcho('what time is it', 'It is five past four.'), false);
    assert.equal(isOwnEcho('anything', ''), false);
    assert.equal(isOwnEcho('', 'Hello.'), false);
  });

  it('a long sentence needs most of its words, in order', () => {
    const said = 'The weather search is still open in Vivaldi.';
    assert.equal(isOwnEcho('the weather search is still open', said), true);
    assert.equal(isOwnEcho('close the search in Vivaldi and open Slack instead', said), false);
  });
});

describe('BargeIn on loud speakers', () => {
  const opts = { frameMs: 32, sampleRate: 16000, minSpeechMs: 280 };
  const tone = (dbfs: number) => {
    const amp = Math.round(32767 * 10 ** (dbfs / 20) * Math.SQRT2);
    return Int16Array.from({ length: 512 }, (_, i) =>
      Math.round(amp * Math.sin((i / 512) * Math.PI * 16)),
    );
  };
  const out = 10 ** (-20 / 20); // playing at -20 dBFS

  it('an echo louder than the first guess does not interrupt the start of a reply', () => {
    // A laptop: the mic hears Jarvis 5 dB louder than it plays (the old code
    // interrupted itself on every reply here).
    const b = new BargeIn(opts);
    for (let reply = 0; reply < 3; reply++) {
      b.reset();
      for (let i = 0; i < 80; i++)
        assert.equal(b.push(tone(-15), out, -70), false, `reply ${reply} frame ${i}`);
    }
    assert.ok(b.echoGapDb > 0, `learned the loud echo (${b.echoGapDb.toFixed(1)} dB)`);
  });

  it('still hears the user clearly above that echo', () => {
    const b = new BargeIn(opts);
    for (let i = 0; i < 40; i++) b.push(tone(-15), out, -70);
    let hit = false;
    for (let i = 0; i < 12; i++) hit ||= b.push(tone(-3), out, -70);
    assert.equal(hit, true);
  });

  it('a false alarm makes it stricter', () => {
    const b = new BargeIn(opts);
    const before = b.echoGapDb;
    b.falseAlarm();
    assert.equal(b.echoGapDb, before + 6);
    for (let i = 0; i < 10; i++) b.falseAlarm();
    assert.ok(b.echoGapDb <= 20, 'capped');
  });
});
