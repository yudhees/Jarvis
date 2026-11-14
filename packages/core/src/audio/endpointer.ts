import { rmsLevel, toDbfs } from './levels.ts';

export interface EndpointerOptions {
  sampleRate: number;
  frameLength: number;
  /** Quiet time after speech that ends the utterance. */
  silenceMs: number;
  /** Give up if speech has not started by then. */
  startTimeoutMs: number;
  /** Hard cap on the whole recording. */
  maxMs: number;
  /** Room noise level measured while asleep (NoiseFloor); else learned from the first frames. */
  floorDbfs?: number;
}

export type EndpointResult =
  | { type: 'continue'; speaking: boolean; dbfs: number }
  /** Speech just started (FOLLOW_UP switches to LISTENING on this). */
  | { type: 'speech_start'; dbfs: number }
  | { type: 'end'; reason: 'silence' | 'max'; pcm: Int16Array }
  | { type: 'no_speech' };

/** Speech must be this far above the room's noise floor... */
const ABOVE_FLOOR_DB = 15;
/** ...and at least this loud. */
const MIN_SPEECH_DBFS = -60;
/** Frames of loud audio (out of the last few) that count as speech starting. */
const START_FRAMES = 3;
const START_WINDOW = 5;
/** Audio kept from before speech started, so the first syllable is not cut. */
const PRE_ROLL_MS = 300;

/**
 * Finds where an utterance starts and ends with a simple energy check against an
 * adaptive noise floor (CLAUDE.md 4: silence timer first, proper VAD in phase 5).
 * Feed it every mic frame; it returns the utterance audio when the user stops.
 */
export class Endpointer {
  readonly #o: EndpointerOptions;
  readonly #frameMs: number;
  readonly #frames: Int16Array[] = [];
  #floor: number | undefined;
  #recent: boolean[] = [];
  #startedAt = -1;
  #quietMs = 0;
  #done = false;

  constructor(options: EndpointerOptions) {
    this.#o = options;
    this.#frameMs = (options.frameLength / options.sampleRate) * 1000;
    this.#floor = options.floorDbfs;
  }

  get started(): boolean {
    return this.#startedAt >= 0;
  }

  get elapsedMs(): number {
    return this.#frames.length * this.#frameMs;
  }

  push(frame: Int16Array): EndpointResult {
    if (this.#done) throw new Error('endpointer already finished');
    this.#frames.push(frame);
    const dbfs = toDbfs(rmsLevel(frame));
    const loud = dbfs > Math.max((this.#floor ?? dbfs) + ABOVE_FLOOR_DB, MIN_SPEECH_DBFS);
    if (!loud || this.#floor === undefined) {
      // Track the room's noise floor on quiet frames only.
      this.#floor = this.#floor === undefined ? dbfs : this.#floor * 0.9 + dbfs * 0.1;
    }

    if (!this.started) {
      this.#recent.push(loud);
      if (this.#recent.length > START_WINDOW) this.#recent.shift();
      if (this.#recent.filter(Boolean).length >= START_FRAMES) {
        this.#startedAt = Math.max(0, this.#frames.length - START_WINDOW);
        return { type: 'speech_start', dbfs };
      }
      if (this.elapsedMs >= this.#o.startTimeoutMs) {
        this.#done = true;
        return { type: 'no_speech' };
      }
      return { type: 'continue', speaking: false, dbfs };
    }

    this.#quietMs = loud ? 0 : this.#quietMs + this.#frameMs;
    if (this.#quietMs >= this.#o.silenceMs) return this.#finish('silence');
    if (this.elapsedMs >= this.#o.maxMs) return this.#finish('max');
    return { type: 'continue', speaking: loud, dbfs };
  }

  #finish(reason: 'silence' | 'max'): EndpointResult {
    this.#done = true;
    const preRoll = Math.ceil(PRE_ROLL_MS / this.#frameMs);
    const from = Math.max(0, this.#startedAt - preRoll);
    // Keep a little of the trailing quiet; drop the rest.
    const tailDrop = Math.max(0, Math.floor((this.#quietMs - 200) / this.#frameMs));
    const kept = this.#frames.slice(from, this.#frames.length - tailDrop);
    const pcm = new Int16Array(kept.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of kept) {
      pcm.set(f, at);
      at += f.length;
    }
    return { type: 'end', reason, pcm };
  }
}

/**
 * Tracks the room noise level from every mic frame while Jarvis waits, so the
 * endpointer knows what "quiet" is the moment the wake word is heard. Falls
 * fast and rises slowly, so speech barely moves it.
 */
export class NoiseFloor {
  #dbfs: number | undefined;

  get dbfs(): number | undefined {
    return this.#dbfs;
  }

  push(frame: Int16Array): void {
    const dbfs = toDbfs(rmsLevel(frame));
    if (this.#dbfs === undefined) this.#dbfs = dbfs;
    else this.#dbfs += (dbfs - this.#dbfs) * (dbfs < this.#dbfs ? 0.3 : 0.01);
  }
}
