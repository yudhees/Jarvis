import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { localDate } from './usage.ts';

/**
 * Conversation history for the Settings window's History tab: what Jarvis
 * heard, what it answered, which model, and how long it took, so mistakes can
 * be found and the conversations exported. Text only (raw audio is never kept,
 * CLAUDE.md 10.4); keys, tokens and card numbers are blanked before writing.
 * One JSONL file per day under dataDir/history, whole days deleted after the
 * transcript retention period (CLAUDE.md 10.7).
 */

export type HistoryOutcome = 'answered' | 'command' | 'local' | 'stopped' | 'error';

export interface HistoryTurn {
  at: string; // ISO time the request was finished
  /** Whisper's raw text, before the wake word was removed and fixes applied. */
  heard: string;
  /** The text Jarvis acted on. */
  text: string;
  reply: string;
  outcome: HistoryOutcome;
  command?: string;
  tier?: string;
  model?: string;
  speed?: string;
  decidedBy?: string;
  kind?: string;
  escalations?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  sttMs: number;
  firstWordMs: number | null;
  totalMs: number;
  latencyMiss?: boolean;
  error?: string;
}

export interface HistoryConversation {
  id: string; // time of the first turn
  start: string;
  end: string;
  turns: HistoryTurn[];
}

/** What the voice loop hands over (a subset of its TurnLog). */
export interface HistorySource {
  heard: string;
  raw?: string;
  sttMs: number;
  firstAudioMs: number | null;
  totalMs: number;
  command?: string;
  stopped: boolean;
  latencyMiss?: boolean;
  error?: string;
  result?: {
    reply: string;
    tier: string | null;
    model: string | null;
    decision: { speed: string; decidedBy: string; kind: string } | null;
    escalations: number;
    usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  };
}

/** A new conversation starts after this much quiet. */
export const CONVERSATION_GAP_MS = 90_000;
const MAX_TEXT = 4000;
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const REMOVED = '[removed]';

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
];
/** "my password is hunter2" → the word after the secret name goes. */
const SECRET_VALUE =
  /\b(passwords?|passcodes?|passwd|pin(?: code| number)?|api keys?|secret keys?|private keys?|access keys?|tokens?|cvv|security code)(\s*(?:is|was|=|:)?\s*)(\S+)/gi;

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

/** Blanks keys, tokens, passwords said aloud and card numbers. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REMOVED);
  out = out.replace(SECRET_VALUE, (_m, name: string, sep: string) => `${name}${sep}${REMOVED}`);
  out = out.replace(/\d[\d -]{11,22}\d/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? REMOVED : m;
  });
  return out;
}

function clean(text: string | undefined): string {
  return redactSecrets(String(text ?? '')).slice(0, MAX_TEXT);
}

const round = (n: number) => Math.max(0, Math.round(n));

/** Turns a finished request into a history line (pure, for tests). */
export function toHistoryTurn(t: HistorySource, now: Date = new Date()): HistoryTurn {
  const r = t.result;
  let outcome: HistoryOutcome;
  if (t.error) outcome = 'error';
  else if (t.stopped) outcome = 'stopped';
  else if (t.command) outcome = 'command';
  else if (r?.tier) outcome = 'answered';
  else outcome = 'local';
  const turn: HistoryTurn = {
    at: now.toISOString(),
    heard: clean(t.raw ?? t.heard),
    text: clean(t.heard),
    reply: clean(r?.reply),
    outcome,
    sttMs: round(t.sttMs),
    firstWordMs: t.firstAudioMs === null ? null : round(t.firstAudioMs),
    totalMs: round(t.totalMs),
  };
  if (t.command) turn.command = t.command;
  if (r?.tier) turn.tier = r.tier;
  if (r?.model) turn.model = r.model;
  if (r?.decision) {
    turn.speed = r.decision.speed;
    turn.decidedBy = r.decision.decidedBy;
    turn.kind = r.decision.kind;
  }
  if (r?.tier) {
    turn.escalations = r.escalations;
    turn.inputTokens = r.usage.inputTokens;
    turn.outputTokens = r.usage.outputTokens;
    turn.toolCalls = r.usage.toolCalls;
  }
  if (t.latencyMiss) turn.latencyMiss = true;
  if (t.error) turn.error = clean(t.error).slice(0, 500);
  return turn;
}

const OUTCOMES = new Set<HistoryOutcome>(['answered', 'command', 'local', 'stopped', 'error']);

/** Reads one stored line defensively: anything odd is dropped. */
export function parseHistoryTurn(value: unknown): HistoryTurn | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const str = (k: string) =>
    typeof v[k] === 'string' ? (v[k] as string).slice(0, MAX_TEXT) : undefined;
  const num = (k: string) =>
    typeof v[k] === 'number' && Number.isFinite(v[k]) && (v[k] as number) >= 0
      ? (v[k] as number)
      : undefined;
  const at = str('at');
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const outcome = str('outcome') as HistoryOutcome | undefined;
  if (!outcome || !OUTCOMES.has(outcome)) return null;
  const turn: HistoryTurn = {
    at,
    heard: str('heard') ?? '',
    text: str('text') ?? '',
    reply: str('reply') ?? '',
    outcome,
    sttMs: num('sttMs') ?? 0,
    firstWordMs: num('firstWordMs') ?? null,
    totalMs: num('totalMs') ?? 0,
  };
  for (const k of ['command', 'tier', 'model', 'speed', 'decidedBy', 'kind', 'error'] as const) {
    const s = str(k);
    if (s !== undefined) turn[k] = s;
  }
  for (const k of ['escalations', 'inputTokens', 'outputTokens', 'toolCalls'] as const) {
    const n = num(k);
    if (n !== undefined) turn[k] = n;
  }
  if (v.latencyMiss === true) turn.latencyMiss = true;
  return turn;
}

/** Groups turns (oldest first) into conversations by the quiet between them. */
export function groupConversations(turns: readonly HistoryTurn[]): HistoryConversation[] {
  const out: HistoryConversation[] = [];
  let current: HistoryConversation | undefined;
  let lastEnd = 0;
  for (const turn of turns) {
    const end = Date.parse(turn.at);
    const start = end - turn.totalMs;
    if (!current || start - lastEnd > CONVERSATION_GAP_MS) {
      current = { id: turn.at, start: new Date(start).toISOString(), end: turn.at, turns: [] };
      out.push(current);
    }
    current.turns.push(turn);
    current.end = turn.at;
    lastEnd = end;
  }
  return out;
}

export class HistoryLog {
  readonly #dir: string;
  readonly #keepDays: number;

  constructor(dataDir: string, keepDays: number) {
    this.#dir = path.join(dataDir, 'history');
    this.#keepDays = keepDays;
  }

  /** Appends a finished request. Never throws: history is not worth a crash. */
  record(turn: HistorySource, now: Date = new Date()): void {
    try {
      mkdirSync(this.#dir, { recursive: true });
      const file = path.join(this.#dir, `${localDate(now)}.jsonl`);
      appendFileSync(file, `${JSON.stringify(toHistoryTurn(turn, now))}\n`);
    } catch {
      // ignore
    }
  }

  /** Deletes whole days older than the retention period. */
  prune(now: Date = new Date()): void {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - this.#keepDays);
    const oldest = localDate(cutoff);
    let files: string[] = [];
    try {
      files = readdirSync(this.#dir);
    } catch {
      return;
    }
    for (const name of files) {
      const m = DATE_FILE.exec(name);
      if (m?.[1] && m[1] < oldest) rmSync(path.join(this.#dir, name), { force: true });
    }
  }
}

function readDayFile(file: string): HistoryTurn[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const turns: HistoryTurn[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const turn = parseHistoryTurn(JSON.parse(line));
      if (turn) turns.push(turn);
    } catch {
      // a half-written line
    }
  }
  return turns;
}

/**
 * The most recent conversations, newest first. `limit` null = everything kept.
 * Reads day files from newest to oldest and stops once it has enough.
 */
export function readHistory(dataDir: string, limit: number | null): HistoryConversation[] {
  const dir = path.join(dataDir, 'history');
  let days: string[] = [];
  try {
    days = readdirSync(dir)
      .filter((n) => DATE_FILE.test(n))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  let turns: HistoryTurn[] = [];
  for (const day of days) {
    turns = [...readDayFile(path.join(dir, day)), ...turns];
    // One extra conversation, since the oldest one read may continue into the day before.
    if (limit !== null && groupConversations(turns).length > limit) break;
  }
  turns.sort((a, b) => a.at.localeCompare(b.at));
  const all = groupConversations(turns).reverse();
  return limit === null ? all : all.slice(0, limit);
}

/**
 * JSONL for export: one conversation per line, as chat messages (ready for
 * fine-tuning or evaluation sets) plus every turn's details for finding errors.
 */
export function historyToJsonl(conversations: readonly HistoryConversation[]): string {
  return conversations
    .slice()
    .reverse()
    .map((c) => {
      const messages: { role: 'user' | 'assistant'; content: string }[] = [];
      for (const t of c.turns) {
        if (t.text) messages.push({ role: 'user', content: t.text });
        if (t.reply) messages.push({ role: 'assistant', content: t.reply });
      }
      return JSON.stringify({ id: c.id, start: c.start, end: c.end, messages, turns: c.turns });
    })
    .join('\n')
    .concat(conversations.length ? '\n' : '');
}
