import { createHash, randomBytes } from 'node:crypto';
import type { MemoryFile, MemoryFiles } from './files.ts';
import { findSensitive } from './sensitive.ts';

export const MEMORY_KINDS = [
  'fact',
  'preference',
  'contact',
  'vocabulary',
  'routing',
  'habit',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Only the user's own words, or a yes to Jarvis's question. Never tool or web content. */
export type MemorySource = 'user_said' | 'user_confirmed';

export interface Memory {
  id: string;
  path: string;
  kind: MemoryKind;
  /** Human-readable sentence; this is what is searched and read aloud. */
  text: string;
  key: string | null;
  value: string | null;
  source: MemorySource;
  confidence: number;
  createdAt: number;
}

export interface SaveInput {
  kind: MemoryKind;
  text: string;
  /** Structured items (routing, vocabulary, name) are unique per kind + key; saving again replaces. */
  key?: string;
  value?: string;
  source: MemorySource;
  confidence?: number;
}

export interface SearchOptions {
  limit?: number;
  /** 'any' ranks by how many words match; 'all' requires every word. */
  mode?: 'any' | 'all';
}

export class SensitiveContentError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`refusing to store ${reason}`);
    this.name = 'SensitiveContentError';
    this.reason = reason;
  }
}

/** Paths under this prefix hold Jarvis's own state, not memories. */
export const SYSTEM_PREFIX = '/_jarvis/';

const STOPWORDS = new Set(
  'a an and are as at be by for from i in is it me my of on or that the this to was what with you your about everything all things thing'.split(
    ' ',
  ),
);

function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's', 'ly']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, -suffix.length);
      // "debugging" -> "debugg" -> "debug", "running" -> "run" (but keep "add", "all")
      const doubled = (suffix === 'ing' || suffix === 'ed') && /([b-df-hj-np-tv-z])\1$/.test(base);
      return doubled && base.length > 3 ? base.slice(0, -1) : base;
    }
  }
  return word;
}

/** Lowercased, stemmed content words. */
export function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w)).map(stem))];
}

function serialize(m: Omit<Memory, 'id' | 'path'>): string {
  const header = {
    kind: m.kind,
    key: m.key,
    value: m.value,
    source: m.source,
    confidence: m.confidence,
    created: new Date(m.createdAt).toISOString(),
  };
  const lines = Object.entries(header).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${m.text}\n`;
}

function parse(file: MemoryFile): Memory | undefined {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(file.content.replace(/\r\n/g, '\n'));
  if (!match) return undefined;
  const header: Record<string, unknown> = {};
  for (const line of (match[1] as string).split('\n')) {
    const kv = /^(\w+): (.*)$/.exec(line);
    if (!kv) continue;
    try {
      header[kv[1] as string] = JSON.parse(kv[2] as string);
    } catch {
      return undefined;
    }
  }
  const kind = header.kind as MemoryKind;
  if (!MEMORY_KINDS.includes(kind)) return undefined;
  return {
    id: file.id,
    path: file.path,
    kind,
    text: (match[2] as string).trim(),
    key: typeof header.key === 'string' ? header.key : null,
    value: typeof header.value === 'string' ? header.value : null,
    source: header.source === 'user_confirmed' ? 'user_confirmed' : 'user_said',
    confidence: typeof header.confidence === 'number' ? header.confidence : 1,
    createdAt: Date.parse(String(header.created)) || 0,
  };
}

function keySlug(key: string): string {
  const readable = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${readable || 'key'}-${hash}`;
}

/**
 * Long-term memory (CLAUDE.md 13). All items are loaded once into an in-process
 * cache, so reads and search are instant; writes go straight to the backend.
 */
export class MemoryStore {
  readonly files: MemoryFiles;
  private readonly items = new Map<string, Memory>();
  private readonly systemFiles = new Map<string, MemoryFile>();
  private readonly now: () => number;

  private constructor(files: MemoryFiles, now: () => number) {
    this.files = files;
    this.now = now;
  }

  static async open(files: MemoryFiles, now: () => number = Date.now): Promise<MemoryStore> {
    const store = new MemoryStore(files, now);
    for (const file of await files.listAll()) {
      if (file.path.startsWith(SYSTEM_PREFIX)) {
        store.systemFiles.set(file.path, file);
        continue;
      }
      const memory = parse(file);
      if (memory) store.items.set(memory.id, memory);
    }
    return store;
  }

  /** A Jarvis state file loaded with the store (see JsonDoc). */
  systemFile(path: string): MemoryFile | undefined {
    return this.systemFiles.get(path);
  }

  get size(): number {
    return this.items.size;
  }

  get(id: string): Memory | undefined {
    return this.items.get(id);
  }

  findByKey(kind: MemoryKind, key: string): Memory | undefined {
    for (const m of this.items.values()) if (m.kind === kind && m.key === key) return m;
    return undefined;
  }

  /** Highest confidence first, then newest. */
  list(kinds?: readonly MemoryKind[]): Memory[] {
    return [...this.items.values()]
      .filter((m) => !kinds || kinds.includes(m.kind))
      .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt);
  }

  search(query: string, options: SearchOptions = {}): Memory[] {
    const wanted = terms(query);
    if (wanted.length === 0) return [];
    const scored: { m: Memory; score: number }[] = [];
    for (const m of this.items.values()) {
      const have = new Set(terms(`${m.text} ${m.key ?? ''} ${m.value ?? ''}`));
      const hits = wanted.filter((t) => have.has(t)).length;
      if (hits === 0 || (options.mode === 'all' && hits < wanted.length)) continue;
      scored.push({ m, score: hits / wanted.length });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
      .slice(0, options.limit ?? 5)
      .map((s) => s.m);
  }

  /** Throws SensitiveContentError for passwords, keys, card numbers, or health data. */
  async save(input: SaveInput): Promise<Memory> {
    for (const part of [input.text, input.key ?? '', input.value ?? '']) {
      const reason = findSensitive(part);
      if (reason) throw new SensitiveContentError(reason);
    }
    const text = input.text.trim();
    if (text.length === 0) throw new Error('memory text is empty');
    const data = {
      kind: input.kind,
      text,
      key: input.key ?? null,
      value: input.value ?? null,
      source: input.source,
      confidence: input.confidence ?? (input.source === 'user_said' ? 1 : 0.9),
      createdAt: this.now(),
    };
    const existing = data.key === null ? undefined : this.findByKey(data.kind, data.key);
    const file = existing
      ? await this.files.update(existing.id, serialize(data))
      : await this.files.create(this.pathFor(data.kind, data.key), serialize(data));
    const memory: Memory = { ...data, id: file.id, path: file.path };
    this.items.set(memory.id, memory);
    return memory;
  }

  async forget(id: string): Promise<boolean> {
    if (!this.items.has(id)) return false;
    await this.files.delete(id);
    this.items.delete(id);
    return true;
  }

  /** Deletes memories containing every word of the query; returns what was removed. */
  async forgetMatching(query: string): Promise<Memory[]> {
    const matches = this.search(query, { mode: 'all', limit: Number.POSITIVE_INFINITY });
    for (const m of matches) await this.forget(m.id);
    return matches;
  }

  private pathFor(kind: MemoryKind, key: string | null): string {
    if (key !== null) return `/${kind}/${keySlug(key)}.md`;
    return `/${kind}/${this.now().toString(36)}-${randomBytes(3).toString('hex')}.md`;
  }
}

/** One JSON document of Jarvis state stored next to the memories (e.g. learning signals). */
export class JsonDoc<T> {
  private readonly store: MemoryStore;
  private readonly path: string;
  private id: string | undefined;
  value: T;

  constructor(store: MemoryStore, path: string, fallback: T) {
    if (!path.startsWith(SYSTEM_PREFIX))
      throw new Error(`state path must start with ${SYSTEM_PREFIX}`);
    this.store = store;
    this.path = path;
    const file = store.systemFile(path);
    this.id = file?.id;
    let loaded = fallback;
    if (file) {
      try {
        loaded = JSON.parse(file.content) as T;
      } catch {
        // corrupt state: start over rather than fail
      }
    }
    this.value = loaded;
  }

  async save(): Promise<void> {
    const content = JSON.stringify(this.value);
    if (this.id) {
      await this.store.files.update(this.id, content);
    } else {
      this.id = (await this.store.files.create(this.path, content)).id;
    }
  }
}
