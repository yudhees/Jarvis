import { rmsLevel, toDbfs } from './levels.ts';

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

export interface BargeInOptions {
  frameMs: number;
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
 */
export class BargeIn {
  readonly #need: number;
  #echoGap = START_ECHO_GAP_DB;
  #run = 0;

  constructor(o: BargeInOptions) {
    this.#need = Math.max(1, Math.ceil(o.minSpeechMs / o.frameMs));
  }

  /** Starts a new busy period (keeps the learned echo level). */
  reset(): void {
    this.#run = 0;
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
    this.#run = user ? this.#run + 1 : 0;
    return this.#run >= this.#need;
  }
}
