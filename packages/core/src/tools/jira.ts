import { type JarvisTool, optionalString, requireString, ToolInputError } from './types.ts';

/**
 * Jira Cloud over its REST API with an API token (email + token, Basic auth).
 * Chosen over the Atlassian MCP server because that needs an interactive OAuth
 * sign-in that a headless Jarvis cannot do. Tiers live in permissions.yaml:
 * reading is 0, changing anything is 2 (CLAUDE.md 13.2).
 */
export interface JiraOptions {
  /** https://yourcompany.atlassian.net */
  site: string;
  email: string;
  token: string;
  fetch?: typeof fetch;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;

function issueKey(input: Record<string, unknown>): string {
  const key = requireString(input, 'issue', 32).toUpperCase().replace(/\s+/g, '-');
  if (!ISSUE_KEY.test(key))
    throw new ToolInputError(`"${key}" is not a Jira issue key like PROJ-142.`);
  return key;
}

/** Jira's document format, for comments and descriptions. */
function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
  };
}

/** Plain text out of Jira's document format. */
function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfText).join(n.type === 'doc' ? '\n' : '');
  return n.type === 'paragraph' ? `${inner}\n` : inner;
}

interface IssueFields {
  summary?: string;
  status?: { name?: string };
  assignee?: { displayName?: string } | null;
  priority?: { name?: string } | null;
  issuetype?: { name?: string };
  updated?: string;
  description?: unknown;
}

function line(key: string, f: IssueFields): string {
  const who = f.assignee?.displayName ?? 'unassigned';
  return `${key} [${f.status?.name ?? '?'}] ${f.summary ?? ''} (${who})`;
}

export class JiraClient {
  readonly #o: JiraOptions;
  readonly #auth: string;

  constructor(options: JiraOptions) {
    const site = options.site.replace(/\/+$/, '');
    if (!/^https:\/\/[\w.-]+\.atlassian\.net$/.test(site)) {
      throw new Error('jira.site must look like https://yourcompany.atlassian.net');
    }
    this.#o = { ...options, site };
    this.#auth = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await (this.#o.fetch ?? fetch)(`${this.#o.site}${path}`, {
      method,
      headers: {
        Authorization: this.#auth,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
        detail =
          [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join('; ') || detail;
      } catch {
        // not JSON
      }
      if (res.status === 401)
        throw new Error(
          'Jira refused the sign-in. Check jira.email and the API token (npm run set-key -- jira).',
        );
      throw new Error(`Jira answered ${res.status}: ${detail}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /** Who the token belongs to (sign-in check). */
  async me(): Promise<string> {
    const me = (await this.request('GET', '/rest/api/3/myself')) as { displayName?: string };
    return me.displayName ?? 'unknown';
  }

  async search(jql: string): Promise<string> {
    const r = (await this.request('POST', '/rest/api/3/search/jql', {
      jql,
      maxResults: MAX_RESULTS,
      fields: ['summary', 'status', 'assignee', 'priority', 'updated'],
    })) as { issues?: { key: string; fields: IssueFields }[] };
    const issues = r.issues ?? [];
    if (issues.length === 0) return 'No matching issues.';
    return issues.map((i) => line(i.key, i.fields)).join('\n');
  }

  async get(key: string): Promise<string> {
    const i = (await this.request(
      'GET',
      `/rest/api/3/issue/${key}?fields=summary,status,assignee,priority,issuetype,description,updated`,
    )) as { key: string; fields: IssueFields };
    const f = i.fields;
    const desc = adfText(f.description).trim().slice(0, 1500);
    return [
      line(i.key, f),
      `Type: ${f.issuetype?.name ?? '?'}. Priority: ${f.priority?.name ?? 'none'}.`,
      desc ? `Description: ${desc}` : 'No description.',
    ].join('\n');
  }

  async transitions(key: string): Promise<{ id: string; name: string; to: string }[]> {
    const r = (await this.request('GET', `/rest/api/3/issue/${key}/transitions`)) as {
      transitions?: { id: string; name: string; to?: { name?: string } }[];
    };
    return (r.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? t.name }));
  }

  async transition(key: string, status: string): Promise<string> {
    const want = status.trim().toLowerCase();
    const options = await this.transitions(key);
    const match =
      options.find((t) => t.to.toLowerCase() === want || t.name.toLowerCase() === want) ??
      options.find((t) => t.to.toLowerCase().includes(want) || t.name.toLowerCase().includes(want));
    if (!match) {
      return `${key} cannot move to "${status}". It can move to: ${options.map((t) => t.to).join(', ') || 'nothing'}.`;
    }
    await this.request('POST', `/rest/api/3/issue/${key}/transitions`, {
      transition: { id: match.id },
    });
    return `Moved ${key} to ${match.to}.`;
  }

  async comment(key: string, body: string): Promise<string> {
    await this.request('POST', `/rest/api/3/issue/${key}/comment`, { body: adf(body) });
    return `Comment added to ${key}.`;
  }

  async create(
    project: string,
    summary: string,
    type: string,
    description?: string,
  ): Promise<string> {
    const r = (await this.request('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: project },
        summary,
        issuetype: { name: type },
        ...(description ? { description: adf(description) } : {}),
      },
    })) as { key?: string };
    return `Created ${r.key ?? 'the issue'} in ${project}.`;
  }
}

/** The Jira tools offered to the model. Results are outside content (untrusted). */
export function jiraTools(client: JiraClient): JarvisTool[] {
  return [
    {
      name: 'jira_search',
      description:
        'Search Jira issues with JQL, e.g. assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC, or text ~ "login timeout". Returns up to 10 issues.',
      inputSchema: {
        type: 'object',
        properties: { jql: { type: 'string', description: 'A JQL query' } },
        required: ['jql'],
      },
      untrusted: true,
      run: async (input) => client.search(requireString(input, 'jql', 1000)),
    },
    {
      name: 'jira_get',
      description: 'Read one Jira issue: status, assignee, priority, type and description.',
      inputSchema: {
        type: 'object',
        properties: { issue: { type: 'string', description: 'Issue key like PROJ-142' } },
        required: ['issue'],
      },
      untrusted: true,
      run: async (input) => client.get(issueKey(input)),
    },
    {
      name: 'jira_transitions',
      description: 'List the statuses a Jira issue can move to next.',
      inputSchema: {
        type: 'object',
        properties: { issue: { type: 'string' } },
        required: ['issue'],
      },
      untrusted: true,
      run: async (input) => {
        const key = issueKey(input);
        const t = await client.transitions(key);
        return t.length
          ? `${key} can move to: ${t.map((x) => x.to).join(', ')}.`
          : `${key} has no transitions.`;
      },
    },
    {
      name: 'jira_transition',
      description:
        'Move a Jira issue to another status ("move PROJ-142 to In Review"). Needs the user\'s spoken approval.',
      inputSchema: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          status: { type: 'string', description: 'Target status, e.g. In Review' },
        },
        required: ['issue', 'status'],
      },
      run: async (input) => client.transition(issueKey(input), requireString(input, 'status', 100)),
    },
    {
      name: 'jira_comment',
      description: "Add a comment to a Jira issue. Needs the user's spoken approval.",
      inputSchema: {
        type: 'object',
        properties: { issue: { type: 'string' }, body: { type: 'string' } },
        required: ['issue', 'body'],
      },
      run: async (input) => client.comment(issueKey(input), requireString(input, 'body', 5000)),
    },
    {
      name: 'jira_create',
      description:
        "Create a Jira issue. type is Task unless the user says Bug or Story. Needs the user's spoken approval.",
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project key like PROJ' },
          summary: { type: 'string' },
          type: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['project', 'summary'],
      },
      run: async (input) => {
        const project = requireString(input, 'project', 10).toUpperCase();
        if (!PROJECT_KEY.test(project))
          throw new ToolInputError(`"${project}" is not a project key.`);
        return client.create(
          project,
          requireString(input, 'summary', 250),
          optionalString(input, 'type', 40) ?? 'Task',
          optionalString(input, 'description', 5000),
        );
      },
    },
  ];
}
