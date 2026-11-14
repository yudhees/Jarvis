import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * File tools work only inside the folders in jarvis.yaml (CLAUDE.md 10.2).
 * The real path is resolved first (the longest part that exists), so ".." and
 * links cannot point outside. Returns the absolute path, or null if outside.
 */
export function resolveInside(requested: string, allowed: readonly string[]): string | null {
  if (!requested || requested.includes('\0')) return null;
  const roots = allowed.map(realOrResolved);
  for (const root of roots) {
    const full = realOrResolved(path.resolve(root, requested));
    if (isWithin(full, root)) return full;
  }
  return null;
}

function isWithin(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Real path of the longest existing ancestor, plus the rest as written. */
function realOrResolved(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}
