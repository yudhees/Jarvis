/** Events and states shared by core and pet. See CLAUDE.md sections 6 and 12. */

export const STATES = [
  'SLEEPING',
  'LISTENING',
  'THINKING',
  'AWAITING_APPROVAL',
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
  | { type: 'error'; message: string };

/** Pet -> core. There is deliberately no `approve`: approval is voice only. */
export type PetToCoreEvent =
  | { type: 'stop' }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'quit' };
