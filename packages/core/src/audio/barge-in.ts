import { rmsLevel, toDbfs, voicing } from './levels.ts';

/** Speech must be this far above the room's noise... */
const ABOVE_FLOOR_DB = 18;
/** ...and at least this loud. */
const MIN_USER_DBFS = -50;
/** While Jarvis plays audio, the mic must beat the expected echo by this much. */
const ABOVE_ECHO_DB = 10;
/** Output quieter than this counts as "not playing". */
const PLAYING_DBFS = -55;
/** First guess of how loud Jarvis's own voice is at the mic, relative to what it plays. */
const START_ECHO_GAP_DB = -12;
/** A frame with a pitch at least this clear counts as a voice (noise stays well below). */
const VOICED = 0.5;
/** Share of the needed frames that must be voiced (consonants and gaps are not). */
const VOICED_SHARE = 0.7;
/** Extra frames of slack in the window, for short gaps between words. */
const WINDOW_SLACK = 5;

export interface BargeInOptions {
  frameMs: number;
  sampleRate: number;
  /** How long the user must keep talking to count (filters coughs and clicks). */
  minSpeechMs: number;
}

/**
 * Notices the user talking while Jarvis is busy (CLAUDE.md phase 5 barge-in).
 *
 * While Jarvis speaks through speakers, the mic also hears Jarvis. This keeps a
 * running estimate of that echo (mic level minus played level, which only rises
 * slowly, so the user's voice barely moves it) and only reports the user when
 * the mic is clearly louder than the echo for a moment.
 *
 * Loud is not enough: a door, a chair, typing or a cup set down is loud too. So
 * most of those frames must also be voiced (have a pitch, see `voicing`), which
 * a voice has and those noises do not.
 */
export class BargeIn {
  readonly #need: number;
  readonly #needVoiced: number;
  readonly #window: number;
  readonly #rate: number;
  #echoGap = START_ECHO_GAP_DB;
  /** Recent frames: 0 quiet or noise, 1 loud, 2 loud and voiced. */
  #recent: number[] = [];

  constructor(o: BargeInOptions) {
    this.#need = Math.max(1, Math.ceil(o.minSpeechMs / o.frameMs));
    this.#needVoiced = Math.max(1, Math.ceil(this.#need * VOICED_SHARE));
    this.#window = this.#need + WINDOW_SLACK;
    this.#rate = o.sampleRate;
  }

  /** Starts a new busy period (keeps the learned echo level). */
  reset(): void {
    this.#recent = [];
  }

  /**
   * One mic frame. `playing` is the level (0..1) of what Jarvis is playing right
   * now, `floorDbfs` the room noise. Returns true once the user is talking.
   */
  push(frame: Int16Array, playing: number, floorDbfs: number | undefined): boolean {
    const mic = toDbfs(rmsLevel(frame));
    const out = toDbfs(playing);
    const isPlaying = out > PLAYING_DBFS;
    let user = mic > Math.max((floorDbfs ?? -70) + ABOVE_FLOOR_DB, MIN_USER_DBFS);
    if (isPlaying) {
      const gap = mic - out;
      user &&= gap > this.#echoGap + ABOVE_ECHO_DB;
      // Learn the echo: follow it down quickly, up only slowly.
      this.#echoGap += (gap - this.#echoGap) * (gap < this.#echoGap ? 0.2 : 0.02);
    }
    const mark = !user ? 0 : voicing(frame, this.#rate) >= VOICED ? 2 : 1;
    this.#recent.push(mark);
    if (this.#recent.length > this.#window) this.#recent.shift();
    const loud = this.#recent.filter((m) => m > 0).length;
    const voiced = this.#recent.filter((m) => m === 2).length;
    return loud >= this.#need && voiced >= this.#needVoiced;
  }
}
