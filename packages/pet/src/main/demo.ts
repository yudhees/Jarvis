import type { CoreToPetEvent } from '@jarvis/shared';

export type Step =
  | { at: number; event: CoreToPetEvent }
  | { at: number; levels: 'mic' | 'speak'; until: number };

/**
 * A scripted request, used while core is not running, so the pet can be seen
 * doing everything: wake, listen, think on Sonnet, use Jira, ask for approval,
 * act, answer, and fall back asleep. Times are in milliseconds from the start.
 */
export function demoScript(): Step[] {
  const reply = 'Done. PROJ-142 is in review and the team has been told on Slack.';
  return [
    { at: 0, event: { type: 'state', state: 'LISTENING' } },
    { at: 0, levels: 'mic', until: 2600 },
    { at: 500, event: { type: 'transcript_partial', text: 'Move PROJ-142…' } },
    { at: 1400, event: { type: 'transcript_partial', text: 'Move PROJ-142 to In Review and…' } },
    {
      at: 2600,
      event: {
        type: 'transcript_final',
        text: 'Move PROJ-142 to In Review and tell the team on Slack.',
      },
    },
    {
      at: 2800,
      event: { type: 'model_selected', tier: 'standard', speed: 'normal', model: 'Sonnet' },
    },
    { at: 2800, event: { type: 'state', state: 'THINKING' } },
    { at: 3600, event: { type: 'tool_start', tool: 'jira' } },
    { at: 5000, event: { type: 'tool_end', tool: 'jira', ok: true } },
    { at: 5100, event: { type: 'state', state: 'AWAITING_APPROVAL' } },
    {
      at: 5100,
      event: {
        type: 'approval_request',
        id: 'demo-1',
        sentence:
          "I'm about to move PROJ-142 to In Review and post in #team: PROJ-142 is ready for review. Approve or cancel?",
      },
    },
    { at: 9600, event: { type: 'approval_result', id: 'demo-1', approved: true } },
    { at: 9700, event: { type: 'state', state: 'THINKING' } },
    { at: 9800, event: { type: 'tool_start', tool: 'slack' } },
    { at: 11000, event: { type: 'tool_end', tool: 'slack', ok: true } },
    { at: 11100, event: { type: 'reply_text', text: reply } },
    { at: 11100, event: { type: 'state', state: 'SPEAKING' } },
    { at: 11100, levels: 'speak', until: 15200 },
    { at: 15300, event: { type: 'state', state: 'FOLLOW_UP' } },
    { at: 21000, event: { type: 'state', state: 'SLEEPING' } },
  ];
}

/** Plays a script; returns a function that cancels it. */
export function playScript(steps: Step[], emit: (e: CoreToPetEvent) => void): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const step of steps) {
    if ('event' in step) {
      timers.push(setTimeout(() => emit(step.event), step.at));
    } else {
      const type = step.levels === 'mic' ? 'mic_level' : 'speak_level';
      for (let t = step.at; t < step.until; t += 80) {
        timers.push(
          setTimeout(() => {
            const wave = Math.abs(Math.sin(t / 140));
            const level = Math.min(1, 0.15 + wave * 0.55 + Math.random() * 0.3);
            emit({ type, level });
          }, t),
        );
      }
      timers.push(setTimeout(() => emit({ type, level: 0 }), step.until));
    }
  }
  return () => {
    for (const t of timers) clearTimeout(t);
  };
}
