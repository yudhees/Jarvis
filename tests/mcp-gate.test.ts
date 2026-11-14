import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, describe, it } from 'node:test';
import {
  cliToolPrefix,
  jarvisToolName,
  PERMIT_SCRIPT,
  PERMIT_TOOL,
  PermitServer,
} from '@jarvis/core/agent';
import { loadConfig } from '@jarvis/core/config';
import { type ApprovalOutcome, type ApprovalRequest, Gate, GatedTools } from '@jarvis/core/guard';
import { ClaudeCliReplyModel, lockdownProblem } from '@jarvis/core/voice';
import type { RiskTier } from '@jarvis/shared';

const SERVERS = { atlassian: 'plugin:engineering:atlassian' };
const CLI = 'mcp__plugin_engineering_atlassian__';

describe('MCP tool names', () => {
  it('maps the CLI name of a signed-in plugin server to the permissions.yaml name', () => {
    assert.equal(cliToolPrefix('plugin:engineering:atlassian'), CLI);
    assert.equal(jarvisToolName(`${CLI}getJiraIssue`, SERVERS), 'mcp__atlassian__getJiraIssue');
    assert.equal(jarvisToolName('mcp__evil__getJiraIssue', SERVERS), undefined);
    assert.equal(jarvisToolName('Bash', SERVERS), undefined);
    assert.equal(jarvisToolName(CLI, SERVERS), undefined);
  });
});

const tiers: Record<string, RiskTier> = {
  mcp__atlassian__getJiraIssue: 0,
  mcp__atlassian__transitionJiraIssue: 2,
  mcp__atlassian__deleteEverything: 4,
};

function gated(answers: ApprovalOutcome[], dryRun = false) {
  const asked: ApprovalRequest[] = [];
  const g = new GatedTools({
    gate: new Gate({ tiers, maxIdenticalCalls: 3 }),
    approver: {
      ask: async (r) => {
        asked.push(r);
        return { outcome: answers.shift() ?? 'cancel', heard: 'x' };
      },
    },
    dryRun,
  });
  return { g, asked };
}

describe('GatedTools.permit (tools the Claude CLI runs)', () => {
  it('a read is allowed unasked and marks the task as having read outside content', async () => {
    const { g, asked } = gated([]);
    assert.deepEqual(await g.permit('mcp__atlassian__getJiraIssue', { issueIdOrKey: 'A-1' }), {
      allow: true,
    });
    assert.equal(asked.length, 0);
    assert.equal(g.task.readUntrusted, true);
  });

  it('a change is allowed only after spoken approval, with the sentence from the real input', async () => {
    const { g, asked } = gated(['approve']);
    const input = { cloudId: 'c', issueIdOrKey: 'PROJ-142', transition: { id: '31' } };
    assert.deepEqual(await g.permit('mcp__atlassian__transitionJiraIssue', input), {
      allow: true,
    });
    assert.match(asked[0]?.sentence ?? '', /PROJ-142.*transition 31/);
  });

  it('cancel, timeout, forbidden, unlisted-then-cancel and dry run are all denied', async () => {
    for (const outcome of ['cancel', 'timeout'] as const) {
      const r = await gated([outcome]).g.permit('mcp__atlassian__transitionJiraIssue', {});
      assert.equal(r.allow, false, outcome);
    }
    const forbidden = gated([]);
    assert.equal((await forbidden.g.permit('mcp__atlassian__deleteEverything', {})).allow, false);
    assert.equal(forbidden.asked.length, 0);
    const unlisted = gated(['cancel']);
    assert.equal((await unlisted.g.permit('mcp__atlassian__somethingNew', {})).allow, false);
    assert.equal(unlisted.asked[0]?.tier, 2, 'unlisted is tier 2');
    const dry = gated(['approve'], true);
    const r = await dry.g.permit('mcp__atlassian__transitionJiraIssue', {});
    assert.ok(!r.allow && /Dry run/.test(r.message));
  });

  it('secret paths in an MCP call are hard-blocked', async () => {
    const { g, asked } = gated(['approve']);
    const r = await g.permit('mcp__atlassian__getJiraIssue', { path: 'C:/Users/me/.ssh/id_rsa' });
    assert.equal(r.allow, false);
    assert.equal(asked.length, 0);
  });
});

describe('the permit server', () => {
  const calls: string[] = [];
  const server = new PermitServer(SERVERS, async (tool) => {
    calls.push(tool);
    return tool.endsWith('getJiraIssue') ? { allow: true } : { allow: false, message: 'no' };
  });
  after(() => server.close());

  it('answers allow with the exact input, and deny for anything unknown', async () => {
    const input = { issueIdOrKey: 'A-1' };
    assert.deepEqual(
      await server.decide(JSON.stringify({ tool_name: `${CLI}getJiraIssue`, input })),
      { behavior: 'allow', updatedInput: input },
    );
    assert.deepEqual(
      await server.decide(JSON.stringify({ tool_name: `${CLI}editJiraIssue`, input })),
      { behavior: 'deny', message: 'no' },
    );
    for (const bad of [
      'not json',
      JSON.stringify({ tool_name: 'Bash', input: {} }),
      JSON.stringify({ tool_name: `${CLI}getJiraIssue`, input: [] }),
    ]) {
      assert.equal((await server.decide(bad)).behavior, 'deny', bad);
    }
    assert.deepEqual(calls, ['mcp__atlassian__getJiraIssue', 'mcp__atlassian__editJiraIssue']);
  });

  it('needs the token and refuses web pages', async () => {
    await server.start();
    const body = JSON.stringify({ tool_name: `${CLI}getJiraIssue`, input: {} });
    const ok = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}` },
      body,
    });
    assert.equal(((await ok.json()) as { behavior: string }).behavior, 'allow');
    assert.equal((await fetch(server.url, { method: 'POST', body })).status, 401);
    const page = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, origin: 'https://evil.example' },
      body,
    });
    assert.equal(page.status, 404);
  });

  it('the permission tool the CLI starts asks core, and denies when core is unreachable', async () => {
    await server.start();
    const run = async (env: Record<string, string>, toolName: string) => {
      const p = spawn(process.execPath, [PERMIT_SCRIPT], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const lines = createInterface({ input: p.stdout });
      const answers: Record<string, unknown>[] = [];
      const done = new Promise<void>((resolve) =>
        lines.on('line', (l) => {
          answers.push(JSON.parse(l));
          if (answers.length === 3) resolve();
        }),
      );
      const send = (o: unknown) => p.stdin.write(`${JSON.stringify(o)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'permit', arguments: { tool_name: toolName, input: { a: 1 } } },
      });
      await done;
      p.stdin.end();
      const call = answers.find((a) => a.id === 3) as {
        result: { content: { text: string }[] };
      };
      return JSON.parse(call.result.content[0]?.text ?? '{}');
    };
    assert.deepEqual(await run(server.env, `${CLI}getJiraIssue`), {
      behavior: 'allow',
      updatedInput: { a: 1 },
    });
    assert.equal((await run(server.env, `${CLI}editJiraIssue`)).behavior, 'deny');
    const unreachable = await run(
      { JARVIS_PERMIT_URL: 'http://127.0.0.1:9/permit', JARVIS_PERMIT_TOKEN: 'x' },
      `${CLI}getJiraIssue`,
    );
    assert.equal(unreachable.behavior, 'deny');
  });
});

describe('the Claude CLI with MCP servers (CLAUDE.md 4)', () => {
  const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-'));
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const mcp = () => ({
    servers: {
      'plugin:engineering:atlassian': { type: 'http' as const, url: 'https://x.test/mcp' },
    },
    env: { JARVIS_PERMIT_URL: 'http://127.0.0.1:1/permit', JARVIS_PERMIT_TOKEN: 't' },
    hidden: [] as string[],
  });
  const model = (m = mcp()) =>
    new ClaudeCliReplyModel({
      exe: process.execPath,
      prefixArgs: [FAKE],
      workDir: path.join(dir, 'cli'),
      idleStopMs: 60_000,
      mcp: m,
    });
  const ask = async (m: ClaudeCliReplyModel, content: string) => {
    let text = '';
    const usage = await m.stream(
      {
        model: 'claude-haiku-5-5',
        system: 'You are Jarvis.',
        context: '',
        messages: [{ role: 'user', content }],
        maxTokens: 100,
      },
      (d) => {
        text += d;
      },
    );
    return { text, usage };
  };

  it('gives the CLI only the named servers, every call through the permission tool', async () => {
    const m = model();
    try {
      const seen = JSON.parse((await ask(m, 'REPORT')).text);
      assert.equal(seen.tools, '', 'still no built-in tools');
      assert.equal(seen.permissionTool, PERMIT_TOOL);
      assert.equal(seen.permissionMode, 'default');
      assert.deepEqual(seen.servers, ['plugin:engineering:atlassian', 'jarvis']);
      for (const t of [PERMIT_TOOL, 'ListMcpResourcesTool', 'ReadMcpResourceTool']) {
        assert.ok(seen.disallowed.includes(t), t);
      }
      assert.equal(seen.permitUrl, 'http://127.0.0.1:1/permit');
      assert.equal(seen.claudeAi, 'false', 'no claude.ai connectors');
    } finally {
      await m.close();
    }
  });

  it('a reply with a tool call in the middle is one answer, not cut at the tool', async () => {
    const m = model();
    try {
      const r = await ask(m, 'my ticket count');
      assert.equal(r.text, 'Let me check. You have 3 tickets.');
      assert.equal(r.usage.inputTokens, 14);
      assert.equal(r.usage.outputTokens, 6);
    } finally {
      await m.close();
    }
  });

  it('the self-test passes with the server tools, and unlisted tools can be hidden', async () => {
    process.env.FAKE_CLI_TOOLS = `${CLI}getJiraIssue,${CLI}brandNewTool`;
    const m = mcp();
    try {
      const init = await model(m).selfTest('claude-haiku-5-5', 5000);
      assert.equal(init.tools, 2);
      model(m).hideTools([`${CLI}brandNewTool`]);
      const after = await model(m).selfTest('claude-haiku-5-5', 5000);
      assert.deepEqual(after.toolNames, [`${CLI}getJiraIssue`]);
    } finally {
      delete process.env.FAKE_CLI_TOOLS;
    }
  });

  it('refuses built-in tools, tools of other servers, and servers it was not given', async () => {
    const m = mcp();
    const init = (toolNames: string[], servers: string[]) => ({
      tools: toolNames.length,
      mcpServers: servers.length,
      toolNames,
      servers: servers.map((name) => ({ name, status: 'connected' })),
    });
    const ok = ['plugin:engineering:atlassian', 'jarvis'];
    assert.equal(lockdownProblem(init([`${CLI}getJiraIssue`], ok), m), undefined);
    assert.match(lockdownProblem(init(['Bash'], ok), m) ?? '', /Lockdown failed/);
    assert.match(lockdownProblem(init(['mcp__github__push'], ok), m) ?? '', /Lockdown failed/);
    assert.match(lockdownProblem(init([], [...ok, 'github']), m) ?? '', /Lockdown failed/);
    // Without MCP, not even the permission server may appear.
    assert.match(lockdownProblem(init([], ['jarvis']), undefined) ?? '', /Lockdown failed/);
    process.env.FAKE_CLI_SERVERS = 'claude.ai Slack';
    try {
      await assert.rejects(model(m).selfTest('claude-haiku-5-5', 5000), /Lockdown failed/);
    } finally {
      delete process.env.FAKE_CLI_SERVERS;
    }
  });

  it('mcp.yaml uses the Claude Code sign-in name, and every Atlassian tool has a tier', () => {
    const { mcp: servers, permissions } = loadConfig();
    const atlassian = servers.servers.atlassian;
    assert.ok(atlassian?.type === 'http' && atlassian.signInAs === 'plugin:engineering:atlassian');
    const t = permissions.tools;
    assert.equal(t.mcp__atlassian__searchJiraIssuesUsingJql, 0);
    assert.equal(t.mcp__atlassian__transitionJiraIssue, 2);
    assert.equal(t.mcp__atlassian__createConfluenceInlineComment, 2);
  });
});
