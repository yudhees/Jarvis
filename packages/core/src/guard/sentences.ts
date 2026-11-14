/**
 * The approval sentence is built in code from the real tool input (CLAUDE.md 9),
 * never from the model's own description, which could be tricked into
 * describing an action wrongly.
 */
export interface ApprovalText {
  /** Spoken: short, with long content summarized by length. */
  sentence: string;
  /** Shown in full in the pet's bubble. */
  fullText: string;
}

/** Content longer than this is spoken as "a 240-word message". */
const SPOKEN_WORDS = 25;

function str(v: unknown, fallback = 'something'): string {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : fallback;
}

function words(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

/** Short content read out; long content summarized. */
function said(content: string, noun: string): string {
  const n = words(content);
  return n > SPOKEN_WORDS ? `a ${n}-word ${noun}` : `${noun} saying: ${content}`;
}

type Template = (i: Record<string, unknown>) => { action: string; content?: string };

const TEMPLATES: Record<string, Template> = {
  jira_transition: (i) => ({ action: `move ${str(i.issue)} to ${str(i.status)}` }),
  jira_comment: (i) => {
    const body = str(i.body, '');
    return { action: `add to ${str(i.issue)} a ${said(body, 'comment')}`, content: body };
  },
  jira_create: (i) => {
    const desc = str(i.description, '');
    return {
      action: `create a ${str(i.type, 'task').toLowerCase()} in ${str(i.project)} titled: ${str(i.summary)}`,
      content: desc,
    };
  },
  jira_assign: (i) => ({
    action: `assign ${str(i.issue)} to ${i.assignee === null || i.assignee === '' ? 'nobody' : str(i.assignee)}`,
  }),
  file_write: (i) => {
    const text = str(i.content, '');
    return {
      action: `write the file ${str(i.path)} in your Jarvis folder, ${said(text, 'text').replace(/^text saying: /, 'with: ')}`,
      content: text,
    };
  },
  file_delete: (i) => ({ action: `delete the file ${str(i.path)} from your Jarvis folder` }),
  slack_send_message: (i) => {
    const text = str(i.text, '');
    return {
      action: `send a Slack message to ${str(i.channel_name ?? i.channel_id)}, ${said(text, 'message')}`,
      content: text,
    };
  },
};

/** "I'm about to move PROJ-142 to In Review. Approve or cancel?" */
export function approvalText(tool: string, input: Record<string, unknown>): ApprovalText {
  const t = TEMPLATES[tool];
  let action: string;
  let content = '';
  if (t) {
    ({ action, content = '' } = t(input));
  } else {
    // No template yet: name the tool and its values plainly, never a model summary.
    const parts = Object.entries(input)
      .slice(0, 4)
      .map(
        ([k, v]) =>
          `${k.replace(/_/g, ' ')} ${typeof v === 'string' ? said(v, 'text').replace(/^text saying: /, '') : JSON.stringify(v)}`,
      );
    action = `use ${tool.replace(/_/g, ' ')} with ${parts.join(', ') || 'no details'}`;
  }
  const sentence = `I'm about to ${action}.`;
  return { sentence, fullText: content ? `${sentence}\n\n${content}` : sentence };
}
