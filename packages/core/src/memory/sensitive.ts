/**
 * Things Jarvis must never store in memory or learn (CLAUDE.md 13 and 13.1):
 * passwords, keys, card numbers, and health data. Returns a short spoken reason,
 * or null when the text looks safe.
 */

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // Anthropic / OpenAI style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key IDs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const SECRET_WORDS =
  /\b(passwords?|passcodes?|passwd|pin(?: code| number)?|api keys?|secret keys?|private keys?|access keys?|tokens?|credentials?|ssn|social security|cvv|security code)\b/i;

const HEALTH_WORDS =
  /\b(diagnos\w*|medications?|medicines?|prescri\w*|therap(?:y|ist)|diseases?|illness\w*|symptoms?|blood pressure|pregnan\w*|hiv|cancer|depress\w*|anxiety|diabet\w*|surgery|disorder)\b/i;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\d[\d -]{11,22}\d/g)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

export function findSensitive(text: string): string | null {
  if (TOKEN_PATTERNS.some((re) => re.test(text)) || SECRET_WORDS.test(text)) {
    return 'passwords, keys, or tokens';
  }
  if (hasCardNumber(text)) return 'card numbers';
  if (HEALTH_WORDS.test(text)) return 'health information';
  return null;
}
