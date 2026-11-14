import os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config/index.ts';
import { Learner } from '../learning/index.ts';
import { ClaudeMemoryFiles, InMemoryFiles, type MemoryFiles } from '../memory/index.ts';
import { readSecret } from '../secrets/index.ts';
import { defaultSkillRoots, discoverSkills } from '../skills/index.ts';
import { ClaudeReplyModel, Conversation } from './conversation.ts';

export class MissingKeyError extends Error {}

export interface OpenedConversation {
  conversation: Conversation;
  learner: Learner;
  memory: string;
  skillCount: number;
}

/**
 * Builds Jarvis's conversation: API key from Credential Manager, memory from the
 * Claude Memory Store (or in memory with `local`), learner, and installed skills.
 */
export async function openConversation(
  config: Config,
  options: { local?: boolean; projectDir?: string } = {},
): Promise<OpenedConversation> {
  const apiKey = await readSecret('anthropic');
  if (!apiKey) {
    throw new MissingKeyError('No Anthropic API key saved. Run: npm run set-key -- anthropic');
  }
  const client = new Anthropic({ apiKey });

  let files: MemoryFiles;
  let memory: string;
  if (options.local) {
    files = new InMemoryFiles();
    memory = 'temporary (nothing saved)';
  } else {
    try {
      const store = await ClaudeMemoryFiles.open(client);
      files = store;
      memory = `Claude Memory Store ${store.storeId}`;
    } catch (err) {
      // Offline or the beta is unavailable: keep working, just without saved memory.
      files = new InMemoryFiles();
      const reason = (err as Error).message.split('\n')[0];
      memory = `temporary; Claude Memory Store unavailable (${reason})`;
    }
  }
  const { jarvis } = config;
  const learner = await Learner.open(files, jarvis.learning);
  const skills = jarvis.skills.enabled
    ? discoverSkills(
        defaultSkillRoots(os.homedir(), options.projectDir, jarvis.skills.extraDirs),
        jarvis.skills.exclude,
      )
    : [];
  const conversation = new Conversation({
    model: new ClaudeReplyModel(client),
    models: config.models,
    learner,
    skills,
    maxSkills: jarvis.skills.maxPerRequest,
    toolTier: (name) => config.permissions.tools[name] ?? 2,
  });
  return { conversation, learner, memory, skillCount: skills.length };
}
