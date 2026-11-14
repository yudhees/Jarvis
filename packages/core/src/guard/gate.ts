import type { RiskTier } from '@jarvis/shared';
import { hardBlock } from './hard-blocks.ts';
import { countRecipients, isSender, MANY_RECIPIENTS } from './recipients.ts';
import { type ApprovalText, approvalText } from './sentences.ts';

/** One tool call the model asked for. */
export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export type GateDecision =
  | { kind: 'run'; tier: RiskTier }
  | ({ kind: 'ask'; tier: 2 | 3; reasons: string[] } & ApprovalText)
  | { kind: 'deny'; tier: RiskTier; reason: string };

/** What the gate remembers within one task (one user request). */
export class TaskState {
  /** A tool result from outside (ticket, message, page, file) was read. */
  readUntrusted = false;
  /** Tier 2 tools the user said "approve all" for, this task only. */
  readonly approvedAll = new Set<string>();
  #lastCall = '';
  #repeats = 0;

  /** Counts identical calls in a row (CLAUDE.md 10.5: no more than 3). */
  noteCall(call: ToolCall): number {
    const key = `${call.tool}\u0000${stableJson(call.input)}`;
    this.#repeats = key === this.#lastCall ? this.#repeats + 1 : 1;
    this.#lastCall = key;
    return this.#repeats;
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface GateOptions {
  /** Tier from permissions.yaml; unlisted tools are tier 2 (fixed here, not configurable). */
  tiers: Readonly<Record<string, RiskTier>>;
  /** Read-only member count of a channel, for recipient counting. */
  channelMembers?: (channel: string) => Promise<number | null>;
  maxIdenticalCalls: number;
}

export const UNLISTED_TIER: RiskTier = 2;

/**
 * The permission gate (CLAUDE.md 9, 10). Plain code, never a model decision.
 * Anything that fails or throws here denies the call.
 */
export class Gate {
  readonly #o: GateOptions;

  constructor(options: GateOptions) {
    this.#o = options;
  }

  tierOf(tool: string): RiskTier {
    return Object.hasOwn(this.#o.tiers, tool) ? (this.#o.tiers[tool] as RiskTier) : UNLISTED_TIER;
  }

  async decide(call: ToolCall, task: TaskState): Promise<GateDecision> {
    try {
      return await this.#decide(call, task);
    } catch (err) {
      return {
        kind: 'deny',
        tier: 4,
        reason: `the safety check failed (${(err as Error).message})`,
      };
    }
  }

  async #decide(call: ToolCall, task: TaskState): Promise<GateDecision> {
    const blocked = hardBlock(call.tool, call.input);
    if (blocked) return { kind: 'deny', tier: 4, reason: blocked };
    let tier = this.tierOf(call.tool);
    if (tier === 4) return { kind: 'deny', tier, reason: `${call.tool} is forbidden` };

    if (task.noteCall(call) > this.#o.maxIdenticalCalls) {
      return { kind: 'deny', tier, reason: 'the same call was repeated too many times' };
    }

    const reasons: string[] = [];
    // 10.3: after reading outside content, nothing runs unasked for the rest of the task.
    if (task.readUntrusted && tier === 1) {
      tier = 2;
      reasons.push('it follows content Jarvis read from outside');
    }
    if (isSender(call.tool)) {
      const n = await countRecipients(
        call.tool,
        call.input,
        this.#o.channelMembers ?? (async () => null),
      );
      if (n > MANY_RECIPIENTS && tier < 3) {
        tier = 3;
        reasons.push(Number.isFinite(n) ? `it reaches ${n} people` : 'it may reach many people');
      }
    }

    if (tier <= 1) return { kind: 'run', tier };
    if (tier === 2 && task.approvedAll.has(call.tool)) return { kind: 'run', tier };
    return { kind: 'ask', tier: tier as 2 | 3, reasons, ...approvalText(call.tool, call.input) };
  }
}
