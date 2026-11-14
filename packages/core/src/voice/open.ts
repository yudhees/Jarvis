import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config/index.ts';
import { Learner } from '../learning/index.ts';
import {
  ClaudeMemoryFiles,
  InMemoryFiles,
  LocalMemoryFiles,
  type MemoryFiles,
} from '../memory/index.ts';
import { readSecret } from '../secrets/index.ts';
import { defaultSkillRoots, discoverSkills } from '../skills/index.ts';
import { ReplyModelClassifier } from './classifier-model.ts';
import { ClaudeCliReplyModel, findClaudeExe } from './claude-cli.ts';
import { ClaudeReplyModel, Conversation, type ReplyModel } from './conversation.ts';

export class MissingKeyError extends Error {}

export interface OpenedConversation {
  conversation: Conversation;
  learner: Learner;
  model: ReplyModel;
  /** Closes the model processes (conversation and classifier). */
  close(): Promise<void>;
  /** Who answers, for the startup line. */
  brain: string;
  memory: string;
  skillCount: number;
}

/**
 * Builds Jarvis's conversation: who answers (the Claude CLI on the user's
 * subscription, or the API with a key), where memory lives, the learner, and
 * installed skills.
 */
export async function openConversation(
  config: Config,
  options: { local?: boolean; projectDir?: string } = {},
): Promise<OpenedConversation> {
  const { jarvis } = config;
  let model: ReplyModel;
  let classifierModel: ReplyModel;
  let brain: string;
  let files: MemoryFiles;
  let memory: string;

  if (jarvis.brain.provider === 'claude-cli') {
    const exe = jarvis.brain.cliPath ?? findClaudeExe();
    if (!exe) {
      throw new MissingKeyError(
        'Claude Code (claude.exe) was not found. Install it and sign in with "claude", or set brain.cliPath.',
      );
    }
    model = new ClaudeCliReplyModel({
      exe,
      workDir: path.join(jarvis.dataDir, 'cli'),
      idleStopMs: jarvis.brain.idleStopSeconds * 1000,
    });
    // Its own process, so classifying never mixes into the conversation.
    classifierModel = new ClaudeCliReplyModel({
      exe,
      workDir: path.join(jarvis.dataDir, 'cli-classifier'),
      idleStopMs: jarvis.brain.idleStopSeconds * 1000,
    });
    brain = 'your Claude subscription (Claude CLI)';
    // The Claude Memory Store needs an API key, so memory stays in one small file here.
    files = options.local
      ? new InMemoryFiles()
      : new LocalMemoryFiles(path.join(jarvis.dataDir, 'memory.json'));
    memory = options.local ? 'temporary (nothing saved)' : 'saved on this PC (memory.json)';
  } else {
    const apiKey = await readSecret('anthropic');
    if (!apiKey) {
      throw new MissingKeyError('No Anthropic API key saved. Run: npm run set-key -- anthropic');
    }
    const client = new Anthropic({ apiKey });
    model = new ClaudeReplyModel(client);
    classifierModel = model; // the API keeps no state between calls
    brain = 'Anthropic API';
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
  }

  const learner = await Learner.open(files, jarvis.learning);
  const skills = jarvis.skills.enabled
    ? discoverSkills(
        defaultSkillRoots(os.homedir(), options.projectDir, jarvis.skills.extraDirs),
        jarvis.skills.exclude,
      )
    : [];
  const conversation = new Conversation({
    model,
    models: config.models,
    learner,
    skills,
    maxSkills: jarvis.skills.maxPerRequest,
    toolTier: (name) => config.permissions.tools[name] ?? 2,
    classifier: jarvis.routing.classifier
      ? new ReplyModelClassifier(classifierModel, config.models.classifier)
      : undefined,
    classifierTimeoutMs: jarvis.routing.classifierTimeoutSeconds * 1000,
  });
  const close = async () => {
    await Promise.allSettled([model.close?.(), classifierModel.close?.()]);
  };
  return { conversation, learner, model, close, brain, memory, skillCount: skills.length };
}
