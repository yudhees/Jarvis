export interface Transcript {
  text: string;
  /** Time spent turning the audio into text. */
  ms: number;
}

export interface TranscribeOptions {
  /** Words to expect (names, projects) so they are spelled right. From Learner.vocabularyHints(). */
  hints?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Speech-to-text: audio in, text out (CLAUDE.md 4). Kept behind an interface so
 * a local or cloud provider can be swapped without touching anything else.
 */
export interface SttProvider {
  /** 16-bit mono PCM. */
  transcribe(pcm: Int16Array, sampleRate: number, options?: TranscribeOptions): Promise<Transcript>;
  close(): Promise<void>;
}
