import type { CoreToPetEvent, JarvisState, VoiceTestResult } from '@jarvis/shared';
import type { AudioPlayer } from '../audio/index.ts';
import {
  BargeIn,
  Endpointer,
  type KeywordSpotter,
  NoiseFloor,
  rmsLevel,
  toDbfs,
} from '../audio/index.ts';
import {
  type ApprovalOutcome,
  type ApprovalRequest,
  type Approver,
  matchApproval,
  matchConfirmCode,
  speakCode,
} from '../guard/index.ts';
import { StateMachine } from '../state/index.ts';
import type { SttProvider } from '../stt/index.ts';
import type { TtsProvider } from '../tts/index.ts';
import { afterWakeWord, isWakeWordOnly, matchCommand, stripWakeWord } from './commands.ts';
import type { AskOptions, AskResult, ConversationPreview } from './conversation.ts';
import { isOwnEcho } from './echo-text.ts';
import { SpeechQueue } from './speech-queue.ts';

export interface VoiceLoopTiming {
  sampleRate: number;
  frameLength: number;
  silenceMs: number;
  startTimeoutMs: number;
  maxRecordMs: number;
  followUpMs: number;
  /** Say "Still working on it" if nothing has been spoken by then. */
  fillerMs: number;
  /** No spoken answer to an approval question by then = cancel (default 20 s). */
  approvalTimeoutMs?: number;
  /** First-word budget for instant requests (7.1 rule 2); fillerMs is the normal one. */
  instantMs?: number;
  /** Stop and listen when the user talks while Jarvis thinks or speaks (default on). */
  bargeIn?: boolean;
}

/** The parts of Conversation the loop uses. */
export interface Asker {
  ask(text: string, options: AskOptions): Promise<AskResult>;
  reset(): void;
  warm?(): void;
  /** What ask() would do, without doing it (voice test). */
  preview?(text: string): ConversationPreview;
}

export interface TurnLog {
  /** The text acted on (wake word removed, learned fixes applied). */
  heard: string;
  /** Whisper's own text, for the History tab. */
  raw?: string;
  /** What went wrong, when the request failed. */
  error?: string;
  sttMs: number;
  /** From the end of speech to the first audio playing. */
  firstAudioMs: number | null;
  totalMs: number;
  result?: AskResult;
  command?: string;
  stopped: boolean;
  /** It was Jarvis's own voice coming back through the mic; nothing was answered. */
  echo?: boolean;
  /** The first-word budget for this request's speed, and whether it was missed. */
  latencyBudgetMs?: number;
  latencyMiss?: boolean;
}

export interface VoiceLoopDeps {
  /** Mic frames; iteration stops (and the device is released) when the signal aborts. */
  frames: (signal: AbortSignal) => AsyncIterable<Int16Array>;
  /**
   * Wake/stop keyword spotter. Null = no wake word: the user presses the talk
   * hotkey (`talk()`), and the mic is closed completely while Jarvis sleeps.
   */
  keywords: KeywordSpotter | null;
  /**
   * Wake on Whisper's transcript instead of a keyword engine: while asleep,
   * short bursts of speech are transcribed and checked for "(hey) Jarvis".
   * Works for voices the Windows recognizer cannot follow.
   */
  wakeByTranscript?: boolean;
  stt: SttProvider;
  tts: TtsProvider;
  player: AudioPlayer;
  conversation: Asker;
  timing: VoiceLoopTiming;
  emit: (event: CoreToPetEvent) => void;
  /** Learned spelling fixes and hints (Learner). */
  fixTranscript?: (text: string) => string;
  hints?: () => string[];
  onTurn?: (turn: TurnLog) => void;
  /** Wake word heard: a chance to load speech-to-text while the user talks. */
  onWake?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * The phase 1 voice loop (CLAUDE.md 6): wake word, record until quiet, speech
 * to text, reply, speak, follow-up window, back to sleep.
 *
 * One mic stream feeds everything. The keyword spotter hears every frame, even
 * while Jarvis is thinking or speaking, so "Jarvis" or "Jarvis stop" always
 * interrupts. Speech-to-text never runs on Jarvis's own voice (10.4).
 */
/** About 10 s of 32 ms frames kept for replay (~320 KB). */
const RECENT_FRAMES = 320;
/** Audio kept from just before the phrase start, so the first syllable is not cut. */
const REPLAY_MARGIN_SECONDS = 0.25;
/** The user must talk this long over Jarvis to interrupt it (coughs and clicks don't). */
const BARGE_IN_MS = 280;
/** Audio kept from before the interruption was noticed. */
const BARGE_IN_REPLAY_SECONDS = BARGE_IN_MS / 1000 + 0.05;
/** Speech starting this soon after Jarvis's audio stopped may be its echo or room reverb. */
const ECHO_TAIL_MS = 1500;
/** Words of Jarvis's recent speech kept for the echo check (about two replies). */
const SPOKEN_WORDS = 80;
/** Frames quieter than this at the end of a request are the pause, not words. */
const TRAILING_QUIET_DBFS = -50;
/** While asleep, this much quiet ends a burst of speech to check for "Jarvis". */
const WAKE_SILENCE_MS = 600;
/** Bursts longer than this are cut and checked anyway ("Jarvis, ..." in one breath). */
const WAKE_MAX_MS = 8000;
/** Shorter bursts are not checked. */
const WAKE_MIN_SECONDS = 0.35;
/**
 * Tells Whisper the name exists. A sentence, not the bare word: with only
 * "Jarvis" as context, Whisper treats the name as already said and drops it.
 */
export const WAKE_HINT = 'Talking to Jarvis, the assistant.';

/** Where the last loud frame of `pcm` ends (trailing quiet cut off). */
function speechEnd(pcm: Int16Array, frameLength: number): number {
  for (let at = pcm.length - frameLength; at >= 0; at -= frameLength) {
    if (toDbfs(rmsLevel(pcm, at, at + frameLength)) > TRAILING_QUIET_DBFS) return at + frameLength;
  }
  return 0;
}

export class VoiceLoop {
  readonly #d: VoiceLoopDeps;
  readonly #sm: StateMachine;
  readonly #floor = new NoiseFloor();
  #ep: Endpointer | undefined;
  #task: AbortController | undefined;
  #mic: AbortController | undefined;
  /** Wakes run() when the mic should open again (unmute, or talk without a wake word). */
  #resume: PromiseWithResolvers<void> | undefined;
  #lastStatus = 'Nothing yet.';
  /** Recent mic frames with their position, for replaying a one-breath request. */
  readonly #recent: { frame: Int16Array; start: number }[] = [];
  /** Samples given to the keyword spotter so far (positions are counted the same way). */
  #samples = 0;
  /** Listening for the answer to an approval question. */
  #approvalEp: Endpointer | undefined;
  #approvalDone: ((text: string | null) => void) | undefined;
  readonly #barge: BargeIn;
  /** Level of what Jarvis is playing right now (0..1), for telling its echo from the user. */
  #playing = 0;
  /** Audio of the request being answered, joined with the rest if the user goes on talking. */
  #utterance: Int16Array | undefined;
  /** When Jarvis's audio was last heard playing (performance.now()). */
  #lastPlayedAt = Number.NEGATIVE_INFINITY;
  /** The last words Jarvis said aloud, to recognise them if the mic hears them back. */
  #spoken = '';
  /**
   * The utterance being recorded may be Jarvis's own voice: it started with an
   * interruption while Jarvis spoke ('barge') or right after it stopped ('tail').
   */
  #echoRisk: 'barge' | 'tail' | undefined;
  /** Finds bursts of speech while asleep (wakeByTranscript). */
  #sleepEp: Endpointer | undefined;
  /** A burst is being checked for the wake word. */
  #checkingWake = false;
  /** Jarvis is saying something while asleep (the greeting): don't listen to itself. */
  #announcing = false;
  /** run() is ending. */
  #closing = false;

  /** Something listens to the room while asleep (keyword engine or Whisper). */
  get #hearsWhileAsleep(): boolean {
    return this.#d.keywords !== null || this.#d.wakeByTranscript === true;
  }

  constructor(deps: VoiceLoopDeps) {
    this.#d = deps;
    this.#barge = new BargeIn({
      frameMs: (deps.timing.frameLength / deps.timing.sampleRate) * 1000,
      sampleRate: deps.timing.sampleRate,
      minSpeechMs: BARGE_IN_MS,
    });
    this.#sm = new StateMachine((state) => {
      deps.emit({ type: 'state', state });
      // Without a wake word nothing needs to hear the room while asleep: release the mic.
      if (state === 'SLEEPING' && !this.#hearsWhileAsleep) this.#mic?.abort();
      // A half-heard burst from before this conversation must not be checked later.
      if (state !== 'SLEEPING') this.#sleepEp = undefined;
    });
  }

  /** True when a wake word is listened for; false = hotkey only. */
  get hasWakeWord(): boolean {
    return this.#d.keywords !== null;
  }

  get state(): JarvisState {
    return this.#sm.state;
  }

  /** Runs until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => {
      this.#closing = true;
      this.#cancelTask();
      this.#mic?.abort();
      this.#resume?.resolve();
    });
    while (!signal.aborted) {
      const state = this.#sm.state;
      if (state === 'MUTED' || (state === 'SLEEPING' && !this.#hearsWhileAsleep)) {
        this.#resume = Promise.withResolvers();
        await this.#resume.promise;
        continue;
      }
      this.#mic = new AbortController();
      const micSignal = AbortSignal.any([signal, this.#mic.signal]);
      for await (const frame of this.#d.frames(micSignal)) {
        if (micSignal.aborted) break;
        try {
          this.#onFrame(frame);
        } catch (err) {
          // One bad frame must never end the loop or leave a task running.
          this.#d.onError?.(err);
          this.stop();
        }
      }
    }
    this.#cancelTask();
  }

  /**
   * Says something while asleep (the startup greeting). The wake check is paused
   * meanwhile, so Jarvis never wakes on its own voice (CLAUDE.md 10.4).
   */
  async announce(text: string): Promise<void> {
    if (this.#sm.state !== 'SLEEPING') return;
    this.#announcing = true;
    this.#sleepEp = undefined;
    try {
      const audio = await this.#d.tts.synthesize(text);
      if (this.#sm.state !== 'SLEEPING') return;
      await this.#d.player.play(audio.pcm, audio.sampleRate, {
        onLevel: (level) => this.#onSpeakLevel(level),
      });
    } finally {
      this.#announcing = false;
      this.#playing = 0;
      this.#sleepEp = undefined; // drop anything heard while speaking
    }
  }

  /** Kill switch: voice, hotkey, or tray. Cancels the task, stops audio, sleeps. */
  stop(): void {
    if (this.#sm.state === 'MUTED') return;
    this.#cancelTask();
    this.#ep = undefined;
    this.#testing = false;
    this.#d.conversation.reset();
    this.#sm.to('SLEEPING');
  }

  /** Mic fully off (the device is released). */
  mute(): void {
    if (this.#sm.state === 'MUTED') return;
    this.#cancelTask();
    this.#ep = undefined;
    this.#testing = false;
    this.#d.conversation.reset();
    this.#sm.to('MUTED');
    this.#mic?.abort();
  }

  unmute(): void {
    if (this.#sm.state !== 'MUTED') return;
    this.#sm.to('SLEEPING');
    this.#resume?.resolve();
  }

  /**
   * Talk hotkey: same as saying the wake word. Starts listening, or interrupts
   * Jarvis while it thinks or speaks. Does nothing while muted.
   */
  talk(): void {
    const state = this.#sm.state;
    if (state === 'MUTED' || state === 'LISTENING' || state === 'ERROR') return;
    if (state === 'SLEEPING') {
      this.#d.onWake?.();
      this.#d.conversation.warm?.();
    } else {
      this.#cancelTask();
    }
    this.#listen(this.#d.timing.startTimeoutMs);
    this.#resume?.resolve();
  }

  toggleMute(): void {
    if (this.#sm.state === 'MUTED') this.unmute();
    else this.mute();
  }

  /** Set by testVoice(): the next utterance is reported, not answered. */
  #testing = false;

  /**
   * Settings window's "Test my voice": listen once like the talk key, then
   * report what was heard and what would happen (onVoiceTest), without asking
   * Claude, running a command, or learning anything. Only while asleep or in
   * the follow-up window; returns false otherwise.
   */
  testVoice(): boolean {
    const state = this.#sm.state;
    if (state !== 'SLEEPING' && state !== 'FOLLOW_UP') return false;
    this.#testing = true;
    if (state === 'SLEEPING') this.#d.onWake?.(); // load Whisper while the user talks
    this.#listen(this.#d.timing.startTimeoutMs);
    this.#resume?.resolve();
    return true;
  }

  #reportTest(result: Omit<VoiceTestResult, 'type'>): void {
    this.#testing = false;
    this.#d.emit({ type: 'voice_test_result', ...result });
  }

  /** Builds the voice test report for a transcript (pure apart from preview()). */
  #testResult(heard: string, text: string, sttMs: number): Omit<VoiceTestResult, 'type'> {
    const base = { heard, text, sttMs };
    if (!text) return { ...base, outcome: 'nothing' };
    const command = matchCommand(text);
    if (command) return { ...base, outcome: 'command', detail: command };
    const p = this.#d.conversation.preview?.(text);
    if (!p) return { ...base, outcome: 'agent', request: text };
    if (p.outcome === 'pending_answer') return { ...base, outcome: 'pending_answer' };
    if (p.outcome === 'learning') return { ...base, outcome: 'learning', detail: p.detail };
    if (p.outcome === 'model_command') {
      return { ...base, outcome: 'model_command', tier: p.tier };
    }
    return {
      ...base,
      outcome: 'agent',
      request: p.request,
      tier: p.decision.tier,
      speed: p.decision.speed,
      model: p.model,
      decidedBy: p.decision.decidedBy,
      reason: p.decision.reason,
      kind: p.decision.kind,
      classifier: p.classifier,
      skills: p.skills,
    };
  }

  #onFrame(frame: Int16Array): void {
    const hit = this.#d.keywords?.process(frame) ?? null;
    const start = this.#samples;
    this.#samples += frame.length;
    this.#recent.push({ frame, start });
    if (this.#recent.length > RECENT_FRAMES) this.#recent.shift();
    const state = this.#sm.state;

    if (state === 'SLEEPING') {
      this.#floor.push(frame);
      if (hit?.keyword === 'wake') {
        this.#d.onWake?.();
        this.#d.conversation.warm?.();
        this.#listen(this.#d.timing.startTimeoutMs);
        this.#replay(hit.startSample);
      } else if (this.#d.wakeByTranscript) {
        this.#listenWhileAsleep(frame);
      }
      return;
    }
    if (hit?.keyword === 'stop') {
      this.stop();
      return;
    }
    if (
      hit?.keyword === 'wake' &&
      (state === 'THINKING' || state === 'SPEAKING' || state === 'FOLLOW_UP')
    ) {
      // "Jarvis, ..." while busy: drop what it was doing and listen.
      this.#cancelTask();
      this.#listen(this.#d.timing.startTimeoutMs);
      this.#replay(hit.startSample);
      return;
    }
    if (state === 'AWAITING_APPROVAL') {
      this.#feedApproval(frame);
      return;
    }
    if ((state === 'THINKING' || state === 'SPEAKING') && this.#d.timing.bargeIn !== false) {
      if (this.#barge.push(frame, this.#playing, this.#floor.dbfs)) this.#bargeIn(state);
      return;
    }
    this.#feed(frame);
  }

  /**
   * Spoken approval (CLAUDE.md 9): says what is about to happen, built from the
   * real tool input, and listens for the answer with the strict matcher. The
   * pet shows the request; it can never answer it. Tier 3 needs the code.
   */
  readonly approver: Approver = {
    ask: (request) => this.#askApproval(request),
  };

  async #askApproval(
    request: ApprovalRequest,
  ): Promise<{ outcome: ApprovalOutcome; heard?: string }> {
    const task = this.#task;
    const state = this.#sm.state;
    if (!task || task.signal.aborted || (state !== 'THINKING' && state !== 'SPEAKING')) {
      return { outcome: 'cancel' };
    }
    const deadline = performance.now() + (this.#d.timing.approvalTimeoutMs ?? 20_000);
    this.#sm.to('AWAITING_APPROVAL');
    const code = request.code ? speakCode(request.code) : undefined;
    this.#d.emit({
      type: 'approval_request',
      id: request.id,
      sentence: request.sentence,
      fullText: request.fullText,
      code,
    });
    let outcome: ApprovalOutcome = 'cancel';
    const heard: string[] = [];
    try {
      const ask = code
        ? `${request.sentence} To confirm, say: confirm ${code}.`
        : `${request.sentence} Approve or cancel?`;
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.#sayDuringApproval(
          attempt === 0 ? ask : 'Please say yes approve, or cancel.',
          task.signal,
        );
        const text = await this.#listenForAnswer(deadline - performance.now(), task.signal);
        if (text === null) {
          outcome = task.signal.aborted ? 'cancel' : 'timeout';
          break;
        }
        heard.push(text);
        if (request.code) {
          outcome = matchConfirmCode(text, request.code);
          break; // a wrong code cancels; it does not ask again
        }
        const answer = matchApproval(text);
        if (answer !== 'unclear') {
          outcome = answer;
          break;
        }
        outcome = 'cancel'; // still unclear after asking again
      }
    } catch {
      outcome = 'cancel';
    } finally {
      const approved = outcome === 'approve' || outcome === 'approve_all';
      this.#d.emit({ type: 'approval_result', id: request.id, approved });
      this.#approvalEp = undefined;
      if (this.#sm.state === 'AWAITING_APPROVAL') this.#sm.to('THINKING');
    }
    return { outcome, heard: heard.join(' / ') || undefined };
  }

  /** Says the approval question (stays in AWAITING_APPROVAL, so the pet keeps the bubble). */
  async #sayDuringApproval(text: string, signal: AbortSignal): Promise<void> {
    const queue = new SpeechQueue({
      tts: this.#d.tts,
      player: this.#d.player,
      signal,
      onSentence: (s) => this.#spokeSentence(s),
      onLevel: (level) => this.#onSpeakLevel(level),
    });
    queue.say(text);
    await queue.done();
    this.#playing = 0;
  }

  /** Records one answer and transcribes it; null on silence until the deadline, or when stopped. */
  #listenForAnswer(withinMs: number, signal: AbortSignal): Promise<string | null> {
    if (withinMs <= 0 || signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (text: string | null) => {
        this.#approvalEp = undefined;
        this.#approvalDone = undefined;
        signal.removeEventListener('abort', onAbort);
        resolve(text);
      };
      const onAbort = () => done(null);
      signal.addEventListener('abort', onAbort, { once: true });
      this.#approvalDone = done;
      const t = this.#d.timing;
      this.#approvalEp = new Endpointer({
        sampleRate: t.sampleRate,
        frameLength: t.frameLength,
        silenceMs: t.silenceMs,
        startTimeoutMs: withinMs,
        maxMs: Math.min(t.maxRecordMs, withinMs + 8000),
        floorDbfs: this.#floor.dbfs,
      });
    });
  }

  #feedApproval(frame: Int16Array): void {
    const ep = this.#approvalEp;
    const done = this.#approvalDone;
    if (!ep || !done) return;
    const r = ep.push(frame);
    this.#d.emit({ type: 'mic_level', level: rmsLevel(frame) });
    if (r.type === 'no_speech') {
      done(null);
    } else if (r.type === 'end') {
      this.#approvalEp = undefined; // stop feeding while transcribing
      void this.#d.stt
        .transcribe(r.pcm, this.#d.timing.sampleRate, { hints: ['approve', 'cancel', 'confirm'] })
        .then((t) => {
          const text = (this.#d.fixTranscript ?? ((x: string) => x))(t.text);
          this.#d.emit({ type: 'transcript_final', text });
          done(text);
        })
        .catch(() => done(''));
    }
  }

  /** While asleep: find a burst of speech and check it for the wake word. */
  #listenWhileAsleep(frame: Int16Array): void {
    if (this.#checkingWake || this.#announcing) return;
    const t = this.#d.timing;
    this.#sleepEp ??= new Endpointer({
      sampleRate: t.sampleRate,
      frameLength: t.frameLength,
      silenceMs: WAKE_SILENCE_MS,
      startTimeoutMs: 10_000, // then start fresh, so memory stays bounded
      maxMs: WAKE_MAX_MS,
      floorDbfs: this.#floor.dbfs,
    });
    const r = this.#sleepEp.push(frame);
    if (r.type === 'no_speech') this.#sleepEp = undefined;
    if (r.type !== 'end') return;
    this.#sleepEp = undefined;
    // Too short to be "Jarvis" (a click, a cough): don't wake Whisper for it.
    if (r.pcm.length < t.sampleRate * WAKE_MIN_SECONDS) return;
    void this.#checkWake(r.pcm, this.#samples);
  }

  async #checkWake(pcm: Int16Array, endSample: number): Promise<void> {
    this.#checkingWake = true;
    try {
      const heard = await this.#d.stt.transcribe(pcm, this.#d.timing.sampleRate, {
        hints: [WAKE_HINT, ...(this.#d.hints?.() ?? [])],
      });
      if (this.#sm.state !== 'SLEEPING') return;
      const rest = afterWakeWord(heard.text);
      if (rest === null) return; // talk that was not for Jarvis
      this.#d.onWake?.();
      this.#d.conversation.warm?.();
      if (rest) {
        // "Jarvis, what's the time" in one breath: that was the request.
        this.#sm.to('LISTENING');
        void this.#turn(pcm, rest);
      } else {
        // Only the name: the request comes now. Keep what was said since.
        this.#listen(this.#d.timing.startTimeoutMs);
        this.#replay(endSample, 0);
      }
    } catch (err) {
      // Shutting down cuts Whisper off mid-check; that is not worth reporting.
      if (!this.#closing) this.#d.onError?.(err);
    } finally {
      this.#checkingWake = false;
    }
  }

  /** A sentence Jarvis is saying: show it, and remember it for the echo check. */
  #spokeSentence(text: string): void {
    this.#d.emit({ type: 'reply_text', text });
    this.#spoken = `${this.#spoken} ${text}`.split(/\s+/).slice(-SPOKEN_WORDS).join(' ');
  }

  #onSpeakLevel(level: number): void {
    this.#playing = level;
    if (level > 0) this.#lastPlayedAt = performance.now();
    this.#d.emit({ type: 'speak_level', level });
  }

  /**
   * The user talks while Jarvis is busy. Thinking (nothing said yet): they had
   * only paused, so the answer is dropped and their whole sentence is heard
   * again, earlier part included. Speaking: Jarvis stops at once and listens.
   */
  #bargeIn(state: 'THINKING' | 'SPEAKING'): void {
    const earlier = state === 'THINKING' ? this.#utterance : undefined;
    this.#cancelTask();
    this.#barge.reset();
    this.#listen(this.#d.timing.startTimeoutMs);
    if (state === 'SPEAKING') this.#echoRisk = 'barge';
    if (earlier) {
      // Their earlier words, without the pause at the end (that pause plus the
      // one before they went on would otherwise count as "finished").
      const n = this.#d.timing.frameLength;
      const end = speechEnd(earlier, n);
      for (let i = 0; i < end && this.#ep; i += n) this.#feed(earlier.subarray(i, i + n));
    }
    // From where they started talking again.
    this.#replay(this.#samples - this.#d.timing.sampleRate * BARGE_IN_REPLAY_SECONDS, 0);
  }

  /**
   * "Jarvis, what's the time" in one breath: the request was already said when
   * the wake word was recognized, so run the recent audio from the phrase start
   * through the endpointer.
   */
  #replay(startSample: number | undefined, marginSeconds = REPLAY_MARGIN_SECONDS): void {
    if (startSample === undefined) return;
    const from = startSample - this.#d.timing.sampleRate * marginSeconds;
    for (const { frame, start } of this.#recent) {
      if (start + frame.length <= from) continue;
      if (!this.#ep) return; // the replayed audio already ended the request
      this.#feed(frame);
    }
  }

  /** One frame of a request being recorded (LISTENING or FOLLOW_UP). */
  #feed(frame: Int16Array): void {
    const state = this.#sm.state;
    if ((state !== 'LISTENING' && state !== 'FOLLOW_UP') || !this.#ep) return;

    const r = this.#ep.push(frame);
    this.#d.emit({ type: 'mic_level', level: rmsLevel(frame) });
    if (r.type === 'speech_start' && performance.now() - this.#lastPlayedAt < ECHO_TAIL_MS) {
      this.#echoRisk ??= 'tail';
    }
    if (r.type === 'speech_start' && state === 'FOLLOW_UP') {
      this.#sm.to('LISTENING');
    } else if (r.type === 'end') {
      this.#ep = undefined;
      const risk = this.#echoRisk;
      this.#echoRisk = undefined;
      void this.#turn(r.pcm, undefined, risk);
    } else if (r.type === 'no_speech') {
      this.#ep = undefined;
      if (this.#testing) this.#reportTest({ outcome: 'nothing', heard: '', text: '', sttMs: 0 });
      this.#d.conversation.reset();
      this.#sm.to('SLEEPING');
    }
  }

  #listen(startTimeoutMs: number): void {
    this.#echoRisk = undefined;
    this.#sm.to('LISTENING');
    this.#ep = this.#newEndpointer(startTimeoutMs);
  }

  #newEndpointer(startTimeoutMs: number): Endpointer {
    const t = this.#d.timing;
    return new Endpointer({
      sampleRate: t.sampleRate,
      frameLength: t.frameLength,
      silenceMs: t.silenceMs,
      startTimeoutMs,
      maxMs: t.maxRecordMs,
      floorDbfs: this.#floor.dbfs,
    });
  }

  #cancelTask(): void {
    this.#task?.abort();
    this.#task = undefined;
    this.#playing = 0;
  }

  /** One request: transcribe, answer, speak, then the follow-up window. */
  async #turn(pcm: Int16Array, alreadyHeard?: string, echoRisk?: 'barge' | 'tail'): Promise<void> {
    const task = new AbortController();
    this.#task = task;
    const { signal } = task;
    // A voice test covers this one utterance only, whatever happens to it.
    const testing = this.#testing;
    this.#testing = false;
    const t0 = performance.now();
    const log: TurnLog = { heard: '', sttMs: 0, firstAudioMs: null, totalMs: 0, stopped: false };
    this.#utterance = pcm;
    this.#barge.reset();
    let filler: NodeJS.Timeout | undefined;
    this.#sm.to('THINKING');
    try {
      const transcript =
        alreadyHeard !== undefined
          ? { text: alreadyHeard, ms: 0 }
          : await this.#d.stt.transcribe(pcm, this.#d.timing.sampleRate, {
              hints: this.#d.hints?.(),
              signal,
            });
      if (signal.aborted) return;
      log.sttMs = transcript.ms;
      const fix = this.#d.fixTranscript ?? ((s: string) => s);
      if (isWakeWordOnly(transcript.text)) {
        // Only "Jarvis" was heard: the request is still coming. Keep listening.
        this.#testing = testing;
        this.#listen(this.#d.timing.startTimeoutMs);
        return;
      }
      const text = fix(stripWakeWord(transcript.text));
      if (testing) {
        // Voice test: report, then back to sleep. Nothing is answered, run or learned.
        this.#reportTest(this.#testResult(transcript.text, text, transcript.ms));
        this.#sm.to('SLEEPING');
        return;
      }
      log.heard = text;
      log.raw = transcript.text;
      if (!text) {
        // Noise, not words: back to sleep without a reply.
        this.#d.conversation.reset();
        this.#sm.to('SLEEPING');
        return;
      }
      if (echoRisk && isOwnEcho(text, this.#spoken)) {
        // The mic heard Jarvis, not the user (10.4): never answer it. An
        // interruption that was really the echo means the echo is louder than
        // learned, so the interruption check gets stricter.
        log.echo = true;
        if (echoRisk === 'barge') this.#barge.falseAlarm();
        this.#followUp();
        return;
      }
      this.#d.emit({ type: 'transcript_final', text });

      const command = matchCommand(text);
      if (command) {
        log.command = command;
        if (command === 'stop' || command === 'sleep') this.stop();
        else if (command === 'mute') this.mute();
        else await this.#speakOnly(this.#lastStatus, signal);
        return;
      }

      const queue = new SpeechQueue({
        tts: this.#d.tts,
        player: this.#d.player,
        signal,
        onStart: () => {
          log.firstAudioMs ??= performance.now() - t0;
          if (!signal.aborted) this.#sm.to('SPEAKING');
        },
        onSentence: (s) => this.#spokeSentence(s),
        onLevel: (level) => this.#onSpeakLevel(level),
      });
      filler = setTimeout(() => {
        if (!queue.started && this.#sm.state === 'THINKING') queue.say('Still working on it.');
      }, this.#d.timing.fillerMs);
      log.result = await this.#d.conversation.ask(text, {
        signal,
        onSentence: (s) => queue.say(s),
        onModel: (tier, model, speed) =>
          this.#d.emit({ type: 'model_selected', tier, model, speed }),
      });
      clearTimeout(filler);
      const tierName = log.result.tier ?? 'no model';
      this.#lastStatus = `I just answered "${text}"${log.result.tier ? ` on the ${tierName} model` : ''}. Nothing else is running.`;
      if ((await queue.done()) === 'stopped' || signal.aborted) {
        log.stopped = true;
        return;
      }
      this.#followUp();
    } catch (err) {
      if (signal.aborted) {
        log.stopped = true;
        return;
      }
      log.error = err instanceof Error ? err.message : String(err);
      await this.#fail(err);
    } finally {
      clearTimeout(filler);
      if (this.#task === task) this.#task = undefined;
      log.totalMs = performance.now() - t0;
      const speed = log.result?.decision?.speed;
      if (speed) {
        const t = this.#d.timing;
        log.latencyBudgetMs = speed === 'instant' ? (t.instantMs ?? t.fillerMs) : t.fillerMs;
        log.latencyMiss = log.firstAudioMs === null || log.firstAudioMs > log.latencyBudgetMs;
      }
      if (log.heard) this.#d.onTurn?.(log);
    }
  }

  async #speakOnly(text: string, signal: AbortSignal): Promise<void> {
    const queue = new SpeechQueue({
      tts: this.#d.tts,
      player: this.#d.player,
      signal,
      onStart: () => {
        if (!signal.aborted) this.#sm.to('SPEAKING');
      },
      onSentence: (s) => this.#spokeSentence(s),
      onLevel: (level) => this.#onSpeakLevel(level),
    });
    queue.say(text);
    if ((await queue.done()) === 'done' && !signal.aborted) this.#followUp();
  }

  #followUp(): void {
    this.#playing = 0;
    this.#sm.to('FOLLOW_UP');
    this.#ep = this.#newEndpointer(this.#d.timing.followUpMs);
  }

  async #fail(err: unknown): Promise<void> {
    this.#d.onError?.(err);
    const message = err instanceof Error ? err.message : String(err);
    this.#d.emit({ type: 'error', message });
    this.#sm.to('ERROR');
    const task = new AbortController();
    this.#task = task;
    try {
      const queue = new SpeechQueue({
        tts: this.#d.tts,
        player: this.#d.player,
        signal: task.signal,
      });
      queue.say('Sorry, something went wrong.');
      await queue.done();
    } catch {
      // Even the apology failed; nothing more to do.
    } finally {
      if (this.#task === task) this.#task = undefined;
      if (this.#sm.state === 'ERROR') {
        this.#d.conversation.reset();
        this.#sm.to('SLEEPING');
      }
    }
  }
}
