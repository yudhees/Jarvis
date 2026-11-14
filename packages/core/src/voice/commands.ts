/** Spoken commands matched in code before any model call (CLAUDE.md 6.1). */
export type SpokenCommand = 'stop' | 'sleep' | 'mute' | 'status';

const COMMANDS: Record<SpokenCommand, readonly string[]> = {
  stop: [
    'stop',
    'stop it',
    'stop that',
    'cancel',
    'cancel that',
    'never mind',
    'nevermind',
    'shut up',
    'quiet',
  ],
  sleep: [
    'sleep',
    'go to sleep',
    'goodbye',
    'bye',
    'thats all',
    'thanks thats all',
    'thank you thats all',
    'that is all',
    'nothing',
    'nothing else',
    'no thanks',
    'no thank you',
  ],
  mute: ['mute', 'mute yourself', 'mute the mic', 'stop listening'],
  status: ['what are you doing', 'what are you working on', 'status'],
};

/** Letters that differ between two words (edit distance). */
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
 * True when all that was heard is the wake word, maybe misheard ("Jabbies!",
 * "Hey Javis"): Jarvis should keep listening rather than answer it.
 */
export function isWakeWordOnly(text: string): boolean {
  const words = normalizeUtterance(text)
    .split(' ')
    .filter((w) => w && !['hey', 'hi', 'ok', 'okay', 'a'].includes(w));
  const [word] = words;
  return words.length === 1 && !!word && word.startsWith('j') && distance(word, 'jarvis') <= 3;
}

/** Lowercase, no punctuation, single spaces. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drops a leading "Jarvis," / "hi Jarvis" that Whisper may have caught after the wake word. */
export function stripWakeWord(text: string): string {
  return text.replace(/^\s*(?:(?:hi|hey|ok|okay)\s+)?jarvis\b[\s,.!?:;-]*/i, '').trim();
}

/** The whole utterance must be the command, so "stop the deploy" is a request, not a stop. */
export function matchCommand(text: string): SpokenCommand | null {
  const said = normalizeUtterance(stripWakeWord(text)).replace(/^(please )|( please)$/g, '');
  for (const [command, phrases] of Object.entries(COMMANDS) as [
    SpokenCommand,
    readonly string[],
  ][]) {
    if (phrases.includes(said)) return command;
  }
  return null;
}
