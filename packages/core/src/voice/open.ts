import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AuditLog } from '../audit/index.ts';
import { type Config, expandWindowsVars } from '../config/index.ts';
import { type Approver, Gate, GatedTools } from '../guard/index.ts';
import { Learner } from '../learning/index.ts';
import {
  ClaudeMemoryFiles,
  InMemoryFiles,
  LocalMemoryFiles,
  type MemoryFiles,
} from '../memory/index.ts';
import { readSecret } from '../secrets/index.ts';
import { defaultSkillRoots, discoverSkills } from '../skills/index.ts';
import { fileTools, type JarvisTool, JiraClient, jiraTools } from '../tools/index.ts';
import { windowsTools } from '../tools/windows.ts';
import { ReplyModelClassifier } from './classifier-model.ts';
import { ClaudeCliReplyModel, findClaudeExe } from './claude-cli.ts';
import { ClaudeReplyModel, Conversation, type ReplyModel } from './conversation.ts';

export class MissingKeyError extends Error {}
/** The startup self-test failed: Jarvis must not start (CLAUDE.md 4). */
export class LockdownError extends Error {}

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
  audit: AuditLog;
  /** Hands spoken approval to the voice loop (or the REPL). */
  setApprover(fn: Approver['ask']): void;
  toolNames: string[];
  /** Jira's state, for the startup line. */
  jira: string;
  folders: string[];
  dryRun: boolean;
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
  // Phase 3: the permission gate, spoken approval and the audit log (CLAUDE.md 9, 10).
  const audit = new AuditLog(path.join(jarvis.dataDir, 'audit'), jarvis.retention.transcriptDays);
  audit.startRetention();
  // Until the voice loop takes over, nothing can be approved.
  let approve: Approver['ask'] = async () => ({ outcome: 'cancel' });
  const gated = new GatedTools({
    gate: new Gate({
      tiers: config.permissions.tools,
      maxIdenticalCalls: jarvis.tasks.maxIdenticalToolCalls,
    }),
    approver: { ask: (request) => approve(request) },
    audit,
    dryRun: process.env.JARVIS_DRY_RUN === '1',
  });

  const tools: JarvisTool[] = [];
  const folders = jarvis.files.allowedFolders.map((p) => path.normalize(expandWindowsVars(p)));
  if (folders[0]) {
    mkdirSync(folders[0], { recursive: true });
    tools.push(...fileTools(folders));
  }
  let jira = 'not set up (jira.site and jira.email in jarvis.yaml)';
  if (jarvis.jira.site && jarvis.jira.email) {
    const token = await readSecret('jira');
    if (token) {
      tools.push(
        ...jiraTools(new JiraClient({ site: jarvis.jira.site, email: jarvis.jira.email, token })),
      );
      jira = jarvis.jira.site;
    } else {
      jira = 'no API token yet (npm run set-key -- jira)';
    }
  }

  const actions = jarvis.apps.enabled
    ? windowsTools({
        browser: jarvis.apps.browser,
        searchUrl: jarvis.apps.searchUrl,
        onAction: (line) => console.log(`[action] ${line}`),
      })
    : [];
  // Startup self-test (CLAUDE.md 4): every tool offered must have a tier in
  // permissions.yaml, or Jarvis refuses to start.
  const unlisted = [...tools, ...actions]
    .map((t) => t.name)
    .filter((name) => !Object.hasOwn(config.permissions.tools, name));
  if (unlisted.length > 0) {
    throw new LockdownError(
      `These tools have no tier in config/permissions.yaml: ${unlisted.join(', ')}`,
    );
  }

  const conversation = new Conversation({
    model,
    models: config.models,
    learner,
    skills,
    maxSkills: jarvis.skills.maxPerRequest,
    toolTier: (name) => config.permissions.tools[name] ?? 2,
    actions,
    gated,
    tools,
    classifier: jarvis.routing.classifier
      ? new ReplyModelClassifier(classifierModel, config.models.classifier)
      : undefined,
    classifierTimeoutMs: jarvis.routing.classifierTimeoutSeconds * 1000,
  });
  const close = async () => {
    await Promise.allSettled([model.close?.(), classifierModel.close?.()]);
  };
  return {
    conversation,
    learner,
    model,
    close: async () => {
      audit.stop();
      await close();
    },
    brain,
    memory,
    skillCount: skills.length,
    audit,
    setApprover: (fn) => {
      approve = fn;
    },
    toolNames: [...tools, ...actions].map((t) => t.name),
    jira,
    folders,
    dryRun: process.env.JARVIS_DRY_RUN === '1',
  };
}
