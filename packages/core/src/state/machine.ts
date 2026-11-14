import type { JarvisState } from '@jarvis/shared';

/**
 * Allowed moves (CLAUDE.md 6). SLEEPING, MUTED and ERROR are reachable from
 * anywhere, so the kill switches and error handling always work.
 */
const NEXT: Record<JarvisState, readonly JarvisState[]> = {
  SLEEPING: ['LISTENING'],
  LISTENING: ['THINKING'],
  THINKING: ['SPEAKING', 'FOLLOW_UP', 'AWAITING_APPROVAL', 'AWAITING_INPUT', 'LISTENING'],
  AWAITING_APPROVAL: ['THINKING', 'SPEAKING'],
  AWAITING_INPUT: ['THINKING', 'SPEAKING'],
  SPEAKING: ['FOLLOW_UP', 'LISTENING', 'THINKING'],
  FOLLOW_UP: ['LISTENING', 'THINKING'],
  MUTED: [],
  ERROR: ['SPEAKING'],
};
const ALWAYS: readonly JarvisState[] = ['SLEEPING', 'MUTED', 'ERROR'];

export class StateError extends Error {}

export class StateMachine {
  #state: JarvisState = 'SLEEPING';
  readonly #onChange: (state: JarvisState, from: JarvisState) => void;

  constructor(onChange: (state: JarvisState, from: JarvisState) => void = () => {}) {
    this.#onChange = onChange;
  }

  get state(): JarvisState {
    return this.#state;
  }

  can(next: JarvisState): boolean {
    if (next === this.#state) return true;
    if (this.#state === 'MUTED') return next === 'SLEEPING';
    return ALWAYS.includes(next) || NEXT[this.#state].includes(next);
  }

  /** Moves to `next`; throws on a move the spec does not allow. Same state is a no-op. */
  to(next: JarvisState): void {
    if (next === this.#state) return;
    if (!this.can(next)) throw new StateError(`cannot go from ${this.#state} to ${next}`);
    const from = this.#state;
    this.#state = next;
    this.#onChange(next, from);
  }
}
