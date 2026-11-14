import type { CoreToPetEvent, JarvisState } from '@jarvis/shared';
import type { AudioPlayer } from '../audio/index.ts';
import { Endpointer, type KeywordSpotter, NoiseFloor, rmsLevel } from '../audio/index.ts';
import { StateMachine } from '../state/index.ts';
import type { SttProvider } from '../stt/index.ts';
import type { TtsProvider } from '../tts/index.ts';
import { isWakeWordOnly, matchCommand, stripWakeWord } from './commands.ts';
import type { AskOptions, AskResult } from './conversation.ts';
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
}

/** The parts of Conversation the loop uses. */
export interface Asker {
  ask(text: string, options: AskOptions): Promise<AskResult>;
  reset(): void;
  warm?(): void;
}

export interface TurnLog {
  heard: string;
  sttMs: number;
  /** From the end of speech to the first audio playing. */
  firstAudioMs: number | null;
  totalMs: number;
  result?: AskResult;
  command?: string;
  stopped: boolean;
}

export interface VoiceLoopDeps {
  /** Mic frames; iteration stops (and the device is released) when the signal aborts. */
  frames: (signal: AbortSignal) => AsyncIterable<Int16Array>;
  /**
   * Wake/stop keyword spotter. Null = no wake word: the user presses the talk
   * hotkey (`talk()`), and the mic is closed completely while Jarvis sleeps.
   */
  keywords: KeywordSpotter | null;
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

  constructor(deps: VoiceLoopDeps) {
    this.#d = deps;
    this.#sm = new StateMachine((state) => {
      deps.emit({ type: 'state', state });
      // Without a wake word nothing needs to hear the room while asleep: release the mic.
      if (state === 'SLEEPING' && !deps.keywords) this.#mic?.abort();
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
      this.#cancelTask();
      this.#mic?.abort();
      this.#resume?.resolve();
    });
    while (!signal.aborted) {
      const state = this.#sm.state;
      if (state === 'MUTED' || (state === 'SLEEPING' && !this.#d.keywords)) {
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

  /** Kill switch: voice, hotkey, or tray. Cancels the task, stops audio, sleeps. */
  stop(): void {
    if (this.#sm.state === 'MUTED') return;
    this.#cancelTask();
    this.#ep = undefined;
    this.#d.conversation.reset();
    this.#sm.to('SLEEPING');
  }

  /** Mic fully off (the device is released). */
  mute(): void {
    if (this.#sm.state === 'MUTED') return;
    this.#cancelTask();
    this.#ep = undefined;
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
    this.#feed(frame);
  }

  /**
   * "Jarvis, what's the time" in one breath: the request was already said when
   * the wake word was recognized, so run the recent audio from the phrase start
   * through the endpointer.
   */
  #replay(startSample: number | undefined): void {
    if (startSample === undefined) return;
    const from = startSample - this.#d.timing.sampleRate * REPLAY_MARGIN_SECONDS;
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
    if (r.type === 'speech_start' && state === 'FOLLOW_UP') {
      this.#sm.to('LISTENING');
    } else if (r.type === 'end') {
      this.#ep = undefined;
      void this.#turn(r.pcm);
    } else if (r.type === 'no_speech') {
      this.#ep = undefined;
      this.#d.conversation.reset();
      this.#sm.to('SLEEPING');
    }
  }

  #listen(startTimeoutMs: number): void {
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
  }

  /** One request: transcribe, answer, speak, then the follow-up window. */
  async #turn(pcm: Int16Array): Promise<void> {
    const task = new AbortController();
    this.#task = task;
    const { signal } = task;
    const t0 = performance.now();
    const log: TurnLog = { heard: '', sttMs: 0, firstAudioMs: null, totalMs: 0, stopped: false };
    let filler: NodeJS.Timeout | undefined;
    this.#sm.to('THINKING');
    try {
      const transcript = await this.#d.stt.transcribe(pcm, this.#d.timing.sampleRate, {
        hints: this.#d.hints?.(),
        signal,
      });
      if (signal.aborted) return;
      log.sttMs = transcript.ms;
      const fix = this.#d.fixTranscript ?? ((s: string) => s);
      if (isWakeWordOnly(transcript.text)) {
        // Only "Jarvis" was heard: the request is still coming. Keep listening.
        this.#listen(this.#d.timing.startTimeoutMs);
        return;
      }
      const text = fix(stripWakeWord(transcript.text));
      log.heard = text;
      if (!text) {
        // Noise, not words: back to sleep without a reply.
        this.#d.conversation.reset();
        this.#sm.to('SLEEPING');
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
        onSentence: (s) => this.#d.emit({ type: 'reply_text', text: s }),
        onLevel: (level) => this.#d.emit({ type: 'speak_level', level }),
      });
      filler = setTimeout(() => {
        if (!queue.started) queue.say('Still working on it.');
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
      await this.#fail(err);
    } finally {
      clearTimeout(filler);
      if (this.#task === task) this.#task = undefined;
      log.totalMs = performance.now() - t0;
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
      onSentence: (s) => this.#d.emit({ type: 'reply_text', text: s }),
      onLevel: (level) => this.#d.emit({ type: 'speak_level', level }),
    });
    queue.say(text);
    if ((await queue.done()) === 'done' && !signal.aborted) this.#followUp();
  }

  #followUp(): void {
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
