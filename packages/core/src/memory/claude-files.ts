import Anthropic from '@anthropic-ai/sdk';
import type { MemoryFile, MemoryFiles } from './files.ts';

export const DEFAULT_STORE_NAME = 'Jarvis user memory';
const STORE_DESCRIPTION =
  "Jarvis's long-term memory about its one user: facts and preferences the user stated, " +
  'confirmed routing preferences, vocabulary fixes, and learning state. Written only by Jarvis ' +
  "core from the user's own speech, never from tool or web content.";

/**
 * Memory kept in a Claude Memory Store (Anthropic-hosted, beta), so nothing is
 * stored on this PC. Every change creates a version in the store's history.
 * Credentials come from the SDK's normal lookup (ANTHROPIC_API_KEY, or an
 * `ant auth login` profile).
 */
export class ClaudeMemoryFiles implements MemoryFiles {
  readonly storeId: string;
  private readonly client: Anthropic;

  private constructor(client: Anthropic, storeId: string) {
    this.client = client;
    this.storeId = storeId;
  }

  /** Finds the store by name, or creates it the first time. */
  static async open(
    client: Anthropic = new Anthropic(),
    name: string = DEFAULT_STORE_NAME,
  ): Promise<ClaudeMemoryFiles> {
    for await (const store of client.beta.memoryStores.list()) {
      if (store.name === name && store.archived_at === null) {
        return new ClaudeMemoryFiles(client, store.id);
      }
    }
    const store = await client.beta.memoryStores.create({ name, description: STORE_DESCRIPTION });
    return new ClaudeMemoryFiles(client, store.id);
  }

  async listAll(): Promise<MemoryFile[]> {
    const found = new Map<string, MemoryFile>();
    const walk = async (prefix: string): Promise<void> => {
      const items = this.client.beta.memoryStores.memories.list(this.storeId, {
        path_prefix: prefix,
        view: 'full',
      });
      for await (const item of items) {
        if (item.type === 'memory') {
          found.set(item.id, { id: item.id, path: item.path, content: item.content ?? '' });
        } else if (item.path !== prefix) {
          await walk(item.path.endsWith('/') ? item.path : `${item.path}/`);
        }
      }
    };
    await walk('/');
    return [...found.values()];
  }

  async create(path: string, content: string): Promise<MemoryFile> {
    const m = await this.client.beta.memoryStores.memories.create(this.storeId, { path, content });
    return { id: m.id, path: m.path, content };
  }

  async update(id: string, content: string): Promise<MemoryFile> {
    const m = await this.client.beta.memoryStores.memories.update(id, {
      memory_store_id: this.storeId,
      content,
    });
    return { id: m.id, path: m.path, content };
  }

  async delete(id: string): Promise<void> {
    await this.client.beta.memoryStores.memories.delete(id, { memory_store_id: this.storeId });
  }
}
