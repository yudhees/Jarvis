/**
 * Tier 4: always denied, no approval offered (CLAUDE.md 10.1). Checked in code
 * on the tool name and on every text value in its input, so a model cannot talk
 * its way around them.
 */

/** Tools by name that are never allowed. */
const BLOCKED_TOOL =
  /(format|diskpart|registry|regedit|firewall|defender|antivirus|create_?user|add_?user|password|install|uninstall|purchase|payment|pay_|transfer|billing|checkout|force_?push|run_?script|execute_?script)/i;

/** Places nothing may read, write or send (password stores, keys, cookies, credentials). */
const SECRET_PATH = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])\.env(\.[\w-]+)?$/i,
  /(^|[\\/])\.aws[\\/](credentials|config)$/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])gcloud([\\/]|$)/i,
  /(^|[\\/])\.claude[\\/]\.credentials/i,
  /\.(kdbx|kdb|pem|pfx|p12|key)$/i,
  /(^|[\\/])(cookies|login data|web data)(-journal)?$/i,
  /(^|[\\/])credentials?(\.json|\.xml)?$/i,
];

/** Jarvis's own safety files: no tool may change them. */
const JARVIS_GUARDS = [
  /(^|[\\/])config[\\/]permissions\.yaml$/i,
  /(^|[\\/])packages[\\/]core[\\/]src[\\/]guard([\\/]|$)/i,
  /(^|[\\/])jarvis[\\/]audit([\\/]|$)/i,
];

/** Pushing to main or master, or to production, in any tool input. */
const PRODUCTION_WRITE =
  /\b(push(ing)?\s+(--force|-f)\b|force[- ]push|push\b.*\b(main|master)\b|\bprod(uction)?\s+(db|database|account))/i;

/** A branch or environment no tool may write to. */
const PROTECTED_TARGET = /^(main|master|prod|production)$/i;

/** Input keys that name a file or place (where the path checks apply). */
const PATH_KEY = /(path|file|dir|folder|target|destination|source|attachment|location)/i;
/** Tools that can push or write to a server, where the production check applies. */
const WRITES_SOMEWHERE = /(git|push|deploy|release|database|db_|sql|mongo|aws|kubectl|terraform)/i;

/** Text values in the input, each with the key it sits under. */
function entries(
  value: unknown,
  key = '',
  out: [string, string][] = [],
  depth = 0,
): [string, string][] {
  if (depth > 6) return out;
  if (typeof value === 'string') out.push([key, value.trim()]);
  else if (Array.isArray(value)) for (const v of value) entries(v, key, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) entries(v, k, out, depth + 1);
  }
  return out;
}

/**
 * Why this call is forbidden, or null when it is not a hard block. Paths are
 * checked in path-like fields only, so a comment that merely mentions ".env"
 * is not blocked; pushes and production writes on tools that can do them.
 */
export function hardBlock(tool: string, input: unknown): string | null {
  if (BLOCKED_TOOL.test(tool)) return `${tool} is never allowed`;
  const pathTool = /file|folder|dir|path/i.test(tool);
  for (const [key, value] of entries(input)) {
    if (pathTool || PATH_KEY.test(key)) {
      if (SECRET_PATH.some((re) => re.test(value))) {
        return 'it touches a password, key, or credential file';
      }
      if (JARVIS_GUARDS.some((re) => re.test(value))) {
        return "it touches Jarvis's own safety settings or audit log";
      }
    }
    if (WRITES_SOMEWHERE.test(tool) && PRODUCTION_WRITE.test(value)) {
      return 'it would write to production or a main branch';
    }
  }
  const target = (input ?? {}) as Record<string, unknown>;
  if (
    WRITES_SOMEWHERE.test(tool) &&
    PROTECTED_TARGET.test(String(target.branch ?? target.environment ?? ''))
  ) {
    return 'it would write to production or a main branch';
  }
  return null;
}
