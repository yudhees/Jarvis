import type { CoreToPetEvent, JarvisState } from '@jarvis/shared';
import type { AudioPlayer } from '../audio/index.ts';
import { Endpointer, type KeywordSpotter, NoiseFloor, rmsLevel } from '../audio/index.ts';
import { StateMachine } from '../state/index.ts';
import type { SttProvider } from '../stt/index.ts';
import type { TtsProvider } from '../tts/index.ts';
import { matchCommand, stripWakeWord } from './commands.ts';
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
  keywords: KeywordSpotter;
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
export class VoiceLoop {
  readonly #d: VoiceLoopDeps;
  readonly #sm: StateMachine;
  readonly #floor = new NoiseFloor();
  #ep: Endpointer | undefined;
  #task: AbortController | undefined;
  #mic: AbortController | undefined;
  #unmuted: PromiseWithResolvers<void> | undefined;
  #lastStatus = 'Nothing yet.';

  constructor(deps: VoiceLoopDeps) {
    this.#d = deps;
    this.#sm = new StateMachine((state) => deps.emit({ type: 'state', state }));
  }

  get state(): JarvisState {
    return this.#sm.state;
  }

  /** Runs until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => {
      this.#cancelTask();
      this.#mic?.abort();
      this.#unmuted?.resolve();
    });
    while (!signal.aborted) {
      if (this.#sm.state === 'MUTED') {
        this.#unmuted = Promise.withResolvers();
        await this.#unmuted.promise;
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
    this.#unmuted?.resolve();
  }

  toggleMute(): void {
    if (this.#sm.state === 'MUTED') this.unmute();
    else this.mute();
  }

  #onFrame(frame: Int16Array): void {
    const keyword = this.#d.keywords.process(frame);
    const state = this.#sm.state;

    if (state === 'SLEEPING') {
      this.#floor.push(frame);
      if (keyword === 'wake') {
        this.#d.onWake?.();
        this.#listen(this.#d.timing.startTimeoutMs);
      }
      return;
    }
    if (keyword === 'stop') {
      this.stop();
      return;
    }
    if (
      keyword === 'wake' &&
      (state === 'THINKING' || state === 'SPEAKING' || state === 'FOLLOW_UP')
    ) {
      // "Jarvis, ..." while busy: drop what it was doing and listen.
      this.#cancelTask();
      this.#listen(this.#d.timing.startTimeoutMs);
      return;
    }
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
