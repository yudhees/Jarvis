import type { ModelTier, Speed } from '@jarvis/shared';

/**
 * Things the user says *about* Jarvis or themselves, recognized in code before any
 * model call (CLAUDE.md 13.1). Anything not matched is a normal request.
 */
export type Statement =
  | { type: 'refuse_rule_change' }
  | { type: 'list' }
  | { type: 'forget_last' }
  | { type: 'forget'; query: string }
  | { type: 'call_me'; name: string }
  | { type: 'vocabulary'; heard: string; meant: string }
  | { type: 'routing_rule'; kindPhrase: string; tier?: ModelTier; speed?: Speed }
  | { type: 'feedback'; signal: 'too_slow' | 'too_weak' }
  | { type: 'remember'; kind: 'fact' | 'preference'; text: string };

/** Strips "Jarvis," and trailing punctuation; keeps the user's casing. */
export function cleanUtterance(text: string): string {
  return text
    .trim()
    .replace(/^(?:hey |hi |ok |okay )?jarvis[,.!:]?\s*/i, '')
    .replace(/[\s.!?]+$/, '')
    .replace(/\s+/g, ' ');
}

const APPROVAL_WORDS =
  /\b(approv\w*|permission\w*|confirm\w*|guard\w*|safety|security|risk tiers?|tiers?|ask(ing)? me first)\b/i;
const LOOSENING_WORDS =
  /\b(always|never|don'?t|do not|stop|skip|without|no need|no longer|auto\w*|bypass|disable|turn off|ignore|from now on)\b/i;

const TIER_WORDS: Record<string, ModelTier> = {
  haiku: 'simple',
  fast: 'simple',
  faster: 'simple',
  fastest: 'simple',
  quick: 'simple',
  quicker: 'simple',
  sonnet: 'standard',
  opus: 'complex',
  smart: 'complex',
  smarter: 'complex',
  smartest: 'complex',
  best: 'complex',
};

const PREFERENCE_START =
  /^(?:from now on,? )?(?:i (?:prefer|like|love|hate|don'?t like|do not like|would rather|'?d rather)|please (?:always|never)|always|never|keep (?:your )?(?:answers|replies|it))\b/i;

export function parseStatement(raw: string): Statement | null {
  const text = cleanUtterance(raw);
  const lower = text.toLowerCase();
  if (lower.length === 0) return null;

  // Learning can never loosen approvals or guardrails (CLAUDE.md 13.1). Checked first.
  if (
    APPROVAL_WORDS.test(lower) &&
    LOOSENING_WORDS.test(lower) &&
    /^(?:from now on|always|never|don'?t|do not|stop|skip|remember|you (?:don'?t|do not|no longer) need|no need|i (?:don'?t|do not) (?:want|need)|please|auto|disable|turn off|bypass|ignore)/i.test(
      lower,
    )
  ) {
    return { type: 'refuse_rule_change' };
  }

  if (
    /^(what (have|did) you (learn|learned|learnt)( about me)?|what do you (know|remember) about me|what have you remembered)\b/.test(
      lower,
    )
  ) {
    return { type: 'list' };
  }
  if (/^forget (that|it|this|what i just said)$/.test(lower)) return { type: 'forget_last' };
  const forget = /^forget (?:everything |all )?(?:about |that |what you know about )?(.+)$/i.exec(
    text,
  );
  if (forget) return { type: 'forget', query: forget[1] as string };

  const callMe = /^(?:call me|my name is) (.+)$/i.exec(text);
  if (callMe) return { type: 'call_me', name: callMe[1] as string };

  const vocab = /^(?:it'?s|it is|i said|that'?s|that is) "?(.+?)"?,? not "?(.+?)"?$/i.exec(text);
  if (vocab) return { type: 'vocabulary', meant: vocab[1] as string, heard: vocab[2] as string };

  const rule =
    /^(?:from now on,? )?(?:please )?(?:always )?use (?:the )?(haiku|sonnet|opus|fast|faster|fastest|quick|quicker|smart|smarter|smartest|best)(?: model)? (?:for|on|when|with) (.+)$/i.exec(
      text,
    );
  if (rule) {
    return {
      type: 'routing_rule',
      tier: TIER_WORDS[(rule[1] as string).toLowerCase()] as ModelTier,
      kindPhrase: rule[2] as string,
    };
  }
  const speedRule =
    /^(?:from now on,? )?(?:please )?(?:always )?(be quick|be fast|answer fast|take your time) (?:with|on|for|when) (.+)$/i.exec(
      text,
    );
  if (speedRule) {
    const speed: Speed = /take your time/i.test(speedRule[1] as string) ? 'background' : 'instant';
    return { type: 'routing_rule', speed, kindPhrase: speedRule[2] as string };
  }

  if (
    /\b(too slow|took (?:too|so|way too) long|faster next time|be faster|be quicker|that was slow)\b/.test(
      lower,
    )
  ) {
    return { type: 'feedback', signal: 'too_slow' };
  }
  if (
    /\b(use (?:a|something) (?:smarter|better)( model)?|not smart enough|think harder|that was wrong|that'?s wrong|you got (?:that|it) wrong|that'?s not right)\b/.test(
      lower,
    )
  ) {
    return { type: 'feedback', signal: 'too_weak' };
  }

  const remember =
    /^(?:please )?(?:remember|note|keep in mind|don'?t forget)(?: that)?[,:]? (.+)$/i.exec(text);
  if (remember) {
    const inner = remember[1] as string;
    return {
      type: 'remember',
      kind: PREFERENCE_START.test(inner) ? 'preference' : 'fact',
      text: inner,
    };
  }
  if (PREFERENCE_START.test(text)) return { type: 'remember', kind: 'preference', text };
  return null;
}
