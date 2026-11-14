/**
 * Cheap, code-only request categories. Learned routing preferences are stored per
 * kind ("use Opus for coding"), so this must be fast and predictable, not perfect.
 */

export const REQUEST_KINDS = [
  'chat',
  'code',
  'github',
  'jira',
  'slack',
  'email',
  'calendar',
  'web',
  'files',
  'system',
  'math',
  'writing',
  'planning',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** First match wins, so specific services come before generic verbs like "write". */
const RULES: [Exclude<RequestKind, 'chat'>, RegExp][] = [
  ['github', /\b(github|pull requests?|prs?|repos?|repository|commits?|branch(es)?|merge)\b/],
  ['jira', /\b(jira|tickets?|sprints?|backlog|epics?|story points?)\b/],
  ['slack', /\b(slack|channels?|dms?|direct messages?)\b/],
  ['email', /\b(e-?mails?|mail|inbox|gmail|outlook)\b/],
  ['calendar', /\b(calendar|meetings?|appointments?|events?|invites?|schedule)\b/],
  [
    'code',
    /\b(code|coding|bugs?|debug\w*|functions?|compile\w*|stack trace|typescript|python|javascript|refactor\w*|unit tests?|programming|scripts?|regex)\b/,
  ],
  ['files', /\b(files?|folders?|documents?|pdfs?|downloads?)\b/],
  [
    'system',
    /\b(volume|brightness|open|launch|close|apps?|application|window|wi-?fi|bluetooth|screenshot|clipboard|mute|unmute)\b/,
  ],
  ['web', /\b(search|google|look up|websites?|web ?pages?|news|browse|online|weather)\b/],
  [
    'planning',
    /\b(plan|planning|strategy|architecture|design|roadmap|research|compare|analy[sz]e|analysis|trade-?offs?)\b/,
  ],
  [
    'writing',
    /\b(write|draft|rewrite|rephrase|summari[sz]e|summary|translate|proofread|essay|letter)\b/,
  ],
  ['math', /\b(calculate|plus|minus|times|divided|percent|square root)\b|\d+\s*[-+*/x]\s*\d+/],
];

export function classifyKind(text: string): RequestKind {
  const lower = text.toLowerCase();
  for (const [kind, re] of RULES) if (re.test(lower)) return kind;
  return 'chat';
}

/**
 * Maps a phrase the user said about a kind ("code questions", "small talk") to a
 * kind, or undefined when it is not clear.
 */
export function kindFromPhrase(phrase: string): RequestKind | undefined {
  const kind = classifyKind(phrase);
  if (kind !== 'chat') return kind;
  return /\b(chat|small talk|talk|conversation|general|questions?|anything)\b/i.test(phrase)
    ? 'chat'
    : undefined;
}

/** How Jarvis says the kind out loud. */
export const KIND_LABEL: Record<RequestKind, string> = {
  chat: 'general chat',
  code: 'coding',
  github: 'GitHub',
  jira: 'Jira',
  slack: 'Slack',
  email: 'email',
  calendar: 'calendar',
  web: 'web search',
  files: 'file',
  system: 'Windows control',
  math: 'math',
  writing: 'writing',
  planning: 'planning and research',
};
