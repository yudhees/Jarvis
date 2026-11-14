import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * MCP servers that Claude Code plugins on this PC declare, so Jarvis can offer
 * the same services (Jira, MongoDB, GitHub, Slack, ...). Only addresses and
 * commands are read. Claude Code's own credentials are never read: Jarvis signs
 * in to each service itself and keeps tokens in Windows Credential Manager.
 */
export type DiscoveredServer =
  | { name: string; plugin: string; type: 'http' | 'sse'; url: string }
  | { name: string; plugin: string; type: 'stdio'; command: string; args: string[] };

/** Known endpoint moves. Atlassian's /v1/mcp is deprecated in favour of /v2/mcp. */
const URL_UPGRADES: [RegExp, string][] = [
  [/^https:\/\/mcp\.atlassian\.com\/v1\/(mcp|sse)\/?$/, 'https://mcp.atlassian.com/v2/mcp'],
];

export function upgradeUrl(url: string): string {
  for (const [re, replacement] of URL_UPGRADES) if (re.test(url)) return replacement;
  return url;
}

export function defaultPluginRoots(home = os.homedir()): string[] {
  const plugins = path.join(home, '.claude', 'plugins');
  return [path.join(plugins, 'cache'), path.join(plugins, 'synced')];
}

/** Every folder with a .claude-plugin/plugin.json, up to a few levels deep. */
function findPluginDirs(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out;
  if (existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
    out.push(dir);
    return out;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    try {
      if (statSync(full).isDirectory()) findPluginDirs(full, depth + 1, out);
    } catch {
      // unreadable entry
    }
  }
  return out;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toServer(name: string, plugin: string, raw: unknown): DiscoveredServer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.url === 'string' && /^https:\/\//.test(r.url)) {
    const type = r.type === 'sse' ? 'sse' : 'http';
    return { name, plugin, type, url: upgradeUrl(r.url) };
  }
  if (typeof r.command === 'string') {
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === 'string')
      : [];
    // Env values are deliberately not copied: they may hold secrets.
    return { name, plugin, type: 'stdio', command: r.command, args };
  }
  return undefined;
}

/**
 * Finds MCP servers declared by installed plugins (in .mcp.json or inline in
 * plugin.json). The same server offered by several plugins is listed once.
 */
export function discoverMcpServers(roots: string[] = defaultPluginRoots()): DiscoveredServer[] {
  const byName = new Map<string, DiscoveredServer>();
  for (const root of roots) {
    for (const dir of findPluginDirs(root)) {
      const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json')) ?? {};
      const plugin = typeof manifest.name === 'string' ? manifest.name : path.basename(dir);
      const sources: unknown[] = [manifest.mcpServers];
      const mcpFile = readJson(path.join(dir, '.mcp.json'));
      if (mcpFile) sources.push(mcpFile.mcpServers ?? mcpFile);
      for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const [name, raw] of Object.entries(source as Record<string, unknown>)) {
          const key = name.toLowerCase().replace(/\s+/g, '-');
          const server = toServer(key, plugin, raw);
          if (server && !byName.has(key)) byName.set(key, server);
        }
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
