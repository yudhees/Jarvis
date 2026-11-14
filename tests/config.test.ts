import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ConfigError, defaultConfigDir, expandWindowsVars, loadConfig } from '@jarvis/core/config';

const realDir = defaultConfigDir();
const temps: string[] = [];

/** Copies the real config to a temp folder and applies an edit to one file. */
function withEdit(file: string, edit: (text: string) => string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-config-'));
  temps.push(dir);
  cpSync(realDir, dir, { recursive: true });
  const full = path.join(dir, file);
  writeFileSync(full, edit(readFileSync(full, 'utf8')));
  return dir;
}

function problemsOf(dir: string): string[] {
  try {
    loadConfig(dir);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
    return err.problems;
  }
  assert.fail('expected loadConfig to throw');
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads the shipped config', () => {
    const config = loadConfig(realDir);
    assert.equal(config.models.tiers.simple, 'claude-haiku-5-5');
    assert.equal(config.jarvis.audio.sampleRate, 16000);
    assert.equal(config.permissions.tools.mcp__atlassian__transitionJiraIssue, 2);
    assert.equal(config.permissions.tools['mcp__mongodb-atlas__find'], 0);
    assert.ok(!config.jarvis.dataDir.includes('%'), 'dataDir should be expanded');
  });

  it('rejects an unknown key (typo)', () => {
    const dir = withEdit('jarvis.yaml', (t) => t.replace('maxTurns:', 'maxTurn:'));
    const problems = problemsOf(dir);
    assert.ok(problems.some((p) => p.startsWith('jarvis.yaml: tasks')));
  });

  it('rejects a risk tier outside 0..4', () => {
    const dir = withEdit('permissions.yaml', () => 'tools:\n  slack_send: 7\n');
    assert.ok(problemsOf(dir).some((p) => p.includes('tools.slack_send')));
  });

  it('does not allow changing the unlisted-tool default', () => {
    const dir = withEdit('permissions.yaml', () => 'defaultTier: 0\ntools: {}\n');
    assert.ok(problemsOf(dir).some((p) => p.startsWith('permissions.yaml')));
  });

  it('rejects a sample rate other than 16 kHz', () => {
    const dir = withEdit('jarvis.yaml', (t) => t.replace('sampleRate: 16000', 'sampleRate: 44100'));
    assert.ok(problemsOf(dir).some((p) => p.includes('audio.sampleRate')));
  });

  it('reports broken YAML with the file name', () => {
    const dir = withEdit('models.yaml', () => 'tiers: [unclosed\n');
    assert.ok(problemsOf(dir).some((p) => p.startsWith('models.yaml:')));
  });

  it('collects problems from several files at once', () => {
    const dir = withEdit('models.yaml', () => 'tiers: {}\nclassifier: gpt-4\n');
    writeFileSync(path.join(dir, 'mcp.yaml'), 'servers:\n  x:\n    type: ftp\n');
    const problems = problemsOf(dir);
    assert.ok(problems.some((p) => p.startsWith('models.yaml')));
    assert.ok(problems.some((p) => p.startsWith('mcp.yaml')));
  });
});

describe('expandWindowsVars', () => {
  it('expands known variables', () => {
    assert.equal(expandWindowsVars('%A%/jarvis', { A: 'C:\\Users\\me' }), 'C:\\Users\\me/jarvis');
  });

  it('throws on a missing variable', () => {
    assert.throws(() => expandWindowsVars('%NOPE%/x', {}), /NOPE/);
  });
});
