import type { JarvisState } from '@jarvis/shared';

export interface PetPrefs {
  /** Fade the pet out a little after Jarvis goes back to sleep. */
  hideWhenIdle: boolean;
  idleSeconds: number;
}

export const DEFAULT_PREFS: PetPrefs = { hideWhenIdle: true, idleSeconds: 8 };

/** The mic is recording: the pet must be visible (CLAUDE.md 10.4). */
const RECORDING = new Set<JarvisState>(['LISTENING', 'FOLLOW_UP']);
/** Jarvis is waiting on the user: the question has to be seen to be answered. */
const NEEDS_USER = new Set<JarvisState>(['AWAITING_APPROVAL', 'AWAITING_INPUT']);
/** Busy but not recording or waiting: a manual hide is respected. */
const BUSY = new Set<JarvisState>(['THINKING', 'SPEAKING', 'ERROR']);

export type VisibilityAction =
  | { action: 'show'; clearManualHide: boolean }
  | { action: 'hide' }
  | { action: 'hide_later'; afterMs: number };

/**
 * Decides whether the pet window is on screen (CLAUDE.md 11).
 * - Recording (wake word heard, follow-up window): always shown, and a manual
 *   "Hide pet" ends, so saying "Hi Jarvis" brings it back.
 * - Waiting for an approval or an answer: always shown.
 * - Busy (thinking, speaking): shown unless the user hid it.
 * - Asleep or muted: hidden if the user hid it, otherwise hidden after a short
 *   idle delay when "Hide when idle" is on, otherwise shown.
 */
export function visibilityFor(
  state: JarvisState,
  manuallyHidden: boolean,
  prefs: PetPrefs,
): VisibilityAction {
  if (RECORDING.has(state)) return { action: 'show', clearManualHide: true };
  if (NEEDS_USER.has(state)) return { action: 'show', clearManualHide: false };
  if (manuallyHidden) return { action: 'hide' };
  if (BUSY.has(state)) return { action: 'show', clearManualHide: false };
  if (prefs.hideWhenIdle) return { action: 'hide_later', afterMs: prefs.idleSeconds * 1000 };
  return { action: 'show', clearManualHide: false };
}

export function parsePrefs(raw: unknown): PetPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const idle = Number(p.idleSeconds);
  return {
    hideWhenIdle: typeof p.hideWhenIdle === 'boolean' ? p.hideWhenIdle : DEFAULT_PREFS.hideWhenIdle,
    idleSeconds:
      Number.isFinite(idle) && idle >= 2 && idle <= 600 ? idle : DEFAULT_PREFS.idleSeconds,
  };
}
