import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Daily usage totals for the Settings window's Usage tab: requests, tokens,
 * model tiers and response times. Numbers only; never what was said. One small
 * JSON file per day under dataDir/usage, deleted after the retention period
 * (CLAUDE.md 10.7).
 */

export const TIERS = ['simple', 'standard', 'complex'] as const;
type Tier = (typeof TIERS)[number];

export interface TierUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DayUsage {
  date: string; // YYYY-MM-DD, local time
  /** Requests answered by a model. */
  requests: number;
  /** Spoken commands handled in code (stop, mute, ...), no model call. */
  commands: number;
  stopped: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  escalations: number;
  byTier: Record<Tier, TierUsage>;
  /** Sum and count, for the average time to Jarvis's first spoken word. */
  firstWordMsTotal: number;
  firstWordCount: number;
}

/** What one finished request adds (a subset of the voice loop's TurnLog). */
export interface UsageTurn {
  firstAudioMs: number | null;
  command?: string;
  stopped: boolean;
  result?: {
    tier: Tier | null;
    escalations: number;
    usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  };
}

export function emptyDay(date: string): DayUsage {
  const tier = (): TierUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0 });
  return {
    date,
    requests: 0,
    commands: 0,
    stopped: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    escalations: 0,
    byTier: { simple: tier(), standard: tier(), complex: tier() },
    firstWordMsTotal: 0,
    firstWordCount: 0,
  };
}

export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Reads a stored day defensively: anything missing or odd counts as zero. */
export function parseDay(date: string, raw: unknown): DayUsage {
  const day = emptyDay(date);
  if (!raw || typeof raw !== 'object') return day;
  const r = raw as Record<string, unknown>;
  for (const key of [
    'requests',
    'commands',
    'stopped',
    'inputTokens',
    'outputTokens',
    'toolCalls',
    'escalations',
    'firstWordMsTotal',
    'firstWordCount',
  ] as const) {
    day[key] = count(r[key]);
  }
  const byTier = (r.byTier ?? {}) as Record<string, Record<string, unknown> | undefined>;
  for (const tier of TIERS) {
    const t = byTier[tier] ?? {};
    day.byTier[tier] = {
      requests: count(t.requests),
      inputTokens: count(t.inputTokens),
      outputTokens: count(t.outputTokens),
    };
  }
  return day;
}

/** Adds one request to a day's totals (pure, for tests). */
export function addTurn(day: DayUsage, turn: UsageTurn): DayUsage {
  const next = parseDay(day.date, day);
  if (turn.stopped) next.stopped++;
  if (turn.command && !turn.result?.tier) {
    next.commands++;
    return next;
  }
  const r = turn.result;
  if (!r?.tier) return next;
  next.requests++;
  next.inputTokens += count(r.usage.inputTokens);
  next.outputTokens += count(r.usage.outputTokens);
  next.toolCalls += count(r.usage.toolCalls);
  next.escalations += count(r.escalations);
  const t = next.byTier[r.tier];
  t.requests++;
  t.inputTokens += count(r.usage.inputTokens);
  t.outputTokens += count(r.usage.outputTokens);
  if (turn.firstAudioMs !== null && turn.firstAudioMs >= 0) {
    next.firstWordMsTotal += turn.firstAudioMs;
    next.firstWordCount++;
  }
  return next;
}

export class UsageLog {
  readonly #dir: string;
  readonly #keepDays: number;

  constructor(dataDir: string, keepDays: number) {
    this.#dir = path.join(dataDir, 'usage');
    this.#keepDays = keepDays;
  }

  /** Adds a finished request to today's file. Never throws: usage is not worth a crash. */
  record(turn: UsageTurn, now: Date = new Date()): void {
    try {
      mkdirSync(this.#dir, { recursive: true });
      const date = localDate(now);
      const file = path.join(this.#dir, `${date}.json`);
      let day = emptyDay(date);
      try {
        day = parseDay(date, JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        // first request today
      }
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(addTurn(day, turn)));
      renameSync(temp, file);
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

/** The last `days` days, oldest first, with empty days filled in. */
export function readUsage(dataDir: string, days: number, now: Date = new Date()): DayUsage[] {
  const dir = path.join(dataDir, 'usage');
  const out: DayUsage[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const date = localDate(d);
    try {
      out.push(parseDay(date, JSON.parse(readFileSync(path.join(dir, `${date}.json`), 'utf8'))));
    } catch {
      out.push(emptyDay(date));
    }
  }
  return out;
}
