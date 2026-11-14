import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MemoryFile, MemoryFiles } from './files.ts';

interface Saved {
  version: 1;
  nextId: number;
  files: MemoryFile[];
}

/**
 * Memory kept in one small JSON file on this PC (`%APPDATA%/jarvis/memory.json`),
 * for when there is no API key for the Claude Memory Store (subscription via
 * the Claude CLI). Writes go to a temp file first, so a crash never leaves it
 * half written. Secrets are rejected before they get here (memory/sensitive.ts).
 */
export class LocalMemoryFiles implements MemoryFiles {
  readonly file: string;
  readonly #files = new Map<string, MemoryFile>();
  #nextId = 1;

  constructor(file: string) {
    this.file = file;
    let saved: Saved | undefined;
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read memory file ${file}: ${(err as Error).message}`);
      }
    }
    if (saved) {
      for (const f of saved.files) this.#files.set(f.id, { ...f });
      this.#nextId = saved.nextId;
    }
  }

  async listAll(): Promise<MemoryFile[]> {
    return [...this.#files.values()].map((f) => ({ ...f }));
  }

  async create(filePath: string, content: string): Promise<MemoryFile> {
    for (const f of this.#files.values()) {
      if (f.path === filePath) throw new Error(`memory path already exists: ${filePath}`);
    }
    const file = { id: `mem_${this.#nextId++}`, path: filePath, content };
    this.#files.set(file.id, file);
    this.#save();
    return { ...file };
  }

  async update(id: string, content: string): Promise<MemoryFile> {
    const file = this.#files.get(id);
    if (!file) throw new Error(`no memory with id ${id}`);
    file.content = content;
    this.#save();
    return { ...file };
  }

  async delete(id: string): Promise<void> {
    if (this.#files.delete(id)) this.#save();
  }

  #save(): void {
    const data: Saved = { version: 1, nextId: this.#nextId, files: [...this.#files.values()] };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1));
    renameSync(tmp, this.file);
  }
}
