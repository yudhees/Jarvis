import type { ModelTier } from '@jarvis/shared';
import { higherTier } from './route.ts';

export interface Classification {
  tier: ModelTier;
  needsTools: boolean;
  reason: string;
}

/** Asks a small model how hard a request is (CLAUDE.md 7, rule 4). */
export interface Classifier {
  classify(text: string): Promise<Classification | null>;
}

export const CLASSIFIER_PROMPT = `You sort requests for a voice assistant by how capable a model they need. Reply with JSON only, no other text:
{"tier": "simple" | "standard" | "complex", "needs_tools": true | false, "reason": "at most four words"}
simple: small talk, quick facts, time, short rewrites, yes/no.
standard: most tasks with a service or tool (messages, tickets, email, calendar, files), normal code questions.
complex: multi-step planning, debugging, code changes, architecture, long research.`;

/** Reads the classifier's JSON; null if it is not exactly what was asked for. */
export function parseClassification(raw: string): Classification | null {
  const json = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const { tier, needs_tools, reason } = o as Record<string, unknown>;
  if (tier !== 'simple' && tier !== 'standard' && tier !== 'complex') return null;
  return {
    tier,
    needsTools: needs_tools === true,
    reason: typeof reason === 'string' ? reason.slice(0, 120) : '',
  };
}

export interface ClassifierOutcome {
  tier: ModelTier;
  /** True when the classifier answered in time and raised the tier. */
  raised: boolean;
  /** What it said, or null when it was too slow or its answer was not valid. */
  classification: Classification | null;
  ms: number;
}

/**
 * Rule 4: the classifier may raise the estimate, never lower it. If it is slower
 * than the limit or answers badly, the estimate stands. A slow answer is not
 * cancelled, so the classifier keeps warming up for the next request.
 */
export async function classifyWithin(
  classifier: Classifier,
  text: string,
  estimate: ModelTier,
  timeoutMs: number,
): Promise<ClassifierOutcome> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const answer = classifier.classify(text).catch(() => null);
  const classification = await Promise.race([answer, late]);
  clearTimeout(timer);
  const ms = performance.now() - t0;
  if (!classification) return { tier: estimate, raised: false, classification: null, ms };
  const tier = higherTier(estimate, classification.tier);
  return { tier, raised: tier !== estimate, classification, ms };
}
