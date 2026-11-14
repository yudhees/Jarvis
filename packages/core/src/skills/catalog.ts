import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { terms } from '../memory/store.ts';

/**
 * The skills already installed for Claude Code on this PC, reused by Jarvis.
 * A skill is a folder with a SKILL.md (frontmatter `name` + `description`, then
 * instructions). Only the name and description are kept in memory; the body is
 * read when a request actually needs that skill.
 */
export interface Skill {
  /** `plugin:name` for plugin skills, `name` otherwise. */
  id: string;
  name: string;
  description: string;
  plugin: string | null;
  /** 'custom' = any .md in a folder the user listed, or Claude Code commands/agents. */
  source: 'user' | 'plugin' | 'project' | 'custom';
  file: string;
}

export interface SkillRoot {
  dir: string;
  source: Skill['source'];
}

/**
 * Claude Code's skill locations (user skills, installed plugins, org-synced plugins,
 * project), its custom commands and agents, plus any folders listed in
 * jarvis.yaml `skills.extraDirs` (the user's own .md instruction files).
 */
export function defaultSkillRoots(
  home = os.homedir(),
  projectDir?: string,
  extraDirs: readonly string[] = [],
): SkillRoot[] {
  const claude = path.join(home, '.claude');
  const roots: SkillRoot[] = [
    { dir: path.join(claude, 'skills'), source: 'user' },
    { dir: path.join(claude, 'plugins', 'cache'), source: 'plugin' },
    { dir: path.join(claude, 'plugins', 'synced'), source: 'plugin' },
    { dir: path.join(claude, 'commands'), source: 'custom' },
    { dir: path.join(claude, 'agents'), source: 'custom' },
  ];
  if (projectDir) {
    const p = path.join(projectDir, '.claude');
    roots.push({ dir: path.join(p, 'skills'), source: 'project' });
    roots.push({ dir: path.join(p, 'commands'), source: 'custom' });
    roots.push({ dir: path.join(p, 'agents'), source: 'custom' });
  }
  for (const dir of extraDirs) roots.push({ dir, source: 'custom' });
  return roots;
}

/** Every .md file under a custom folder (skipping hidden folders and dependencies). */
function findMarkdownFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) findMarkdownFiles(full, depth + 1, out);
      else if (/\.md$/i.test(name) && !/^readme\.md$/i.test(name)) out.push(full);
    } catch {
      // unreadable entry
    }
  }
  return out;
}

/** First real paragraph of a Markdown body, for files without a description. */
function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block
      .split('\n')
      .filter((l) => !/^\s*(#|```|---|<!--)/.test(l))
      .join(' ')
      .replace(/[*_`>]/g, '')
      .trim();
    if (text.length >= 15) return text.slice(0, 300);
  }
  return '';
}

/** Folders that hold copies for other tools, deleted skills, or dependencies. */
const SKIP_DIRS = new Set(['node_modules', 'distributions', 'com.github.copilot', 'test', 'tests']);
const MAX_DEPTH = 7;

function findSkillFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  if (entries.includes('SKILL.md')) {
    out.push(path.join(dir, 'SKILL.md'));
    return out; // a skill folder does not contain other skills
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    try {
      if (statSync(full).isDirectory()) findSkillFiles(full, depth + 1, out);
    } catch {
      // unreadable entry
    }
  }
  return out;
}

/** Reads `key: value` frontmatter, including quoted and folded (`>` / `|`) values. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) return { meta: {}, body: normalized };
  const meta: Record<string, string> = {};
  const lines = (m[1] as string).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] as string);
    if (!kv) continue;
    let value = (kv[2] as string).trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] as string)) {
        parts.push((lines[++i] as string).trim());
      }
      value = parts.join(value.startsWith('|') ? '\n' : ' ');
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    meta[kv[1] as string] = value;
  }
  return { meta, body: m[2] as string };
}

/** The plugin a skill belongs to: nearest .claude-plugin/plugin.json above it. */
function pluginNameFor(file: string, root: string): string | null {
  let dir = path.dirname(path.dirname(file));
  while (dir.length >= root.length) {
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
        return typeof name === 'string' ? name : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Finds every installed skill. Duplicates (same id) keep the first one found. */
export function discoverSkills(
  roots: SkillRoot[] = defaultSkillRoots(),
  exclude: readonly string[] = [],
): Skill[] {
  const skip = new Set(exclude);
  const byId = new Map<string, Skill>();
  for (const root of roots) {
    const found = root.source === 'custom' ? findMarkdownFiles(root.dir) : findSkillFiles(root.dir);
    for (const file of found) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      const isSkillFile = path.basename(file) === 'SKILL.md';
      const name =
        meta.name ??
        (isSkillFile ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file)));
      const description = meta.description || firstParagraph(body);
      if (!description) continue; // without a description it cannot be chosen sensibly
      const plugin = root.source === 'plugin' ? pluginNameFor(file, root.dir) : null;
      const id = plugin ? `${plugin}:${name}` : name;
      if (skip.has(id) || skip.has(name)) continue;
      if (!byId.has(id)) {
        byId.set(id, { id, name, description, plugin, source: root.source, file });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface SkillMatch {
  skill: Skill;
  score: number;
}

/**
 * Picks the few skills that fit this request, so the prompt only carries what is
 * relevant. Scores word overlap with the skill's name (weighted) and description,
 * scaled by how much of the request it explains. Returns [] when nothing fits.
 */
export function selectSkills(
  skills: readonly Skill[],
  request: string,
  options: { limit?: number; minScore?: number } = {},
): SkillMatch[] {
  const wanted = terms(request);
  if (wanted.length === 0) return [];
  const matches: SkillMatch[] = [];
  for (const skill of skills) {
    const nameTerms = new Set(terms(skill.name.replace(/[-_]/g, ' ')));
    const descTerms = new Set(terms(skill.description));
    let score = 0;
    let nameHits = 0;
    let descHits = 0;
    for (const t of wanted) {
      if (nameTerms.has(t)) {
        score += 2;
        nameHits++;
      } else if (descTerms.has(t)) {
        score += 1;
        descHits++;
      }
    }
    // One shared word ("time", "update") is not evidence; ask for the name or two words.
    if (nameHits === 0 && descHits < 2) continue;
    matches.push({ skill, score: score / wanted.length });
  }
  return matches
    .filter((m) => m.score >= (options.minScore ?? 0.5))
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, options.limit ?? 2);
}

/** A skill's instructions, without frontmatter, capped so one skill cannot flood the prompt. */
export function loadSkillBody(skill: Skill, maxChars = 12000): string {
  const { body } = parseFrontmatter(readFileSync(skill.file, 'utf8'));
  const trimmed = body.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n[truncated]` : trimmed;
}
