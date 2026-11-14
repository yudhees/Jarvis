import type { CoreToPetEvent } from '@jarvis/shared';

export type Step =
  | { at: number; event: CoreToPetEvent }
  | { at: number; levels: 'mic' | 'speak'; until: number };

export const DEMO_PROJECT_QUESTION = 'demo-project';
export const DEMO_TITLE_QUESTION = 'demo-title';

/**
 * A scripted request used while core is not running, so the pet can be seen
 * doing everything. It runs in three parts because it stops twice to ask:
 * 1. wake, listen, think on Sonnet, look up Jira projects, ask which project (buttons);
 * 2. ask for the ticket title (text box);
 * 3. ask for spoken approval, create the ticket, tell Slack, answer, sleep.
 * Times are in milliseconds from the start of each part.
 */
export function demoScript(): Step[] {
  return [
    { at: 0, event: { type: 'state', state: 'LISTENING' } },
    { at: 0, levels: 'mic', until: 2600 },
    { at: 500, event: { type: 'transcript_partial', text: 'Create a Jira ticket for…' } },
    {
      at: 1400,
      event: {
        type: 'transcript_partial',
        text: 'Create a Jira ticket for the login timeout and…',
      },
    },
    {
      at: 2600,
      event: {
        type: 'transcript_final',
        text: 'Create a Jira ticket for the login timeout and tell the team on Slack.',
      },
    },
    {
      at: 2800,
      event: { type: 'model_selected', tier: 'standard', speed: 'normal', model: 'Sonnet' },
    },
    { at: 2800, event: { type: 'state', state: 'THINKING' } },
    { at: 3400, event: { type: 'tool_start', tool: 'jira' } },
    { at: 4600, event: { type: 'tool_end', tool: 'jira', ok: true } },
    { at: 4700, event: { type: 'state', state: 'AWAITING_INPUT' } },
    {
      at: 4700,
      event: {
        type: 'input_request',
        id: DEMO_PROJECT_QUESTION,
        question: 'Which project should the ticket go in?',
        mode: 'choice',
        options: ['PROJ · Platform', 'WEB · Website', 'MOB · Mobile app'],
      },
    },
  ];
}

export function demoTitleQuestion(project: string): Step[] {
  return [
    { at: 0, event: { type: 'input_closed', id: DEMO_PROJECT_QUESTION } },
    { at: 0, event: { type: 'state', state: 'THINKING' } },
    { at: 700, event: { type: 'state', state: 'AWAITING_INPUT' } },
    {
      at: 700,
      event: {
        type: 'input_request',
        id: DEMO_TITLE_QUESTION,
        question: `What should the ${project.split(' ')[0]} ticket be called?`,
        mode: 'text',
        placeholder: 'Login times out after 30 seconds',
      },
    },
  ];
}

export function demoFinish(project: string, title: string): Step[] {
  const key = `${project.split(' ')[0]}-218`;
  const reply = `Done. ${key} is created and the team has been told on Slack.`;
  return [
    { at: 0, event: { type: 'input_closed', id: DEMO_TITLE_QUESTION } },
    { at: 0, event: { type: 'state', state: 'THINKING' } },
    { at: 600, event: { type: 'state', state: 'AWAITING_APPROVAL' } },
    {
      at: 600,
      event: {
        type: 'approval_request',
        id: 'demo-approval',
        sentence: `I'm about to create a bug in ${project.split(' ')[0]} titled "${title}" and post it in #team. Approve or cancel?`,
      },
    },
    // In the real app the user says "approve"; the demo answers for them.
    { at: 5600, event: { type: 'approval_result', id: 'demo-approval', approved: true } },
    { at: 5700, event: { type: 'state', state: 'THINKING' } },
    { at: 5800, event: { type: 'tool_start', tool: 'jira' } },
    { at: 6800, event: { type: 'tool_start', tool: 'slack' } },
    { at: 7800, event: { type: 'tool_end', tool: 'slack', ok: true } },
    { at: 7900, event: { type: 'reply_text', text: reply } },
    { at: 7900, event: { type: 'state', state: 'SPEAKING' } },
    { at: 7900, levels: 'speak', until: 11500 },
    { at: 11600, event: { type: 'state', state: 'FOLLOW_UP' } },
    { at: 17000, event: { type: 'state', state: 'SLEEPING' } },
  ];
}

/** When the user does not answer a demo question. */
export function demoNoAnswer(id: string): Step[] {
  return [
    { at: 0, event: { type: 'input_closed', id } },
    {
      at: 0,
      event: { type: 'reply_text', text: "No answer, so I've stopped there. Nothing was created." },
    },
    { at: 0, event: { type: 'state', state: 'SPEAKING' } },
    { at: 0, levels: 'speak', until: 2600 },
    { at: 2700, event: { type: 'state', state: 'SLEEPING' } },
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
