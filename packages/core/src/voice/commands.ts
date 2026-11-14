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
