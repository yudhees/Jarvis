/** A tool Jarvis runs itself, after the permission gate (CLAUDE.md 9). */
export interface JarvisTool {
  name: string;
  /** Shown to the model: what it does and when to use it. */
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  /**
   * Its result comes from outside (a ticket, a file): wrapped as data, and
   * everything after it in the task needs approval from tier 1 up (10.3).
   */
  untrusted?: boolean;
  run(input: Record<string, unknown>): Promise<string>;
}

/** A clear message for the model when an input is missing or malformed. */
export class ToolInputError extends Error {}

export function requireString(input: Record<string, unknown>, key: string, max = 2000): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolInputError(`"${key}" is required.`);
  if (v.length > max) throw new ToolInputError(`"${key}" is too long (over ${max} characters).`);
  return v.trim();
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
  max = 2000,
): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be text.`);
  if (v.length > max) throw new ToolInputError(`"${key}" is too long (over ${max} characters).`);
  return v.trim();
}
