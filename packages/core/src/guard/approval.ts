/**
 * The spoken answer to "Approve or cancel?" (CLAUDE.md 9). A strict matcher in
 * code, never the model: it looks at the whole utterance, and anything unclear
 * is not an approval.
 */
export type ApprovalAnswer = 'approve' | 'approve_all' | 'cancel' | 'unclear';

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/** What speech-to-text writes for digits inside the code slot only. */
const MISHEARD_DIGITS: Record<string, string> = {
  won: '1',
  to: '2',
  too: '2',
  tree: '3',
  for: '4',
  fore: '4',
  sex: '6',
  ate: '8',
  nein: '9',
};

/** "forty seven" is how people say 47. */
const TENS: Record<string, string> = {
  ten: '1',
  twenty: '2',
  thirty: '3',
  forty: '4',
  fourty: '4',
  fifty: '5',
  sixty: '6',
  seventy: '7',
  eighty: '8',
  ninety: '9',
};

/** Lowercase, punctuation gone, number words as digits, single spaces. */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(' ');
}

const APPROVE = new Set(['yes approve', 'go ahead', 'yes go ahead', 'approve it', 'yes confirm']);
const APPROVE_ALL = new Set(['approve all', 'yes approve all', 'approve all for this task']);
/** Any of these anywhere cancels, and cancel beats approve ("I don't approve"). */
const CANCEL_WORDS = new Set(['cancel', 'no', 'stop', 'dont', 'not', 'wait', 'nope']);

export function isCancel(normalized: string): boolean {
  const words = normalized.split(' ');
  return words.some((w) => CANCEL_WORDS.has(w)) || normalized.includes('do not');
}

/**
 * Tier 2 answer. A single word never approves (CLAUDE.md 10.4): "approve" or
 * "confirm" alone could be a stray word from a video, so it is unclear and
 * Jarvis asks once more.
 */
export function matchApproval(text: string): ApprovalAnswer {
  const said = normalizeAnswer(text);
  if (!said) return 'unclear';
  if (isCancel(said)) return 'cancel';
  if (APPROVE_ALL.has(said)) return 'approve_all';
  if (APPROVE.has(said)) return 'approve';
  return 'unclear';
}

/** Two random digits for a tier 3 confirmation ("confirm four seven"). */
export function newConfirmCode(random: () => number = Math.random): string {
  const digit = () => String(Math.floor(random() * 10) % 10);
  return digit() + digit();
}

/** "47" -> "four seven", as Jarvis says it. */
export function speakCode(code: string): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  return [...code].map((d) => words[Number(d)] ?? d).join(' ');
}

/**
 * Tier 3 answer: "confirm" and the exact code ("confirm 47", "confirm four
 * seven", "confirm for seven"). Anything else, including a wrong code, cancels;
 * it does not ask again.
 */
export function matchConfirmCode(text: string, code: string): 'approve' | 'cancel' {
  const said = normalizeAnswer(text);
  const words = said.split(' ');
  const at = words.indexOf('confirm');
  if (at < 0) return 'cancel';
  const before = words.slice(0, at).join(' ');
  if (before && before !== 'yes' && before !== 'ok' && before !== 'okay') return 'cancel';
  const slot = words.slice(at + 1);
  let digits = '';
  for (let i = 0; i < slot.length; i++) {
    const w = slot[i] ?? '';
    const tens = TENS[w];
    if (tens !== undefined) {
      // "forty seven" -> 47, "forty" -> 40
      const next = slot[i + 1];
      const unit = next ? (MISHEARD_DIGITS[next] ?? next) : '';
      if (/^[1-9]$/.test(unit)) {
        digits += tens + unit;
        i++;
      } else {
        digits += `${tens}0`;
      }
    } else {
      digits += MISHEARD_DIGITS[w] ?? w;
    }
  }
  return /^\d+$/.test(digits) && digits === code ? 'approve' : 'cancel';
}
