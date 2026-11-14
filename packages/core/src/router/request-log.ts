import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ModelTier, Speed } from '@jarvis/shared';
import type { RequestKind } from './kinds.ts';
import type { DecidedBy } from './route.ts';

/**
 * One request, for tuning the routing later (CLAUDE.md 7 rule 7, 7.1 rule 6).
 * Holds no words the user said: only the kind of request and its length.
 */
export interface RequestRecord {
  at: string;
  kind: RequestKind;
  words: number;
  tier: ModelTier;
  speed: Speed;
  model: string;
  decidedBy: DecidedBy;
  /** The classifier was asked: what it said (null = too slow or invalid), and how long it took. */
  classifier?: { tier: ModelTier | null; raised: boolean; ms: number };
  escalations: number;
  sttMs: number;
  firstWordMs: number | null;
  totalMs: number;
  latencyBudgetMs: number;
  latencyMiss: boolean;
  inputTokens: number;
  outputTokens: number;
  lookups: number;
  stopped: boolean;
}

const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Append-only JSONL, one file per day, files older than `keepDays` deleted. */
export class RequestLog {
  readonly dir: string;
  readonly #keepDays: number;
  readonly #now: () => Date;

  constructor(dir: string, keepDays: number, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.#keepDays = keepDays;
    this.#now = now;
    this.prune();
  }

  write(record: RequestRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.#fileFor(this.#now()), `${JSON.stringify(record)}\n`);
    } catch {
      // A full disk must never break a spoken answer.
    }
  }

  /** Deletes whole days older than the retention. Returns how many files went. */
  prune(): number {
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    const cutoff = this.#now().getTime() - this.#keepDays * 86_400_000;
    for (const name of names) {
      const m = FILE.exec(name);
      if (!m?.[1]) continue;
      const day = new Date(`${m[1]}T23:59:59`).getTime();
      if (day < cutoff) {
        rmSync(path.join(this.dir, name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  #fileFor(d: Date): string {
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.dir, `${day}.jsonl`);
  }
}
