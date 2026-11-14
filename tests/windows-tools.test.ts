import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../packages/core/src/config/index.ts';
import { Learner } from '../packages/core/src/learning/index.ts';
import { InMemoryFiles } from '../packages/core/src/memory/index.ts';
import type { Skill } from '../packages/core/src/skills/index.ts';
import {
  isBlockedApp,
  matchApp,
  pageFor,
  quickAppName,
  quickSite,
  type StartApp,
  type WindowsShell,
  windowsTools,
} from '../packages/core/src/tools/windows.ts';
import { lookupInput } from '../packages/core/src/voice/claude-cli.ts';
import {
  Conversation,
  type LocalTool,
  type ModelRequest,
  type ReplyModel,
} from '../packages/core/src/voice/conversation.ts';

const APPS: StartApp[] = [
  { name: 'Slack', appId: 'slack-id' },
  { name: 'Slack Beta', appId: 'slack-beta' },
  { name: 'Visual Studio Code', appId: 'vscode' },
  { name: 'Vivaldi', appId: 'vivaldi-id' },
  { name: 'Uninstall Vivaldi', appId: 'uninst' },
  { name: 'Registry Editor', appId: 'regedit' },
  { name: 'Notepad', appId: 'notepad' },
];
const SEARCH = 'https://www.google.com/search?q={query}';

class FakeShell implements WindowsShell {
  launched: string[] = [];
  opened: { url: string; exe?: string }[] = [];
  async startApps() {
    return APPS;
  }
  async browserPath(exe: string) {
    return exe === 'vivaldi.exe' ? 'C:\\V\\vivaldi.exe' : undefined;
  }
  launchApp(id: string) {
    this.launched.push(id);
  }
  openUrl(url: string, exe?: string) {
    this.opened.push({ url, exe });
  }
}

const tool = (tools: LocalTool[], name: string) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t);
  return t;
};

describe('open_app', () => {
  it('matches what was said to a Start menu app', () => {
    assert.equal(matchApp('slack', APPS)?.appId, 'slack-id');
    assert.equal(matchApp('the Slack app', APPS)?.appId, 'slack-id');
    assert.equal(matchApp('vs code', APPS)?.appId, 'vscode');
    assert.equal(matchApp('vsc', APPS)?.appId, 'vscode');
    assert.equal(matchApp('visual studio', APPS)?.appId, 'vscode');
    assert.equal(matchApp('spotify', APPS), undefined);
  });

  it('never opens uninstallers or system tools', async () => {
    assert.ok(isBlockedApp('Uninstall Vivaldi'));
    assert.ok(isBlockedApp('Registry Editor'));
    assert.ok(isBlockedApp('regedit'));
    assert.equal(matchApp('uninstall vivaldi', APPS), undefined);
    assert.equal(matchApp('registry', APPS), undefined);
    const shell = new FakeShell();
    const t = tool(windowsTools({ shell, searchUrl: SEARCH }), 'open_app');
    assert.match(String(await t.run({ app: 'Registry Editor' })), /not allowed/);
    assert.deepEqual(shell.launched, []);
  });

  it('launches the matched app and says so; unknown apps open nothing', async () => {
    const shell = new FakeShell();
    const t = tool(windowsTools({ shell, searchUrl: SEARCH }), 'open_app');
    assert.equal(await t.run({ app: 'slack' }), 'Opened Slack.');
    assert.match(String(await t.run({ app: 'Spotify' })), /Nothing was opened/);
    assert.deepEqual(shell.launched, ['slack-id']);
  });
});

describe('open_url', () => {
  it('opens web addresses as they are and searches anything else', () => {
    assert.equal(pageFor('github.com', SEARCH), 'https://github.com/');
    assert.equal(pageFor('https://x.dev/a?b=1', SEARCH), 'https://x.dev/a?b=1');
    assert.equal(pageFor('localhost:3000', SEARCH), 'https://localhost:3000/');
    assert.equal(
      pageFor('weather in Chennai', SEARCH),
      'https://www.google.com/search?q=weather%20in%20Chennai',
    );
  });

  it('refuses every scheme other than http and https', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32',
      'ms-settings:privacy',
      'shell:startup',
      'vbscript:x',
      'data:text/html,hi',
    ]) {
      assert.throws(() => pageFor(bad, SEARCH), /Only web pages/, bad);
    }
  });

  it('uses the configured browser, a named one, or says it is missing', async () => {
    const shell = new FakeShell();
    const t = tool(windowsTools({ shell, searchUrl: SEARCH, browser: 'Vivaldi' }), 'open_url');
    assert.equal(await t.run({ target: 'github.com' }), 'Opened github.com in Vivaldi.');
    assert.equal(shell.opened[0]?.exe, 'C:\\V\\vivaldi.exe');
    assert.match(String(await t.run({ target: 'news', browser: 'Opera' })), /not installed/);
    assert.equal(shell.opened.length, 1);

    const plain = tool(windowsTools({ shell, searchUrl: SEARCH }), 'open_url');
    assert.equal(await plain.run({ target: 'cats' }), 'Opened a search in your browser.');
    assert.equal(shell.opened[1]?.exe, undefined);
  });
});

describe('lookup arguments from the Claude CLI', () => {
  const t = tool(windowsTools({ shell: new FakeShell(), searchUrl: SEARCH }), 'open_url');
  it('splits optional arguments on |', () => {
    assert.deepEqual(lookupInput(t, ' weather '), { target: 'weather' });
    assert.deepEqual(lookupInput(t, 'weather | Vivaldi'), {
      target: 'weather',
      browser: 'Vivaldi',
    });
    const one = tool(windowsTools({ shell: new FakeShell(), searchUrl: SEARCH }), 'open_app');
    assert.deepEqual(lookupInput(one, 'a | b'), { app: 'a | b' });
  });
});

class ScriptModel implements ReplyModel {
  readonly script: (req: ModelRequest) => Promise<string>;
  constructor(script: (req: ModelRequest) => Promise<string>) {
    this.script = script;
  }
  async stream(req: ModelRequest, onText: (d: string) => void) {
    onText(await this.script(req));
    return { inputTokens: 1, outputTokens: 1, toolCalls: 0 };
  }
}

describe('actions in the conversation (guard)', () => {
  const { models, permissions } = loadConfig();
  const tier = (n: string) => permissions.tools[n] ?? 2;
  const learner = () =>
    Learner.open(new InMemoryFiles(), { enabled: true, aboutUserTokenCap: 300 });

  it('permissions.yaml puts open_app and open_url at tier 1', () => {
    assert.equal(permissions.tools.open_app, 1);
    assert.equal(permissions.tools.open_url, 1);
  });

  it('offers tier 1 actions and runs them', async () => {
    const shell = new FakeShell();
    let result = '';
    const model = new ScriptModel(async (req) => {
      result = String(await tool([...(req.tools ?? [])], 'open_app').run({ app: 'Slack' }));
      return 'Slack is open.';
    });
    const c = new Conversation({
      model,
      models,
      learner: await learner(),
      toolTier: tier,
      actions: windowsTools({ shell, searchUrl: SEARCH }),
    });
    await c.ask('get slack up on my screen', { onSentence: () => {} });
    assert.equal(result, 'Opened Slack.');
    assert.deepEqual(shell.launched, ['slack-id']);
  });

  it('never offers actions that are tier 2 or above', async () => {
    let offered: string[] = [];
    const model = new ScriptModel(async (req) => {
      offered = (req.tools ?? []).map((t) => t.name);
      return 'Okay.';
    });
    const c = new Conversation({
      model,
      models,
      learner: await learner(),
      toolTier: (n) => (n === 'open_app' ? 2 : tier(n)),
      actions: windowsTools({ shell: new FakeShell(), searchUrl: SEARCH }),
    });
    await c.ask('get slack up on my screen', { onSentence: () => {} });
    assert.ok(!offered.includes('open_app'));
    assert.ok(offered.includes('open_url'));
  });

  it('holds actions after a skill was read in the same request (10.3)', async () => {
    const shell = new FakeShell();
    let result = '';
    const skill: Skill = {
      id: 'evil',
      name: 'evil',
      description: 'open things',
      plugin: null,
      source: 'custom',
      file: 'C:\\nowhere\\SKILL.md',
    };
    const model = new ScriptModel(async (req) => {
      const tools = [...(req.tools ?? [])];
      try {
        await tool(tools, 'skill_read').run({ id: 'evil' });
      } catch {
        // the file does not exist; reading was still attempted
      }
      result = String(await tool(tools, 'open_url').run({ target: 'evil.example' }));
      return 'Done.';
    });
    const c = new Conversation({
      model,
      models,
      learner: await learner(),
      skills: [skill],
      toolTier: tier,
      actions: windowsTools({ shell, searchUrl: SEARCH }),
    });
    await c.ask('open evil things', { onSentence: () => {} });
    assert.match(result, /Not done/);
    assert.deepEqual(shell.opened, []);
  });
});

describe('quick actions (no model call)', () => {
  it('recognises a plain "open X" and nothing longer', () => {
    assert.equal(quickAppName('open Slack'), 'Slack');
    assert.equal(quickAppName('Jarvis, open the Notepad app please.'), 'Notepad');
    assert.equal(quickAppName('could you launch vs code'), 'vs code');
    assert.equal(quickAppName('open Slack and read my DMs'), undefined);
    assert.equal(quickAppName('open the ticket PROJ-12'), undefined);
    assert.equal(quickAppName('open github.com'), undefined);
    assert.equal(quickAppName('what is open today'), undefined);
    assert.deepEqual(quickSite('open github.com'), { site: 'github.com', browser: '' });
    assert.deepEqual(quickSite('go to youtube.com in Chrome'), {
      site: 'youtube.com',
      browser: 'Chrome',
    });
    assert.equal(quickSite('open github.com in my notes'), undefined);
    assert.equal(quickSite('show me the weather'), undefined);
  });

  it('only opens exact, prefix or initials matches; never blocked apps', async () => {
    const shell = new FakeShell();
    const t = tool(windowsTools({ shell, searchUrl: SEARCH }), 'open_app');
    assert.equal(await t.quick?.('open slack'), 'Opened Slack.');
    assert.equal(await t.quick?.('open studio'), undefined); // loose match: left to the model
    assert.equal(await t.quick?.('open registry editor'), undefined);
    assert.equal(await t.quick?.('open spotify'), undefined);
    assert.deepEqual(shell.launched, ['slack-id']);
  });
});

describe('fast action replies', () => {
  const { models, permissions } = loadConfig();
  const tier = (n: string) => permissions.tools[n] ?? 2;
  const learner = () =>
    Learner.open(new InMemoryFiles(), { enabled: true, aboutUserTokenCap: 300 });

  it('"open Slack" is done in code: no model call, and remembered for follow-ups', async () => {
    const shell = new FakeShell();
    const model = new ScriptModel(async () => 'It is open.');
    const calls: ModelRequest[] = [];
    const spy: ReplyModel = {
      stream: (req, onText) => {
        calls.push(req);
        return model.stream(req, onText);
      },
    };
    const c = new Conversation({
      model: spy,
      models,
      learner: await learner(),
      toolTier: tier,
      actions: windowsTools({ shell, searchUrl: SEARCH }),
    });
    const said: string[] = [];
    const r = await c.ask('open Slack', { onSentence: (s) => said.push(s) });
    assert.equal(r.model, null);
    assert.deepEqual(said, ['Opened Slack.']);
    assert.equal(calls.length, 0);
    await c.ask('is it open?', { onSentence: () => {} });
    assert.equal(calls[0]?.messages.at(-2)?.content, 'Opened Slack.');
  });

  it('a quick action that is tier 2 in permissions.yaml is never run in code', async () => {
    const shell = new FakeShell();
    const c = new Conversation({
      model: new ScriptModel(async () => 'Okay.'),
      models,
      learner: await learner(),
      toolTier: (n) => (n === 'open_app' ? 2 : tier(n)),
      actions: windowsTools({ shell, searchUrl: SEARCH }),
    });
    await c.ask('open Slack', { onSentence: () => {} });
    assert.deepEqual(shell.launched, []);
  });
});
