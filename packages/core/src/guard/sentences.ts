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

/** Inputs that say nothing to a listener. */
const NOISE = new Set(['cloudId', 'contentFormat', 'responseContentFormat', 'actionSource']);

/** "mcp__atlassian__createJiraIssue" -> "create Jira issue". */
function spokenTool(tool: string): string {
  return tool
    .replace(/^mcp__.+?__/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/\bjira\b/g, 'Jira');
}

type Template = (i: Record<string, unknown>) => { action: string; content?: string };

const TEMPLATES: Record<string, Template> = {
  // Jira through the Atlassian MCP server (tool names as in permissions.yaml).
  mcp__atlassian__transitionJiraIssue: (i) => {
    const id = (i.transition as { id?: unknown } | undefined)?.id;
    return {
      action: `change the status of ${str(i.issueIdOrKey)} (Jira transition ${str(id, 'unknown')})`,
    };
  },
  mcp__atlassian__addCommentToJiraIssue: (i) => {
    const body = str(i.commentBody, '');
    const verb = i.commentId ? 'replace a comment on' : 'add to';
    return { action: `${verb} ${str(i.issueIdOrKey)} a ${said(body, 'comment')}`, content: body };
  },
  mcp__atlassian__createJiraIssue: (i) => {
    const desc = typeof i.description === 'string' ? i.description : '';
    return {
      action: `create a ${str(i.issueTypeName, 'task').toLowerCase()} in ${str(i.projectKey)} titled: ${str(i.summary)}`,
      content: desc,
    };
  },
  mcp__atlassian__editJiraIssue: (i) => {
    const fields = i.fields && typeof i.fields === 'object' ? Object.keys(i.fields) : [];
    return {
      action: `change ${fields.join(', ').replace(/_/g, ' ') || 'fields'} on ${str(i.issueIdOrKey)}`,
      content: JSON.stringify(i.fields ?? {}, null, 2),
    };
  },
  mcp__atlassian__addWorklogToJiraIssue: (i) => ({
    action: `log ${str(i.timeSpent)} of work on ${str(i.issueIdOrKey)}`,
  }),
  mcp__atlassian__createIssueLink: (i) => ({
    action: `link ${str(i.inwardIssue)} and ${str(i.outwardIssue)} as ${str(i.type)}`,
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
      .filter(([k]) => !NOISE.has(k))
      .slice(0, 4)
      .map(
        ([k, v]) =>
          `${k.replace(/_/g, ' ')} ${typeof v === 'string' ? said(v, 'text').replace(/^text saying: /, '') : JSON.stringify(v)}`,
      );
    action = `use ${spokenTool(tool)} with ${parts.join(', ') || 'no details'}`;
  }
  const sentence = `I'm about to ${action}.`;
  return { sentence, fullText: content ? `${sentence}\n\n${content}` : sentence };
}
