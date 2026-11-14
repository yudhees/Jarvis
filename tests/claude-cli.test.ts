import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LocalMemoryFiles } from '@jarvis/core/memory';
import { ClaudeCliReplyModel, type LocalTool, type ModelRequest } from '@jarvis/core/voice';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-cli-'));
// Stopped CLI processes can hold the folder for a moment on Windows.
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

function model(idleStopMs = 60_000) {
  return new ClaudeCliReplyModel({
    exe: process.execPath,
    prefixArgs: [FAKE],
    workDir: path.join(dir, 'cli'),
    idleStopMs,
  });
}

const req = (
  messages: ModelRequest['messages'],
  extra: Partial<ModelRequest> = {},
): ModelRequest => ({
  model: 'claude-haiku-5-5',
  system: 'You are Jarvis.',
  context: 'It is now noon.',
  messages,
  maxTokens: 100,
  ...extra,
});

async function run(m: ClaudeCliReplyModel, r: ModelRequest) {
  let text = '';
  const usage = await m.stream(r, (d) => {
    text += d;
  });
  return { text, usage };
}

describe('ClaudeCliReplyModel', () => {
  it('starts the CLI locked down: no tools, no settings, no MCP, no API key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-pass-through';
    const m = model();
    try {
      const { text } = await run(m, req([{ role: 'user', content: 'REPORT' }]));
      const seen = JSON.parse(text);
      assert.equal(seen.tools, '', 'built-in tools off');
      assert.equal(seen.settingSources, '', 'no user or project settings');
      assert.equal(seen.strictMcp, true);
      assert.equal(seen.noSlash, true);
      assert.equal(seen.model, 'claude-haiku-5-5');
      assert.equal(seen.apiKey, null, 'subscription only: API key removed from its environment');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      await m.close();
    }
  });

  it('keeps one process for the conversation and only sends the new message', async () => {
    const m = model();
    try {
      const first = await run(m, req([{ role: 'user', content: 'hi' }]));
      assert.equal(first.text, 'Reply 1.');
      assert.equal(first.usage.inputTokens, 7);
      const second = await run(
        m,
        req([
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Reply 1.' },
          { role: 'user', content: 'REPORT' },
        ]),
      );
      assert.equal(JSON.parse(second.text).turn, 2, 'same process, second turn');
      // A new conversation (history does not match) starts a fresh process.
      const fresh = await run(m, req([{ role: 'user', content: 'REPORT' }]));
      assert.equal(JSON.parse(fresh.text).turn, 1);
    } finally {
      await m.close();
    }
  });

  it('runs lookups the model asks for and never passes the marker on', async () => {
    const m = model();
    const searched: string[] = [];
    const tool: LocalTool = {
      name: 'memory_search',
      description: 'search notes',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      run: (input) => {
        searched.push(String(input.query));
        return '- Priya is the design lead';
      },
    };
    try {
      const r = await run(m, req([{ role: 'user', content: 'who is priya' }], { tools: [tool] }));
      assert.deepEqual(searched, ['Priya']);
      assert.equal(r.text, 'Found it: Priya is the design lead.');
      assert.equal(r.usage.toolCalls, 1);
    } finally {
      await m.close();
    }
  });

  it('stopping kills the process at once; the next request starts a new one', async () => {
    const m = model();
    try {
      const controller = new AbortController();
      const pending = run(
        m,
        req([{ role: 'user', content: 'slow' }], { signal: controller.signal }),
      );
      setTimeout(() => controller.abort(), 100);
      const t0 = performance.now();
      await assert.rejects(pending);
      assert.ok(performance.now() - t0 < 2000);
      const next = await run(m, req([{ role: 'user', content: 'REPORT' }]));
      assert.equal(JSON.parse(next.text).turn, 1);
    } finally {
      await m.close();
    }
  });

  it('reports CLI errors such as not being signed in', async () => {
    const m = model();
    try {
      await assert.rejects(run(m, req([{ role: 'user', content: 'error' }])), /not logged in/);
    } finally {
      await m.close();
    }
  });
});

describe('LocalMemoryFiles', () => {
  it('keeps memory in one file across restarts', async () => {
    const file = path.join(dir, 'memory.json');
    const a = new LocalMemoryFiles(file);
    const created = await a.create('/notes/priya.md', 'Priya is the design lead');
    await a.update(created.id, 'Priya leads design');
    const b = new LocalMemoryFiles(file);
    const all = await b.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.content, 'Priya leads design');
    await b.delete(created.id);
    assert.equal((await new LocalMemoryFiles(file).listAll()).length, 0);
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
  });
});

describe('startup self-test (CLAUDE.md 4)', () => {
  it('passes when the CLI sees no tools and no MCP servers', async () => {
    assert.deepEqual(await model().selfTest('claude-haiku-5-5', 5000), { tools: 0, mcpServers: 0 });
  });

  it('refuses when the CLI can see any tool', async () => {
    process.env.FAKE_CLI_TOOLS = 'Bash,Read';
    try {
      await assert.rejects(
        model().selfTest('claude-haiku-5-5', 5000),
        /Lockdown failed: .* 2 tools/,
      );
    } finally {
      delete process.env.FAKE_CLI_TOOLS;
    }
  });

  it('a session that reports tools is shut down before answering', async () => {
    process.env.FAKE_CLI_TOOLS = 'Bash';
    const m = model();
    try {
      await assert.rejects(
        m.stream(req([{ role: 'user', content: 'hi' }]), () => {}),
        /Lockdown failed/,
      );
    } finally {
      delete process.env.FAKE_CLI_TOOLS;
      await m.close();
    }
  });
});
