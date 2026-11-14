import { CORE_TO_PET_TYPES, type CoreToPetEvent, STATES } from '@jarvis/shared';

const TYPES = new Set<string>(CORE_TO_PET_TYPES);
const STATE_SET = new Set<string>(STATES);
const MAX_TEXT = 2000;

const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT;
const isLevel = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

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
    default:
      return null;
  }
}
