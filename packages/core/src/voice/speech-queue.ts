import type { AudioPlayer } from '../audio/index.ts';
import type { TtsAudio, TtsProvider } from '../tts/index.ts';

export interface SpeechQueueOptions {
  tts: TtsProvider;
  player: AudioPlayer;
  signal: AbortSignal;
  /** First audio is about to play. */
  onStart?: () => void;
  onSentence?: (text: string) => void;
  onLevel?: (level: number) => void;
}

/**
 * Speaks sentences in order. The next sentence is synthesized while the current
 * one plays, so there is no gap between them. Aborting the signal stops at once.
 */
export class SpeechQueue {
  readonly #o: SpeechQueueOptions;
  readonly #pending: { text: string; audio: Promise<TtsAudio> }[] = [];
  #running: Promise<void> | undefined;
  #started = false;
  #error: unknown;

  constructor(options: SpeechQueueOptions) {
    this.#o = options;
  }

  get started(): boolean {
    return this.#started;
  }

  say(text: string): void {
    if (this.#o.signal.aborted) return;
    const audio = this.#o.tts.synthesize(text, this.#o.signal);
    audio.catch(() => {}); // handled when played
    this.#pending.push({ text, audio });
    this.#running ??= this.#drain();
  }

  /** Resolves when everything said so far has played (or was stopped). */
  async done(): Promise<'done' | 'stopped'> {
    while (this.#running) {
      const r = this.#running;
      await r;
      if (r === this.#running) this.#running = undefined;
    }
    if (this.#error && !this.#o.signal.aborted) throw this.#error;
    return this.#o.signal.aborted ? 'stopped' : 'done';
  }

  async #drain(): Promise<void> {
    try {
      for (let next = this.#pending.shift(); next; next = this.#pending.shift()) {
        if (this.#o.signal.aborted) return;
        const audio = await next.audio;
        if (this.#o.signal.aborted) return;
        if (!this.#started) {
          this.#started = true;
          this.#o.onStart?.();
        }
        this.#o.onSentence?.(next.text);
        const r = await this.#o.player.play(audio.pcm, audio.sampleRate, {
          signal: this.#o.signal,
          onLevel: this.#o.onLevel,
        });
        if (r === 'stopped') return;
      }
    } catch (err) {
      this.#error ??= err;
    } finally {
      this.#running = undefined;
    }
  }
}
