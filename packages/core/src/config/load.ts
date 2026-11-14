import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { type Config, jarvisSchema, mcpSchema, modelsSchema, permissionsSchema } from './schema.ts';

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Default config folder: <repo>/config, unless JARVIS_CONFIG_DIR is set. */
export function defaultConfigDir(): string {
  return (
    process.env.JARVIS_CONFIG_DIR ??
    path.resolve(import.meta.dirname, '..', '..', '..', '..', 'config')
  );
}

/** Replaces %NAME% with the environment variable, and fails if it is not set. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([A-Za-z0-9_]+)%/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) throw new Error(`environment variable %${name}% is not set`);
    return found;
  });
}

function loadFile<S extends z.ZodType>(
  dir: string,
  file: string,
  schema: S,
  problems: string[],
): z.infer<S> | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    problems.push(`${file}: ${(err as Error).message.split('\n')[0]}`);
    return undefined;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      problems.push(`${file}: ${where}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

/** Loads and validates every config file. Throws ConfigError listing all problems. */
export function loadConfig(dir: string = defaultConfigDir()): Config {
  const problems: string[] = [];
  const models = loadFile(dir, 'models.yaml', modelsSchema, problems);
  const permissions = loadFile(dir, 'permissions.yaml', permissionsSchema, problems);
  const mcp = loadFile(dir, 'mcp.yaml', mcpSchema, problems);
  const jarvis = loadFile(dir, 'jarvis.yaml', jarvisSchema, problems);

  if (jarvis) {
    try {
      jarvis.dataDir = path.normalize(expandWindowsVars(jarvis.dataDir));
    } catch (err) {
      problems.push(`jarvis.yaml: dataDir: ${(err as Error).message}`);
    }
  }

  if (problems.length > 0 || !models || !permissions || !mcp || !jarvis) {
    throw new ConfigError(problems);
  }
  return { models, permissions, mcp, jarvis };
}
