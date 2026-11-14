/**
 * Recipient counting (CLAUDE.md 9): a message to more than 5 people is tier 3.
 * Direct addresses are counted; a channel's member count is looked up with a
 * read-only call. If the count cannot be found, it counts as more than 5.
 */
export const MANY_RECIPIENTS = 5;

/** Tools that send something to people, and where their recipients are. */
const SENDERS: Record<string, { direct?: string[]; channel?: string }> = {
  slack_send_message: { channel: 'channel_id' },
  slack_reply: { channel: 'channel_id' },
  email_send: { direct: ['to', 'cc', 'bcc'] },
  email_reply: { direct: ['to', 'cc', 'bcc'] },
};

export function isSender(tool: string): boolean {
  return tool in SENDERS;
}

function addresses(value: unknown): number {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim()).length;
  if (typeof value === 'string') return value.split(/[,;]/).filter((v) => v.trim()).length;
  return 0;
}

/**
 * How many people the call reaches. `members` looks up a channel's size
 * (read-only); null or a failure means unknown, which counts as many.
 */
export async function countRecipients(
  tool: string,
  input: Record<string, unknown>,
  members: (channel: string) => Promise<number | null>,
): Promise<number> {
  const spec = SENDERS[tool];
  if (!spec) return 0;
  let count = 0;
  for (const key of spec.direct ?? []) count += addresses(input[key]);
  if (spec.channel) {
    const channel = input[spec.channel];
    if (typeof channel !== 'string' || !channel) return Number.POSITIVE_INFINITY;
    try {
      const n = await members(channel);
      if (n === null || !Number.isFinite(n)) return Number.POSITIVE_INFINITY;
      count += n;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return count;
}
