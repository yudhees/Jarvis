/**
 * Type to Jarvis's memory, learning, and router without audio or model calls.
 *
 *   npm run learn-repl            uses your Claude Memory Store (needs ANTHROPIC_API_KEY)
 *   npm run learn-repl -- --local temporary in-memory store, nothing saved
 *
 * Try: "call me Dee", "I prefer short answers", "always use opus for code questions",
 * "use opus to fix this bug" (twice), "search the news" then "that was too slow" (twice),
 * "it's Jira, not jeera", "what have you learned about me", "forget that".
 * Commands: :about  :list  :quit
 */
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '@jarvis/core/config';
import { Learner, type Proposal } from '@jarvis/core/learning';
import { ClaudeMemoryFiles, InMemoryFiles, type MemoryFiles } from '@jarvis/core/memory';
import { classifyKind, parseModelCommand, type RequestKind, route } from '@jarvis/core/router';
import type { ModelTier } from '@jarvis/shared';
import { scriptArgs } from './args.ts';

const MODEL: Record<ModelTier, string> = { simple: 'Haiku', standard: 'Sonnet', complex: 'Opus' };
const args = scriptArgs({ local: { type: 'boolean' } });
const { learning } = loadConfig().jarvis;

let files: MemoryFiles;
if (args.local) {
  files = new InMemoryFiles();
  console.log('Using a temporary in-memory store. Nothing is saved.');
} else {
  try {
    const claude = await ClaudeMemoryFiles.open();
    files = claude;
    console.log(`Using Claude Memory Store ${claude.storeId}.`);
  } catch (err) {
    console.log(`Could not open the Claude Memory Store: ${(err as Error).message.split('\n')[0]}`);
    console.log('Set ANTHROPIC_API_KEY, or run with --local. Falling back to a temporary store.');
    files = new InMemoryFiles();
  }
}

const learner = await Learner.open(files, learning);
console.log(`${learner.memory.size} memories loaded. Type :quit to exit.\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let pending: Proposal | undefined;
let forcedNext: ModelTier | undefined;
let last: { kind: RequestKind; tier: ModelTier } | undefined;
const say = (text: string) => console.log(`Jarvis: ${text}`);
const ask = (p: Proposal | undefined) => {
  if (!p) return;
  pending = p;
  say(`${p.question} (yes / no)`);
};

// Reading lines as a stream (not rl.question) so piped input is not dropped.
const prompt = () => process.stdout.write('You: ');
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!process.stdin.isTTY) console.log(line);
  if (line === ':quit') break;
  await handleLine(line);
  prompt();
}
rl.close();

async function handleLine(line: string): Promise<void> {
  if (!line) return;
  if (line === ':about') {
    console.log(learner.aboutUserBlock() || '(nothing yet)');
    return;
  }
  if (line === ':list') {
    for (const m of learner.memory.list()) console.log(`  [${m.kind}] ${m.text}`);
    return;
  }

  if (pending) {
    const answer = /^(yes|yeah|yep|sure|ok(ay)?|do it|please do)\b/i.test(line)
      ? true
      : /^(no|nope|don'?t|no thanks)\b/i.test(line)
        ? false
        : undefined;
    if (answer !== undefined) {
      say(await learner.answer(pending.id, answer));
      pending = undefined;
      ask(learner.nextProposal());
      return;
    }
  }

  let text = learner.fixTranscript(line);
  if (text !== line) console.log(`  (heard as: ${text})`);

  let forced = forcedNext;
  const command = parseModelCommand(text);
  if (command) {
    if (!command.rest) {
      forcedNext = command.tier;
      say(`Using ${MODEL[command.tier]} for the next request.`);
      return;
    }
    forced = command.tier;
    text = command.rest;
  }
  forcedNext = undefined;

  const handled = await learner.handle(text, last ? { last } : {});
  if (handled.handled) {
    say(handled.reply);
    if (handled.proposal) pending = handled.proposal;
    return;
  }

  const decision = route(
    forced ? { text, forced, learned: learner.routing() } : { text, learned: learner.routing() },
  );
  const tier = decision.tier;
  console.log(
    `  [route] kind=${decision.kind} model=${MODEL[tier]} speed=${decision.speed} by=${decision.decidedBy}` +
      ` (${decision.reason})` +
      (decision.needsClassifier ? ' [unsure: Haiku classifier will check]' : ''),
  );
  say('(No model call yet; that arrives with phase 1.)');
  last = { kind: decision.kind, tier };

  if (forced)
    ask(await learner.observe({ type: 'forced_model', kind: classifyKind(text), tier: forced }));
  if (!pending)
    ask(await learner.observe({ type: 'request', kind: decision.kind, at: new Date() }));
}
