/**
 * Telling Jarvis's own voice from the user's by the words (CLAUDE.md 10.4).
 *
 * On speakers, the mic hears Jarvis. If that slips past the level-based echo
 * filter (barge-in, follow-up), Whisper writes down Jarvis's own words, often
 * just the start of a sentence and slightly off ("No prop." for "No problem").
 * Jarvis must never answer itself, so such a transcript is dropped.
 */

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/** Edit distance, for short words only. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j] ?? 0;
      row[j] = Math.min(cur + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length] ?? 0;
}

/**
 * Same word as Whisper might write it: equal, cut short ("weather" from
 * "weather's"), cut short and one letter off ("prop" from "problem"), or one
 * letter off.
 */
function alike(heard: string, said: string): boolean {
  if (heard === said) return true;
  if (heard.length >= 3 && said.length >= 3 && (said.startsWith(heard) || heard.startsWith(said)))
    return true;
  if (heard.length >= 4 && said.length > heard.length)
    return distance(heard, said.slice(0, heard.length)) <= 1;
  return heard.length >= 4 && said.length >= 4 && distance(heard, said) <= 1;
}

/** Share of heard words needed, in order, inside what Jarvis said. */
const MATCH_SHARE = 0.75;

/**
 * True when `heard` is (mostly) words Jarvis just said, in the same order.
 * Short transcripts must match fully, so "yes" after Jarvis said "yes" counts,
 * but "open Slack" after "Opened a search" does not.
 */
export function isOwnEcho(heard: string, spoken: string): boolean {
  const h = words(heard);
  const s = words(spoken);
  if (h.length === 0 || s.length === 0) return false;
  let matched = 0;
  let at = 0;
  for (const w of h) {
    for (let j = at; j < s.length; j++) {
      const said = s[j];
      if (said !== undefined && alike(w, said)) {
        matched++;
        at = j + 1;
        break;
      }
    }
  }
  const need = h.length <= 2 ? h.length : Math.ceil(h.length * MATCH_SHARE);
  return matched >= need;
}
