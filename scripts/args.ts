import { parseArgs } from 'node:util';

/** Shared flags for the test scripts. */
export function scriptArgs(extra: Record<string, { type: 'string' | 'boolean' }> = {}) {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      device: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      ...extra,
    },
    allowPositionals: false,
  });
  return values as Record<string, string | boolean | undefined>;
}

export function intArg(
  value: string | boolean | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    console.error(`--${name} must be a whole number`);
    process.exit(2);
  }
  return n;
}
