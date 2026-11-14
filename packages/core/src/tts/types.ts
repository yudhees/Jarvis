/** 16-bit mono PCM. */
export interface TtsAudio {
  sampleRate: number;
  pcm: Int16Array;
}

/**
 * Text-to-speech returns audio and never plays it. Core plays it, so it can
 * measure the speak level and stop at once (CLAUDE.md section 4).
 */
export interface TtsProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<TtsAudio>;
  close(): Promise<void>;
}
