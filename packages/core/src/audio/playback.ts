import pvspeaker from '@picovoice/pvspeaker-node';
import { rmsLevel } from './levels.ts';

const { PvSpeaker } = pvspeaker;

export interface PlayOptions {
  /** Abort to stop playback immediately (kill switch, barge-in). */
  signal?: AbortSignal;
  /** Called about every 30 ms with the level (0..1) of what is playing now. */
  onLevel?: (level: number) => void;
}

export type PlayResult = 'done' | 'stopped';

export interface AudioPlayer {
  play(pcm: Int16Array, sampleRate: number, options?: PlayOptions): Promise<PlayResult>;
}

const TICK_MS = 30;
const LEVEL_WINDOW_SECS = 0.05;
const TAIL_MARGIN_SECS = 0.15;

/**
 * Plays 16-bit mono PCM through PvSpeaker. Core plays all audio itself so it can
 * report speak levels and stop instantly.
 *
 * It never calls PvSpeaker.flush(), which blocks the event loop until playback ends.
 * Instead it keeps the device buffer topped up from a timer and tracks the play
 * position from the clock.
 */
export class PvSpeakerPlayer implements AudioPlayer {
  readonly deviceIndex: number;
  readonly bufferSizeSecs: number;

  /** `bufferSizeSecs` must be a whole number; PvSpeaker's native layer rejects fractions. */
  constructor(deviceIndex = -1, bufferSizeSecs = 1) {
    if (!Number.isInteger(bufferSizeSecs) || bufferSizeSecs < 1) {
      throw new Error('bufferSizeSecs must be a whole number of seconds, at least 1');
    }
    this.deviceIndex = deviceIndex;
    this.bufferSizeSecs = bufferSizeSecs;
  }

  static devices(): string[] {
    return PvSpeaker.getAvailableDevices();
  }

  play(pcm: Int16Array, sampleRate: number, options: PlayOptions = {}): Promise<PlayResult> {
    const { signal, onLevel } = options;
    if (signal?.aborted) return Promise.resolve('stopped');
    if (pcm.length === 0) return Promise.resolve('done');

    const speaker = new PvSpeaker(sampleRate, 16, {
      bufferSizeSecs: this.bufferSizeSecs,
      deviceIndex: this.deviceIndex,
    });
    const chunkSamples = Math.floor(sampleRate * 0.1);
    const windowSamples = sampleRate * LEVEL_WINDOW_SECS;
    const endSamples = pcm.length + sampleRate * TAIL_MARGIN_SECS;

    return new Promise<PlayResult>((resolve, reject) => {
      let offset = 0;
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      const startedAt = performance.now();

      const finish = (result: PlayResult | Error) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        signal?.removeEventListener('abort', onAbort);
        try {
          speaker.stop();
        } catch {
          // already stopped
        }
        speaker.release();
        onLevel?.(0);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onAbort = () => finish('stopped');

      const tick = () => {
        try {
          while (offset < pcm.length) {
            const chunk = pcm.slice(offset, offset + chunkSamples);
            const written = speaker.write(chunk.buffer);
            offset += written;
            if (written < chunk.length) break; // device buffer full
          }
          const played = ((performance.now() - startedAt) / 1000) * sampleRate;
          onLevel?.(rmsLevel(pcm, played - windowSamples, played));
          if (offset >= pcm.length && played >= endSamples) finish('done');
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      };

      try {
        speaker.start();
      } catch (err) {
        speaker.release();
        reject(err);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setInterval(tick, TICK_MS);
      tick();
    });
  }
}
