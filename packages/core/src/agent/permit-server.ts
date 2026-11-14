import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/** The stdio MCP server the Claude CLI starts as its permission prompt tool. */
export const PERMIT_SCRIPT = path.join(import.meta.dirname, 'permit-mcp.mjs');
/** How the CLI names it: --permission-prompt-tool mcp__jarvis__permit. */
export const PERMIT_SERVER = 'jarvis';
export const PERMIT_TOOL = `mcp__${PERMIT_SERVER}__permit`;

/** The answer format the Claude CLI expects from a permission prompt tool. */
export type PermitAnswer =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** How the Claude CLI names a server's tools: mcp__<name, other characters as _>__<tool>. */
export function cliToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
}

/**
 * Maps the CLI's tool name to Jarvis's (the one in permissions.yaml):
 * mcp__plugin_engineering_atlassian__getJiraIssue -> mcp__atlassian__getJiraIssue.
 * `servers` is Jarvis name -> the name the CLI was given. Unknown tools: undefined.
 */
export function jarvisToolName(
  cliName: string,
  servers: Readonly<Record<string, string>>,
): string | undefined {
  for (const [name, cliServer] of Object.entries(servers)) {
    const prefix = cliToolPrefix(cliServer);
    if (cliName.startsWith(prefix) && cliName.length > prefix.length) {
      return `mcp__${name}__${cliName.slice(prefix.length)}`;
    }
  }
  return undefined;
}

export type PermitHandler = (
  tool: string,
  input: Record<string, unknown>,
) => Promise<{ allow: true } | { allow: false; message: string }>;

/**
 * A small HTTP endpoint on 127.0.0.1 that the permission tool calls. A random
 * token is required; web pages (an Origin header) are refused. Anything
 * unexpected is a deny: the CLI never runs a tool unless Jarvis says allow.
 */
export class PermitServer {
  readonly token = randomBytes(24).toString('hex');
  readonly #servers: Readonly<Record<string, string>>;
  readonly #handle: PermitHandler;
  #server: Server | undefined;
  #url = '';

  constructor(servers: Readonly<Record<string, string>>, handle: PermitHandler) {
    this.#servers = servers;
    this.#handle = handle;
  }

  get url(): string {
    return this.#url;
  }

  /** Environment for the CLI; the permission tool inherits it. */
  get env(): Record<string, string> {
    return { JARVIS_PERMIT_URL: this.#url, JARVIS_PERMIT_TOKEN: this.token };
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      const reply = (answer: PermitAnswer) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      };
      if (req.method !== 'POST' || req.url !== '/permit' || req.headers.origin) {
        res.writeHead(404).end();
        return;
      }
      if (!this.#authorized(req.headers.authorization)) {
        res.writeHead(401).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        this.decide(body).then(reply, () =>
          reply({ behavior: 'deny', message: 'The safety check failed, so it was not done.' }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.#server = server;
    this.#url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/permit`;
  }

  /** One request from the permission tool (exposed for tests). */
  async decide(body: string): Promise<PermitAnswer> {
    let call: { tool_name?: unknown; input?: unknown };
    try {
      call = JSON.parse(body);
    } catch {
      return { behavior: 'deny', message: 'Unreadable request.' };
    }
    const input =
      call.input && typeof call.input === 'object' && !Array.isArray(call.input)
        ? (call.input as Record<string, unknown>)
        : undefined;
    if (typeof call.tool_name !== 'string' || !input) {
      return { behavior: 'deny', message: 'Unreadable request.' };
    }
    const tool = jarvisToolName(call.tool_name, this.#servers);
    if (!tool) {
      return { behavior: 'deny', message: `${call.tool_name} is not a tool Jarvis allows.` };
    }
    const answer = await this.#handle(tool, input);
    // The exact input that was checked (and read aloud) is the one that runs.
    return answer.allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: answer.message };
  }

  async close(): Promise<void> {
    const s = this.#server;
    this.#server = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  #authorized(header: string | undefined): boolean {
    const want = Buffer.from(`Bearer ${this.token}`);
    const got = Buffer.from(header ?? '');
    return got.length === want.length && timingSafeEqual(got, want);
  }
}
