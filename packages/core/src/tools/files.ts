import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from '../guard/index.ts';
import { type JarvisTool, requireString, ToolInputError } from './types.ts';

const MAX_READ = 20_000;
const MAX_WRITE = 100_000;
const MAX_LIST = 50;

/**
 * File tools limited to the folders in jarvis.yaml `files.allowedFolders`
 * (CLAUDE.md 10.2). Paths are resolved to their real location first, so ".."
 * and links cannot leave the folder. Reading is tier 0, writing tier 2,
 * deleting (one file, never a folder) tier 3.
 */
export function fileTools(allowedFolders: readonly string[]): JarvisTool[] {
  const root = allowedFolders[0];
  const inside = (input: Record<string, unknown>, key = 'path', fallback?: string): string => {
    const raw = typeof input[key] === 'string' && input[key] ? (input[key] as string) : fallback;
    if (raw === undefined) requireString(input, key);
    const full = resolveInside(raw ?? '', allowedFolders);
    if (!full) {
      throw new ToolInputError(
        `That is outside the folders Jarvis may use (${allowedFolders.join(', ')}).`,
      );
    }
    return full;
  };
  const shown = (full: string) => {
    for (const r of allowedFolders) {
      const rel = path.relative(r, full);
      if (!rel.startsWith('..')) return rel || '.';
    }
    return path.basename(full);
  };

  return [
    {
      name: 'file_list',
      description: `List files in Jarvis's folder (${root}). path is optional, relative to it.`,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
      run: async (input) => {
        const dir = inside(input, 'path', '.');
        await mkdir(dir, { recursive: true });
        const names = await readdir(dir, { withFileTypes: true });
        if (names.length === 0) return 'The folder is empty.';
        return names
          .slice(0, MAX_LIST)
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
          .join('\n');
      },
    },
    {
      name: 'file_read',
      description: "Read a text file from Jarvis's folder.",
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      untrusted: true,
      run: async (input) => {
        const file = inside(input);
        const text = await readFile(file, 'utf8');
        return text.length > MAX_READ
          ? `${text.slice(0, MAX_READ)}\n[cut at ${MAX_READ} characters]`
          : text;
      },
    },
    {
      name: 'file_write',
      description:
        "Write (create or replace) a text file in Jarvis's folder. Needs the user's spoken approval.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      run: async (input) => {
        const file = inside(input);
        const content = requireString(input, 'content', MAX_WRITE);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content, 'utf8');
        return `Saved ${shown(file)}.`;
      },
    },
    {
      name: 'file_delete',
      description:
        "Delete one file (not a folder) from Jarvis's folder. Needs approval with a confirmation code.",
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async (input) => {
        const file = inside(input);
        if (allowedFolders.some((r) => path.resolve(r) === file)) {
          throw new ToolInputError('The folder itself cannot be deleted.');
        }
        const s = await stat(file);
        if (s.isDirectory())
          throw new ToolInputError('Only single files can be deleted, not folders.');
        await rm(file);
        return `Deleted ${shown(file)}.`;
      },
    },
  ];
}
