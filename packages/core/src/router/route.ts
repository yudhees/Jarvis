import type { ModelTier, Speed } from '@jarvis/shared';
import { classifyKind, type RequestKind } from './kinds.ts';

/** What the user has taught Jarvis for one kind of request (CLAUDE.md 13.1). */
export interface LearnedRouting {
  tier?: ModelTier;
  speed?: Speed;
}

export interface RouteInput {
  text: string;
  /** "Jarvis, use Opus" for this request. Wins over everything. */
  forced?: ModelTier;
  /** Tier of the conversation in progress; follow-ups never go below it. */
  followUpTier?: ModelTier;
  learned?: ReadonlyMap<RequestKind, LearnedRouting>;
}

export type DecidedBy = 'forced' | 'follow_up' | 'learned' | 'estimate';

export interface RouteDecision {
  kind: RequestKind;
  tier: ModelTier;
  speed: Speed;
  decidedBy: DecidedBy;
  /** True when the code estimate is unsure: the Haiku classifier may raise (never lower) the tier. */
  needsClassifier: boolean;
  /** Why this tier, for logs and for 'what are you doing?'. */
  reason: string;
  speedFrom: 'cue' | 'learned' | 'default';
}

const ORDER: ModelTier[] = ['simple', 'standard', 'complex'];

export function raiseTier(tier: ModelTier): ModelTier {
  return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(tier) + 1)] as ModelTier;
}

export function lowerTier(tier: ModelTier): ModelTier {
  return ORDER[Math.max(0, ORDER.indexOf(tier) - 1)] as ModelTier;
}

export function higherTier(a: ModelTier, b: ModelTier): ModelTier {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

const MODEL_WORDS: Record<string, ModelTier> = {
  haiku: 'simple',
  sonnet: 'standard',
  opus: 'complex',
};

/**
 * "Jarvis, use Opus" / "use sonnet to summarize this". Returns the tier and the
 * rest of the request (empty when the command was on its own).
 */
export function parseModelCommand(text: string): { tier: ModelTier; rest: string } | null {
  const m = /^\s*(?:jarvis[,.!]?\s+)?use\s+(haiku|sonnet|opus)\b(.*)$/is.exec(text);
  if (!m) return null;
  let rest = (m[2] ?? '').replace(/^[\s,.:;!-]+/, '');
  // "use opus for coding" is a standing preference, handled by the learner instead.
  if (/^(for|on|when)\s+(?!this\b)/i.test(rest)) return null;
  rest = rest.replace(/^(to|and|for this)\b[\s,:]*/i, '').trim();
  return { tier: MODEL_WORDS[(m[1] as string).toLowerCase()] as ModelTier, rest };
}

/** Spoken speed cues (section 7.1 rule 1). */
export function speedCue(text: string): Speed | undefined {
  const lower = text.toLowerCase();
  if (
    /\b(take your time|no rush|dig into|look into it|research|in the background|when you can)\b/.test(
      lower,
    )
  ) {
    return 'background';
  }
  if (/\b(quick(ly)?|fast|just tell me|briefly|in a word|short answer)\b/.test(lower)) {
    return 'instant';
  }
  return undefined;
}

const TASK_VERBS =
  /\b(send|create|make|open|close|set|start|stop|delete|remove|write|draft|read|check|find|search|look|show|list|summari[sz]e|book|schedule|remind|post|reply|update|edit|move|play|call|fix|build|run|deploy|plan|research|compare|explain|debug|translate|calculate|review|refactor|analy[sz]e|investigate)\b/i;

/** Words that mean many steps or deep reasoning: Opus territory. */
const COMPLEX_MARKERS =
  /\b(step by step|multi-?step|and then|end to end|across (?:all|every|the)|architecture|design (?:a|the)|refactor|root cause|investigate|debug|review (?:the|this|my) (?:pr|pull request|code|design)|trade-?offs?|migrat\w+|plan (?:out|the)|strategy|research|deep dive|in depth|compare)\b/i;

/** Kinds that need a service tool: Sonnet is the floor. */
const TOOL_KINDS = new Set<RequestKind>([
  'github',
  'jira',
  'slack',
  'email',
  'calendar',
  'files',
  'writing',
]);

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

interface Estimate {
  tier: ModelTier;
  sure: boolean;
  reason: string;
}

/**
 * Haiku-first estimate (CLAUDE.md 7). Starts at the smallest model and climbs only
 * on evidence in the request. Unsure cases are flagged for the Haiku classifier.
 */
export function estimateTier(text: string, kind: RequestKind): Estimate {
  const words = wordCount(text);
  const complex = COMPLEX_MARKERS.test(text);
  const hasTask = TASK_VERBS.test(text);

  if ((kind === 'code' || kind === 'planning') && (complex || words > 25)) {
    return { tier: 'complex', sure: true, reason: `${kind} with multi-step or deep work` };
  }
  if (complex && hasTask) {
    return { tier: 'complex', sure: words > 12, reason: 'multi-step task' };
  }
  if (words > 60) return { tier: 'complex', sure: false, reason: 'long, detailed request' };
  if (kind === 'code' || kind === 'planning') {
    return { tier: 'standard', sure: false, reason: `${kind} request` };
  }
  if (TOOL_KINDS.has(kind)) {
    return { tier: 'standard', sure: true, reason: `${kind} needs a service tool` };
  }
  if (words < 6 && !hasTask) return { tier: 'simple', sure: true, reason: 'short chat' };
  if (kind === 'chat' && words > 20) return { tier: 'simple', sure: false, reason: 'long chat' };
  return { tier: 'simple', sure: true, reason: `${kind}: small model first` };
}

/**
 * Code-only routing (section 7). Order: forced, follow-up, learned preference,
 * then the Haiku-first estimate. Never lowers a conversation's tier.
 */
export function route(input: RouteInput): RouteDecision {
  const kind = classifyKind(input.text);
  const learned = input.learned?.get(kind);
  const cue = speedCue(input.text);
  const estimate = estimateTier(input.text, kind);

  let tier: ModelTier;
  let decidedBy: DecidedBy;
  let reason: string;
  let needsClassifier = false;
  if (input.forced) {
    tier = input.forced;
    decidedBy = 'forced';
    reason = 'user asked for this model';
  } else if (input.followUpTier) {
    tier = higherTier(input.followUpTier, learned?.tier ?? input.followUpTier);
    decidedBy = 'follow_up';
    reason = 'same conversation keeps its model';
  } else if (learned?.tier) {
    tier = learned.tier;
    decidedBy = 'learned';
    reason = `you taught me this for ${kind}`;
  } else {
    tier = estimate.tier;
    decidedBy = 'estimate';
    reason = estimate.reason;
    needsClassifier = !estimate.sure;
  }

  let speed: Speed;
  let speedFrom: RouteDecision['speedFrom'];
  if (cue) {
    speed = cue;
    speedFrom = 'cue';
  } else if (learned?.speed) {
    speed = learned.speed;
    speedFrom = 'learned';
  } else {
    speed = tier === 'simple' || decidedBy === 'follow_up' ? 'instant' : 'normal';
    speedFrom = 'default';
  }
  return { kind, tier, speed, decidedBy, needsClassifier, reason, speedFrom };
}

/**
 * A smaller model must not guess (CLAUDE.md 8): when unsure it replies starting
 * with [[ESCALATE: reason]] and Jarvis retries one tier up. Returns null otherwise.
 */
export function parseEscalation(reply: string): { reason: string } | null {
  const m = /^\s*\[\[ESCALATE(?::\s*([^\]]*))?\]\]/i.exec(reply);
  return m ? { reason: (m[1] ?? '').trim() || 'model asked for a stronger model' } : null;
}
