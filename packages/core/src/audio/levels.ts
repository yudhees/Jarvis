/** Loudness helpers for 16-bit PCM. Used for the mic meter and the pet's mouth. */

const FULL_SCALE = 32768;
export const SILENCE_DBFS = -96;

/** RMS of samples [start, end) scaled to 0..1. Empty ranges are 0. */
export function rmsLevel(pcm: Int16Array, start = 0, end = pcm.length): number {
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(pcm.length, Math.floor(end));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const s = (pcm[i] as number) / FULL_SCALE;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / (to - from)));
}

/** 0..1 level to dBFS, floored at SILENCE_DBFS. */
export function toDbfs(level: number): number {
  if (level <= 0) return SILENCE_DBFS;
  return Math.max(SILENCE_DBFS, 20 * Math.log10(level));
}

/** A text meter like `[#####.....] -23.4 dBFS`, scaled from -60 dBFS to 0. */
export function meterBar(dbfs: number, width = 40): string {
  const fraction = Math.min(1, Math.max(0, (dbfs + 60) / 60));
  const filled = Math.round(fraction * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${dbfs.toFixed(1).padStart(6)} dBFS`;
}
