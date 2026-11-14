/**
 * Cuts streamed model text into sentences, so the first one can be spoken
 * while the rest is still being written (CLAUDE.md 7.1, instant speed).
 */
export class SentenceSplitter {
  #buf = '';

  /** Adds streamed text; returns the sentences that are now complete. */
  push(delta: string): string[] {
    this.#buf += delta;
    const out: string[] = [];
    // End of sentence: . ! ? (optionally followed by quotes/brackets), then whitespace.
    const re = /[.!?]+["')\]]*\s+/g;
    let start = 0;
    for (let m = re.exec(this.#buf); m; m = re.exec(this.#buf)) {
      const end = m.index + m[0].length;
      const sentence = this.#buf.slice(start, end).trim();
      // Skip splits after very short pieces ("e.g.", "Mr.", "1.") by merging forward.
      if (sentence.length < 12 || endsWithAbbreviation(sentence)) continue;
      out.push(sentence);
      start = end;
    }
    this.#buf = this.#buf.slice(start);
    return out;
  }

  /** Whatever is left when the stream ends. */
  flush(): string | undefined {
    const rest = this.#buf.trim();
    this.#buf = '';
    return rest || undefined;
  }
}

/** Spoken form of the local date and time for the system prompt (CLAUDE.md 8). */
export function spokenNow(date = new Date()): string {
  const day = date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${day}, ${time} (${zone})`;
}

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'vs',
  'etc',
  'st',
  'no',
  'approx',
  'jr',
  'sr',
]);

/** "e.g.", "i.e.", "Dr." and the like do not end a sentence. */
function endsWithAbbreviation(sentence: string): boolean {
  const last = (sentence.split(/\s+/).at(-1) ?? '').replace(/["')\]]+$/, '');
  if (!last.endsWith('.')) return false;
  const word = last.slice(0, -1).toLowerCase();
  return /^(?:[a-z]\.)+[a-z]$/.test(word) || ABBREVIATIONS.has(word);
}
