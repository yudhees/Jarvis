import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  defaultConfigDir,
  EDITABLE_SETTINGS,
  LIVE_SETTINGS,
  loadConfig,
  readSettings,
  writeSettings,
} from '@jarvis/core/config';
import {
  checkLogoDataUrl,
  DEFAULT_APPEARANCE,
  inkFor,
  parseAppearance,
} from '../packages/pet/src/main/appearance.ts';

const temps: string[] = [];
function copyConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-settings-'));
  temps.push(dir);
  cpSync(defaultConfigDir(), dir, { recursive: true });
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('Settings window: jarvis.yaml edits', () => {
  it('reads the editable settings from the real config', () => {
    const s = readSettings(defaultConfigDir());
    assert.equal(typeof s['voice.rate'], 'number');
    assert.equal(typeof s['listening.bargeIn'], 'boolean');
  });

  it('writes allowed values, keeps comments, and the file still loads', () => {
    const dir = copyConfig();
    const result = writeSettings(dir, {
      'voice.voice': 'Microsoft Zira Desktop',
      'voice.rate': 3,
      'listening.silenceMs': 1200,
      'learning.enabled': false,
    });
    assert.deepEqual(result, { ok: true });
    const text = readFileSync(path.join(dir, 'jarvis.yaml'), 'utf8');
    assert.match(text, /rate: 3 # -10 \(slow\) \.\. 10 \(fast\)/);
    assert.match(text, /# Main settings/);
    const { jarvis } = loadConfig(dir);
    assert.equal(jarvis.voice.voice, 'Microsoft Zira Desktop');
    assert.equal(jarvis.listening.silenceMs, 1200);
    assert.equal(jarvis.learning.enabled, false);
  });

  it('guard: cannot touch approvals, limits, budget, folders, or anything unlisted', () => {
    const dir = copyConfig();
    const before = readFileSync(path.join(dir, 'jarvis.yaml'), 'utf8');
    for (const patch of [
      { 'approval.timeoutSeconds': 9999 },
      { 'tasks.maxTurns': 1000 },
      { 'budget.dailyCostUsd': 1e9 },
      { 'files.allowedFolders': ['C:/'] },
      { 'brain.provider': 'api' },
      { dataDir: 'C:/' },
      { '__proto__.x': 1 },
      { 'voice.rate': 2, 'approval.timeoutSeconds': 1 }, // one bad key refuses the whole patch
    ]) {
      const r = writeSettings(dir, patch);
      assert.equal(r.ok, false, JSON.stringify(patch));
    }
    for (const bad of [null, 'x', [1], 7]) assert.equal(writeSettings(dir, bad).ok, false);
    assert.equal(readFileSync(path.join(dir, 'jarvis.yaml'), 'utf8'), before);
  });

  it('refuses out-of-range and wrongly typed values', () => {
    const dir = copyConfig();
    for (const patch of [
      { 'voice.rate': 11 },
      { 'voice.rate': 1.5 },
      { 'listening.silenceMs': 50 },
      { 'listening.followUpSeconds': 600 },
      { 'listening.bargeIn': 'yes' },
      { 'keywords.provider': 'shell' },
      { 'keywords.minConfidence': 2 },
      { 'voice.voice': '' },
    ]) {
      assert.equal(writeSettings(dir, patch).ok, false, JSON.stringify(patch));
    }
  });

  it('the editable list holds no permission or guard settings', () => {
    for (const key of Object.keys(EDITABLE_SETTINGS)) {
      assert.match(key, /^(voice|listening|keywords|learning)\./);
    }
    for (const key of LIVE_SETTINGS) assert.ok(key in EDITABLE_SETTINGS);
  });
});

describe('Settings window: pet appearance', () => {
  it('defaults, and keeps valid fields', () => {
    assert.deepEqual(parseAppearance(undefined), DEFAULT_APPEARANCE);
    const a = parseAppearance({ look: 'orb', theme: 'dark', accent: '#7C5CFF', size: 110 });
    assert.equal(a.look, 'orb');
    assert.equal(a.theme, 'dark');
    assert.equal(a.accent, '#7c5cff');
    assert.equal(a.size, 110);
  });

  it('accepts every built-in character', () => {
    for (const look of ['robot', 'orb', 'cat', 'bear', 'ghost', 'tv', 'logo']) {
      assert.equal(parseAppearance({ look }).look, look);
    }
  });

  it('rejects bad colors, looks, and sizes, keeping the previous value', () => {
    const base = { ...DEFAULT_APPEARANCE, accent: '#2a6df4' };
    const a = parseAppearance(
      { look: 'clippy', accent: 'red; background:url(x)', glow: 5, size: 500, theme: 'neon' },
      base,
    );
    assert.equal(a.look, 'robot');
    assert.equal(a.accent, '#2a6df4');
    assert.equal(a.glow, null);
    assert.equal(a.size, 100);
    assert.equal(a.theme, 'system');
    assert.equal(parseAppearance({ accent: null }, base).accent, null);
  });

  it('only accepts PNG or JPEG data URLs as logos', () => {
    assert.ok(checkLogoDataUrl('data:image/png;base64,iVBORw0KGgo='));
    assert.ok(checkLogoDataUrl('data:image/jpeg;base64,/9j/4AAQ'));
    assert.equal(checkLogoDataUrl('data:image/svg+xml;base64,PHN2Zz4='), undefined);
    assert.equal(checkLogoDataUrl('data:text/html;base64,PGI+'), undefined);
    assert.equal(checkLogoDataUrl('file:///C:/x.png'), undefined);
    assert.equal(checkLogoDataUrl(`data:image/png;base64,${'A'.repeat(3_000_001)}`), undefined);
  });

  it('picks readable text for the accent color', () => {
    assert.equal(inkFor('#2a6df4'), '#ffffff');
    assert.equal(inkFor('#f5b13d'), '#0d1118');
  });
});
