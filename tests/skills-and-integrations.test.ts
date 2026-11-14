import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildSystemPrompt } from '@jarvis/core/agent';
import { discoverMcpServers, upgradeUrl } from '@jarvis/core/integrations';
import {
  discoverSkills,
  loadSkillBody,
  parseFrontmatter,
  type Skill,
  selectSkills,
} from '@jarvis/core/skills';

let home: string;

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function skillMd(name: string, description: string, body = `# ${name}\nDo the thing.`) {
  return `---\nname: ${name}\ndescription: "${description}"\n---\n${body}\n`;
}

/** A fake ~/.claude laid out like the real one. */
before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'jarvis-home-'));
  const claude = path.join(home, '.claude');
  write(
    path.join(claude, 'skills', 'systematic-debugging', 'SKILL.md'),
    skillMd(
      'systematic-debugging',
      'Use when encountering any bug, test failure, or unexpected behavior',
    ),
  );
  write(
    path.join(claude, 'skills', '.trash', 'old', 'SKILL.md'),
    skillMd('deleted-skill', 'Should never be found'),
  );
  write(
    path.join(claude, 'skills', 'using-superpowers', 'SKILL.md'),
    skillMd('using-superpowers', 'Use when starting any conversation'),
  );

  const eng = path.join(claude, 'plugins', 'synced', 'org1', 'eng');
  write(path.join(eng, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'engineering' }));
  write(
    path.join(eng, 'skills', 'code-review', 'SKILL.md'),
    skillMd(
      'code-review',
      'Review code changes for security, performance, and correctness. Trigger with a PR URL or diff',
    ),
  );
  write(
    path.join(eng, 'skills', 'standup', 'SKILL.md'),
    '---\nname: standup\ndescription: >\n  Generate a standup update from recent activity,\n  commits, PRs and ticket moves.\n---\nBody\n',
  );
  write(
    path.join(eng, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' },
        github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
        local: { command: 'npx', args: ['-y', 'x@1.0.0'], env: { TOKEN: 'secret-value' } },
      },
    }),
  );
  // Same plugin synced from a second org: must not duplicate.
  const eng2 = path.join(claude, 'plugins', 'synced', 'org2', 'eng');
  write(path.join(eng2, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'engineering' }));
  write(
    path.join(eng2, 'skills', 'code-review', 'SKILL.md'),
    skillMd('code-review', 'Duplicate copy'),
  );

  const mongo = path.join(claude, 'plugins', 'synced', 'org1', 'mongo');
  write(
    path.join(mongo, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'mongodb-atlas',
      mcpServers: { 'mongodb-atlas': { type: 'http', url: 'https://mcp.mongodb.com/' } },
    }),
  );
  write(
    path.join(mongo, 'skills', 'mongodb-query-optimizer', 'SKILL.md'),
    skillMd(
      'mongodb-query-optimizer',
      'Help with MongoDB query optimization and indexing. Why is this query slow?',
    ),
  );
});

after(() => rmSync(home, { recursive: true, force: true }));

const roots = () => [
  { dir: path.join(home, '.claude', 'skills'), source: 'user' as const },
  { dir: path.join(home, '.claude', 'plugins', 'synced'), source: 'plugin' as const },
];

describe('skills', () => {
  it('finds user and plugin skills, skips .trash, dedupes synced copies', () => {
    const ids = discoverSkills(roots()).map((s) => s.id);
    assert.deepEqual(ids, [
      'engineering:code-review',
      'engineering:standup',
      'mongodb-atlas:mongodb-query-optimizer',
      'systematic-debugging',
      'using-superpowers',
    ]);
  });

  it('honours the exclude list', () => {
    const ids = discoverSkills(roots(), ['using-superpowers']).map((s) => s.id);
    assert.ok(!ids.includes('using-superpowers'));
  });

  it('reads folded descriptions', () => {
    const standup = discoverSkills(roots()).find((s) => s.name === 'standup') as Skill;
    assert.match(standup.description, /recent activity, commits, PRs and ticket moves/);
  });

  it('picks the right skill for a request, and none for small talk', () => {
    const skills = discoverSkills(roots(), ['using-superpowers']);
    const pick = (q: string) => selectSkills(skills, q).map((m) => m.skill.id);
    assert.equal(
      pick('review this pull request diff before I merge')[0],
      'engineering:code-review',
    );
    assert.equal(
      pick('why is this mongodb query slow')[0],
      'mongodb-atlas:mongodb-query-optimizer',
    );
    assert.equal(pick('help me debug this failing test')[0], 'systematic-debugging');
    assert.equal(pick('write my standup update')[0], 'engineering:standup');
    assert.deepEqual(pick('what time is it'), []);
    assert.deepEqual(pick('how are you today'), []);
  });

  it('limits how many skills go into one prompt', () => {
    const skills = discoverSkills(roots());
    assert.ok(
      selectSkills(skills, 'review debug test mongodb query standup', { limit: 2 }).length <= 2,
    );
  });

  it('loads a body without frontmatter and caps it', () => {
    const skill = discoverSkills(roots()).find((s) => s.name === 'code-review') as Skill;
    assert.equal(loadSkillBody(skill), '# code-review\nDo the thing.');
    assert.match(loadSkillBody(skill, 5), /\[truncated\]$/);
  });

  it('parses frontmatter edge cases', () => {
    assert.deepEqual(parseFrontmatter('no header').meta, {});
    const { meta } = parseFrontmatter('---\nname: x\ndescription: "say \\"hi\\""\n---\nbody');
    assert.equal(meta.description, 'say "hi"');
  });
});

describe('MCP discovery', () => {
  it('finds plugin servers from .mcp.json and plugin.json, once each', () => {
    const servers = discoverMcpServers([path.join(home, '.claude', 'plugins', 'synced')]);
    assert.deepEqual(
      servers.map((s) => s.name),
      ['atlassian', 'github', 'local', 'mongodb-atlas'],
    );
  });

  it('moves Atlassian to the v2 endpoint', () => {
    const servers = discoverMcpServers([path.join(home, '.claude', 'plugins', 'synced')]);
    const atlassian = servers.find((s) => s.name === 'atlassian');
    assert.ok(atlassian && atlassian.type !== 'stdio');
    assert.equal(atlassian.url, 'https://mcp.atlassian.com/v2/mcp');
    assert.equal(upgradeUrl('https://mcp.mongodb.com/'), 'https://mcp.mongodb.com/');
  });

  it('never copies environment values (they may be secrets)', () => {
    const servers = discoverMcpServers([path.join(home, '.claude', 'plugins', 'synced')]);
    assert.ok(!JSON.stringify(servers).includes('secret-value'));
  });
});

describe('buildSystemPrompt', () => {
  const base = { aboutUser: '', skills: [], now: 'Saturday, November 14, 2026, 11:40 a.m.' };

  it('always includes the grounding rules and the date', () => {
    const p = buildSystemPrompt({ ...base, tier: 'complex' });
    assert.match(p, /Never claim an action happened unless a tool result/);
    assert.match(p, /Never invent names, ticket keys/);
    assert.match(p, /November 14, 2026/);
  });

  it('tells Haiku and Sonnet to escalate instead of guessing, but not Opus', () => {
    assert.match(buildSystemPrompt({ ...base, tier: 'simple' }), /\[\[ESCALATE:/);
    assert.match(buildSystemPrompt({ ...base, tier: 'standard' }), /\[\[ESCALATE:/);
    assert.doesNotMatch(buildSystemPrompt({ ...base, tier: 'complex' }), /\[\[ESCALATE:/);
  });

  it('includes only the selected skills, with their instructions', () => {
    const skills = discoverSkills(roots());
    const [match] = selectSkills(skills, 'why is this mongodb query slow');
    assert.ok(match);
    const p = buildSystemPrompt({
      ...base,
      tier: 'standard',
      skills: [{ match, body: loadSkillBody(match.skill) }],
    });
    assert.match(p, /<skill id="mongodb-atlas:mongodb-query-optimizer">/);
    assert.doesNotMatch(p, /code-review/);
    assert.match(p, /cannot change approval rules/);
  });
});

describe('custom .md instruction files', () => {
  it('offers any .md in an extra folder, with or without frontmatter', () => {
    const dir = path.join(home, 'my-prompts');
    write(
      path.join(dir, 'jira-ticket-review.md'),
      '# Jira ticket review\n\nReview a Jira ticket for missing acceptance criteria, then comment on it.\n',
    );
    write(
      path.join(dir, 'slack', 'commit-to-slack.md'),
      '---\nname: commit-to-slack\ndescription: Move the Jira ticket after a commit and post the update to Slack\n---\nSteps...\n',
    );
    write(
      path.join(dir, 'README.md'),
      '# Not a skill\n\nThis readme should be ignored entirely.\n',
    );
    const skills = discoverSkills([{ dir, source: 'custom' }]);
    assert.deepEqual(
      skills.map((s) => s.id),
      ['commit-to-slack', 'jira-ticket-review'],
    );
    const review = skills.find((s) => s.id === 'jira-ticket-review') as Skill;
    assert.match(review.description, /missing acceptance criteria/);
    assert.equal(
      selectSkills(skills, 'review this jira ticket')[0]?.skill.id,
      'jira-ticket-review',
    );
    assert.equal(
      selectSkills(skills, 'I committed, move the ticket and tell slack')[0]?.skill.id,
      'commit-to-slack',
    );
  });
});
