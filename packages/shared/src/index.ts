/** Events and states shared by core and pet. See CLAUDE.md sections 6 and 12. */

export const STATES = [
  'SLEEPING',
  'LISTENING',
  'THINKING',
  'AWAITING_APPROVAL',
  'AWAITING_INPUT',
  'SPEAKING',
  'FOLLOW_UP',
  'MUTED',
  'ERROR',
] as const;
export type JarvisState = (typeof STATES)[number];

export type ModelTier = 'simple' | 'standard' | 'complex';
export type Speed = 'instant' | 'normal' | 'background';
export type RiskTier = 0 | 1 | 2 | 3 | 4;

/** Core -> pet. */
export type CoreToPetEvent =
  | { type: 'state'; state: JarvisState }
  | { type: 'mic_level'; level: number }
  | { type: 'transcript_partial'; text: string }
  | { type: 'transcript_final'; text: string }
  | { type: 'reply_text'; text: string }
  | { type: 'speak_level'; level: number }
  | { type: 'tool_start'; tool: string }
  | { type: 'tool_end'; tool: string; ok: boolean }
  | { type: 'approval_request'; id: string; sentence: string; fullText?: string; code?: string }
  | { type: 'approval_result'; id: string; approved: boolean }
  | { type: 'model_selected'; tier: ModelTier; speed: Speed; model: string }
  | { type: 'budget'; usedFraction: number }
  | { type: 'error'; message: string }
  | InputRequest
  | { type: 'input_closed'; id: string };

/**
 * Jarvis needs something to continue (a choice, a name, a title). The user can
 * answer by voice, by clicking a choice, or by typing in the pet. Never used for
 * approvals (voice only, section 9) and never for passwords or keys.
 */
export interface InputRequest {
  type: 'input_request';
  id: string;
  question: string;
  /** 'choice' shows buttons from `options`; 'text' shows a text box. */
  mode: 'choice' | 'text';
  options?: string[];
  placeholder?: string;
}

/** Limits shared by core (when asking) and the pet (when checking). */
export const INPUT_LIMITS = { maxOptions: 6, maxOptionLength: 60, maxAnswerLength: 500 } as const;

/** First message from the pet on the local WebSocket. Core closes the socket if the token is wrong. */
export interface PetHello {
  type: 'hello';
  token: string;
}

export const CORE_TO_PET_TYPES = [
  'state',
  'mic_level',
  'transcript_partial',
  'transcript_final',
  'reply_text',
  'speak_level',
  'tool_start',
  'tool_end',
  'approval_request',
  'approval_result',
  'model_selected',
  'budget',
  'error',
  'input_request',
  'input_closed',
] as const;

/**
 * Pet -> core. There is deliberately no `approve`: approval is voice only.
 * An input_reply is treated like the user's own words: it can answer a question,
 * but core never counts it as an approval.
 */
export type PetToCoreEvent =
  | { type: 'stop' }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'quit' }
  | { type: 'input_reply'; id: string; value: string }
  | { type: 'input_cancel'; id: string };
