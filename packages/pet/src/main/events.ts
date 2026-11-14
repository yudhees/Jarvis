import {
  CORE_TO_PET_TYPES,
  type CoreToPetEvent,
  INPUT_LIMITS,
  STATES,
  type VoiceTestResult,
} from '@jarvis/shared';

const TYPES = new Set<string>(CORE_TO_PET_TYPES);
const STATE_SET = new Set<string>(STATES);
const MAX_TEXT = 2000;

const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT;
const isLevel = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);

/** Questions that ask for secrets are refused even if core sends one (CLAUDE.md 10.3). */
const SECRET_QUESTION =
  /\b(password|passcode|pin|api key|secret|token|credential|card number|cvv|otp|one-time code|2fa|verification code)\b/i;

function isValidInputRequest(e: Record<string, unknown>): boolean {
  if (!isId(e.id) || !isText(e.question) || e.question.length > 400) return false;
  if (SECRET_QUESTION.test(e.question)) return false;
  if (e.placeholder !== undefined && !(isText(e.placeholder) && e.placeholder.length <= 80)) {
    return false;
  }
  if (e.mode === 'text') return e.options === undefined;
  if (e.mode !== 'choice' || !Array.isArray(e.options)) return false;
  const opts = e.options as unknown[];
  return (
    opts.length >= 2 &&
    opts.length <= INPUT_LIMITS.maxOptions &&
    opts.every(
      (o) =>
        typeof o === 'string' && o.trim().length > 0 && o.length <= INPUT_LIMITS.maxOptionLength,
    )
  );
}

const TEST_OUTCOMES = new Set([
  'nothing',
  'command',
  'pending_answer',
  'learning',
  'model_command',
  'agent',
]);
const TIER_SET = new Set(['simple', 'standard', 'complex']);
const SPEED_SET = new Set(['instant', 'normal', 'background']);
const short = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' && v.length <= max ? v : undefined;

/**
 * Voice test report: copies only known fields, each checked, so nothing else
 * from core reaches the Settings window.
 */
function cleanVoiceTest(e: Record<string, unknown>): VoiceTestResult | null {
  if (typeof e.outcome !== 'string' || !TEST_OUTCOMES.has(e.outcome)) return null;
  if (!isText(e.heard) || !isText(e.text)) return null;
  const out: VoiceTestResult = {
    type: 'voice_test_result',
    outcome: e.outcome as VoiceTestResult['outcome'],
    heard: e.heard,
    text: e.text,
    sttMs: typeof e.sttMs === 'number' && e.sttMs >= 0 ? e.sttMs : 0,
  };
  const detail = short(e.detail, 60);
  if (detail) out.detail = detail;
  if (isText(e.request)) out.request = e.request;
  if (TIER_SET.has(String(e.tier))) out.tier = e.tier as VoiceTestResult['tier'];
  if (SPEED_SET.has(String(e.speed))) out.speed = e.speed as VoiceTestResult['speed'];
  for (const key of ['model', 'decidedBy', 'reason', 'kind'] as const) {
    const v = short(e[key]);
    if (v) out[key] = v;
  }
  if (typeof e.classifier === 'boolean') out.classifier = e.classifier;
  if (Array.isArray(e.skills)) {
    out.skills = e.skills.filter((s): s is string => short(s, 120) !== undefined).slice(0, 10);
  }
  return out;
}

/** Checks a typed or clicked answer before it goes to core. */
export function cleanAnswer(id: unknown, value: unknown): { id: string; value: string } | null {
  if (!isId(id) || typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0 || trimmed.length > INPUT_LIMITS.maxAnswerLength) return null;
  return { id, value: trimmed };
}

/**
 * Checks a message from core before it reaches the window. Anything malformed is
 * dropped, so a bad message can only fail to show, never run code.
 */
export function parseCoreEvent(raw: unknown): CoreToPetEvent | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const e = data as Record<string, unknown>;
  if (typeof e.type !== 'string' || !TYPES.has(e.type)) return null;
  switch (e.type) {
    case 'state':
      return typeof e.state === 'string' && STATE_SET.has(e.state)
        ? (e as unknown as CoreToPetEvent)
        : null;
    case 'mic_level':
    case 'speak_level':
      return isLevel(e.level) ? (e as unknown as CoreToPetEvent) : null;
    case 'transcript_partial':
    case 'transcript_final':
    case 'reply_text':
      return isText(e.text) ? (e as unknown as CoreToPetEvent) : null;
    case 'tool_start':
      return isText(e.tool) ? (e as unknown as CoreToPetEvent) : null;
    case 'tool_end':
      return isText(e.tool) && typeof e.ok === 'boolean' ? (e as unknown as CoreToPetEvent) : null;
    case 'approval_request':
      return isText(e.id) &&
        isText(e.sentence) &&
        (e.fullText === undefined || isText(e.fullText)) &&
        (e.code === undefined || (typeof e.code === 'string' && /^\d{2}$/.test(e.code)))
        ? (e as unknown as CoreToPetEvent)
        : null;
    case 'approval_result':
      return isText(e.id) && typeof e.approved === 'boolean'
        ? (e as unknown as CoreToPetEvent)
        : null;
    case 'model_selected':
      return ['simple', 'standard', 'complex'].includes(String(e.tier)) && isText(e.model)
        ? (e as unknown as CoreToPetEvent)
        : null;
    case 'budget':
      return typeof e.usedFraction === 'number' ? (e as unknown as CoreToPetEvent) : null;
    case 'error':
      return isText(e.message) ? (e as unknown as CoreToPetEvent) : null;
    case 'input_request':
      return isValidInputRequest(e) ? (e as unknown as CoreToPetEvent) : null;
    case 'input_closed':
      return isId(e.id) ? (e as unknown as CoreToPetEvent) : null;
    case 'voice_test_result':
      return cleanVoiceTest(e);
    default:
      return null;
  }
}
