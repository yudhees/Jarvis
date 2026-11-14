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
/**
 * At the start of each reply, Jarvis only learns how loud its own voice is at
 * the mic and never counts it as the user. People rarely interrupt in the
 * first half second, and on loud speakers the echo is far above the first guess.
 */
const GRACE_MS = 700;
/** How fast the echo estimate follows during the grace period. */
const GRACE_RATE = 0.3;
/** A false interrupt (Jarvis heard itself): assume the echo is this much louder. */
const FALSE_ALARM_DB = 6;
/** The echo estimate never goes above this (mic 20 dB louder than playback). */
const MAX_ECHO_GAP_DB = 20;

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
  readonly #graceFrames: number;
  #echoGap = START_ECHO_GAP_DB;
  /** Playing frames heard since reset(), for the grace period. */
  #playedFrames = 0;
  /** Recent frames: 0 quiet or noise, 1 loud, 2 loud and voiced. */
  #recent: number[] = [];

  constructor(o: BargeInOptions) {
    this.#need = Math.max(1, Math.ceil(o.minSpeechMs / o.frameMs));
    this.#needVoiced = Math.max(1, Math.ceil(this.#need * VOICED_SHARE));
    this.#window = this.#need + WINDOW_SLACK;
    this.#rate = o.sampleRate;
    this.#graceFrames = Math.ceil(GRACE_MS / o.frameMs);
  }

  /** Starts a new busy period (keeps the learned echo level). */
  reset(): void {
    this.#recent = [];
    this.#playedFrames = 0;
  }

  /** The learned echo gap in dB (mic level minus played level), for tests and logs. */
  get echoGapDb(): number {
    return this.#echoGap;
  }

  /**
   * What was taken for the user turned out to be Jarvis's own words: the echo
   * is louder than learned, so be stricter from now on.
   */
  falseAlarm(): void {
    this.#echoGap = Math.min(this.#echoGap + FALSE_ALARM_DB, MAX_ECHO_GAP_DB);
    this.reset();
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
      const grace = this.#playedFrames++ < this.#graceFrames;
      user &&= !grace && gap > this.#echoGap + ABOVE_ECHO_DB;
      // Learn the echo. During the grace period: up quickly, down slowly, so it
      // settles near the loudest echo. After it: down quickly, up only slowly, so
      // the user's voice barely moves it.
      const up = gap > this.#echoGap;
      const rate = grace ? (up ? GRACE_RATE : 0.05) : up ? 0.02 : 0.2;
      this.#echoGap = Math.min(this.#echoGap + (gap - this.#echoGap) * rate, MAX_ECHO_GAP_DB);
    }
    const mark = !user ? 0 : voicing(frame, this.#rate) >= VOICED ? 2 : 1;
    this.#recent.push(mark);
    if (this.#recent.length > this.#window) this.#recent.shift();
    const loud = this.#recent.filter((m) => m > 0).length;
    const voiced = this.#recent.filter((m) => m === 2).length;
    return loud >= this.#need && voiced >= this.#needVoiced;
  }
}
