/**
 * Where memory lives: a flat set of small text files addressed by path.
 * The real backend is a Claude Memory Store (claude-files.ts); InMemoryFiles is for
 * tests and for running without network.
 */

export interface MemoryFile {
  id: string;
  path: string;
  content: string;
}

export interface MemoryFiles {
  listAll(): Promise<MemoryFile[]>;
  create(path: string, content: string): Promise<MemoryFile>;
  update(id: string, content: string): Promise<MemoryFile>;
  delete(id: string): Promise<void>;
}

export class InMemoryFiles implements MemoryFiles {
  private readonly files = new Map<string, MemoryFile>();
  private nextId = 1;

  async listAll(): Promise<MemoryFile[]> {
    return [...this.files.values()].map((f) => ({ ...f }));
  }

  async create(path: string, content: string): Promise<MemoryFile> {
    for (const f of this.files.values()) {
      if (f.path === path) throw new Error(`memory path already exists: ${path}`);
    }
    const file = { id: `mem_${this.nextId++}`, path, content };
    this.files.set(file.id, file);
    return { ...file };
  }

  async update(id: string, content: string): Promise<MemoryFile> {
    const file = this.files.get(id);
    if (!file) throw new Error(`no memory with id ${id}`);
    file.content = content;
    return { ...file };
  }

  async delete(id: string): Promise<void> {
    this.files.delete(id);
  }
}
