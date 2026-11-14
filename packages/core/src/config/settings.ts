import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isScalar, parseDocument } from 'yaml';
import type { z } from 'zod';
import { jarvisSchema } from './schema.ts';

/**
 * The few jarvis.yaml settings the Settings window may change. Everything else
 * (permission tiers, approval timeouts, task limits, budget, allowed folders,
 * connected services, models) is deliberately left to the config files: a UI
 * must never be a way around the guardrails (CLAUDE.md 9, 10).
 */
const s = jarvisSchema.shape;
export const EDITABLE_SETTINGS = {
  'voice.voice': s.voice.shape.voice,
  'voice.rate': s.voice.shape.rate,
  'listening.silenceMs': s.listening.shape.silenceMs,
  'listening.followUpSeconds': s.listening.shape.followUpSeconds.max(60),
  'listening.bargeIn': s.listening.shape.bargeIn,
  'keywords.provider': s.keywords.shape.provider,
  'keywords.minConfidence': s.keywords.shape.minConfidence,
  'learning.enabled': s.learning.shape.enabled,
} as const satisfies Record<string, z.ZodType>;

export type EditableKey = keyof typeof EDITABLE_SETTINGS;
export type EditableSettings = { [K in EditableKey]: z.infer<(typeof EDITABLE_SETTINGS)[K]> };

/** Settings a running core picks up at once (see watchJarvisConfig); the rest need a restart. */
export const LIVE_SETTINGS: ReadonlySet<EditableKey> = new Set<EditableKey>([
  'voice.voice',
  'voice.rate',
  'listening.silenceMs',
  'listening.followUpSeconds',
  'listening.bargeIn',
]);

const KEYS = Object.keys(EDITABLE_SETTINGS) as EditableKey[];
const FILE = 'jarvis.yaml';

function isEditableKey(key: string): key is EditableKey {
  return Object.hasOwn(EDITABLE_SETTINGS, key);
}

/** Current values of the editable settings, straight from jarvis.yaml. */
export function readSettings(configDir: string): EditableSettings {
  const doc = parseDocument(readFileSync(path.join(configDir, FILE), 'utf8'));
  const out: Record<string, unknown> = {};
  for (const key of KEYS) out[key] = doc.getIn(key.split('.'));
  return out as EditableSettings;
}

export type SettingsResult = { ok: true } | { ok: false; problems: string[] };

/**
 * Changes editable settings in jarvis.yaml, keeping its comments. The patch is
 * untrusted (it comes from a window): unknown keys, wrong types and values out
 * of range are refused, and the whole file must still pass the startup schema
 * before anything is written. The write is atomic (temp file, then rename).
 */
export function writeSettings(configDir: string, patch: unknown): SettingsResult {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, problems: ['settings must be an object'] };
  }
  const problems: string[] = [];
  const changes: [EditableKey, unknown][] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!isEditableKey(key)) {
      problems.push(`${key}: cannot be changed from the Settings window`);
      continue;
    }
    const parsed = EDITABLE_SETTINGS[key].safeParse(value);
    if (!parsed.success) {
      problems.push(`${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
      continue;
    }
    changes.push([key, parsed.data]);
  }
  if (problems.length > 0) return { ok: false, problems };
  if (changes.length === 0) return { ok: true };

  const file = path.join(configDir, FILE);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  for (const [key, value] of changes) {
    const where = key.split('.');
    const node = doc.getIn(where, true);
    // Change the value in place so the comment on that line stays.
    if (isScalar(node)) node.value = value;
    else doc.setIn(where, value);
  }
  const whole = jarvisSchema.safeParse(doc.toJS());
  if (!whole.success) {
    return {
      ok: false,
      problems: whole.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, doc.toString());
  renameSync(temp, file);
  return { ok: true };
}
