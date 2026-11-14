import type Anthropic from '@anthropic-ai/sdk';
import type { ModelTier, Speed } from '@jarvis/shared';
import { buildPromptParts, type PromptSkill } from '../agent/index.ts';
import type { ModelsConfig } from '../config/index.ts';
import type { GatedTools, RunnableTool } from '../guard/index.ts';
import { type Learner, type Proposal, parseStatement } from '../learning/index.ts';
import {
  type Classifier,
  type ClassifierOutcome,
  classifyWithin,
  parseEscalation,
  parseModelCommand,
  type RequestKind,
  type RouteDecision,
  raiseTier,
  route,
} from '../router/index.ts';
import { loadSkillBody, type Skill, selectSkills } from '../skills/index.ts';
import { SentenceSplitter, spokenNow } from './sentences.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool Jarvis runs itself: a lookup (tier 0) or a small action (tier 1). */
export interface LocalTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  run(input: Record<string, unknown>): Promise<string> | string;
  /**
   * The result is already the spoken reply ("Opened Slack."), so the model is
   * not asked again to word it. Saves a whole model round for actions.
   */
  speaksResult?: boolean;
  /**
   * Handles a plain request in code, with no model call at all ("open Slack").
   * Returns the spoken reply, or undefined to let the model handle it.
   */
  quick?(text: string): Promise<string | undefined>;
}

export interface ModelRequest {
  model: string;
  /** Persona and rules: the same for the whole conversation. */
  system: string;
  /** Time, notes about the user, skill list: changes per request. */
  context: string;
  messages: readonly ChatMessage[];
  maxTokens: number;
  tools?: readonly LocalTool[];
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

/** The model call, behind an interface so tests need no network. */
export interface ReplyModel {
  stream(req: ModelRequest, onText: (delta: string) => void): Promise<ModelUsage>;
  /** Optional: get ready for a request (start a process) before it arrives. */
  warm?(req: Pick<ModelRequest, 'model' | 'system' | 'tools'>): void;
  close?(): Promise<void>;
}

/** Most tool rounds per reply; memory and skill lookups need one or two. */
const MAX_TOOL_ROUNDS = 4;

/**
 * Streams a reply with the Anthropic SDK. Runs Jarvis's own read-only tools
 * (memory search, skill read) when the model asks; their exchanges are not kept
 * in the conversation history, so the context stays small.
 */
export class ClaudeReplyModel implements ReplyModel {
  readonly #client: Anthropic;

  constructor(client: Anthropic) {
    this.#client = client;
  }

  async stream(req: ModelRequest, onText: (delta: string) => void): Promise<ModelUsage> {
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
    const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const tools = req.tools ?? [];
    for (let round = 0; ; round++) {
      const useTools = tools.length > 0 && round < MAX_TOOL_ROUNDS;
      const stream = this.#client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: `${req.system}

${req.context}`,
          messages,
          ...(useTools
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema,
                })),
              }
            : {}),
        },
        { signal: req.signal },
      );
      stream.on('text', onText);
      const final = await stream.finalMessage();
      usage.inputTokens += final.usage.input_tokens;
      usage.outputTokens += final.usage.output_tokens;
      if (final.stop_reason !== 'tool_use' || !useTools) return usage;

      const calls = final.content.filter((b) => b.type === 'tool_use');
      const speaking = calls.every((b) => tools.find((t) => t.name === b.name)?.speaksResult);
      messages.push({ role: 'assistant', content: final.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of final.content) {
        if (block.type !== 'tool_use') continue;
        usage.toolCalls++;
        const tool = tools.find((t) => t.name === block.name);
        let content: string;
        let isError = false;
        try {
          if (!tool) throw new Error(`unknown tool ${block.name}`);
          content = await tool.run((block.input ?? {}) as Record<string, unknown>);
        } catch (err) {
          content = (err as Error).message;
          isError = true;
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: isError });
      }
      if (speaking) {
        // Actions word their own result; no second model round to say it.
        onText(` ${results.map((r) => r.content).join(' ')}`);
        return usage;
      }
      messages.push({ role: 'user', content: results });
    }
  }
}

export interface AskOptions {
  /** Called with each finished sentence, in order, as soon as it is ready. */
  onSentence: (sentence: string) => void;
  signal?: AbortSignal;
  /** Called when the model starts, for the pet's H/S/O label. */
  onModel?: (tier: ModelTier, model: string, speed: Speed) => void;
}

/** What Conversation.ask() would do with a text (see preview()). */
export type ConversationPreview =
  | { outcome: 'pending_answer' }
  | { outcome: 'learning'; detail: string }
  | { outcome: 'model_command'; tier: ModelTier }
  | {
      outcome: 'agent';
      /** The exact request text the model would get. */
      request: string;
      decision: RouteDecision;
      model: string;
      classifier: boolean;
      skills: string[];
    };

export interface AskResult {
  reply: string;
  /** Null when Jarvis answered without a model call (learning, model command). */
  tier: ModelTier | null;
  model: string | null;
  decision: RouteDecision | null;
  escalations: number;
  usage: ModelUsage;
  /** Time until the first sentence was ready. */
  firstSentenceMs: number | null;
  /** Set when the classifier was asked. */
  classifier?: ClassifierOutcome;
}

export interface ConversationOptions {
  model: ReplyModel;
  models: ModelsConfig;
  learner: Learner;
  skills?: readonly Skill[];
  maxSkills?: number;
  /**
   * Risk tier of a tool from permissions.yaml (unlisted = 2). Until the approval
   * gate exists (phase 3), only tier 0 and tier 1 tools are offered: tier 1 runs
   * without asking by design (CLAUDE.md 9).
   */
  toolTier?: (name: string) => number;
  /** Actions Jarvis can take (open an app, open a page). Offered only at tier 0 or 1. */
  actions?: readonly LocalTool[];
  /**
   * The permission gate (phase 3). With it, every tool and action goes through
   * the gate and spoken approval, at any tier; without it, only tier 0/1 run.
   */
  gated?: GatedTools;
  /** Service tools (Jira, files), offered only through the gate. */
  tools?: readonly RunnableTool[];
  /** Haiku classifier for requests the code estimate is unsure about (rule 4). */
  classifier?: Classifier;
  /** Past this, the estimate stands (default 1.5 s). */
  classifierTimeoutMs?: number;
  /** Turns kept in the model's context (user + assistant pairs). */
  maxTurns?: number;
  now?: () => Date;
}

/** Skills listed (name and description only) per request. */
const SKILL_INDEX_SIZE = 3;
/** Most characters of one skill returned by skill_read. */
const SKILL_READ_MAX = 8000;

/**
 * Retrieval on demand instead of a full prompt: the user's memory and the
 * installed skills are looked up only when the model asks (tier 0, read-only).
 */
export function retrievalTools(learner: Learner, skills: readonly Skill[]): LocalTool[] {
  return [
    {
      name: 'memory_search',
      description:
        'Search what the user told Jarvis before: names, contacts, projects, defaults, preferences, notes. Returns up to 5 matching notes, or none.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "A few keywords, like 'Priya slack'" },
        },
        required: ['query'],
      },
      run: (input) => {
        const found = learner.memory.search(String(input.query ?? ''), { limit: 5 });
        return found.length ? found.map((m) => `- ${m.text}`).join('\n') : 'No matching notes.';
      },
    },
    {
      name: 'skill_read',
      description:
        'Read the full instructions of one installed skill listed in the system prompt, by its id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Skill id from the list' } },
        required: ['id'],
      },
      run: (input) => {
        const skill = skills.find((s) => s.id === input.id || s.name === input.id);
        if (!skill) throw new Error(`No skill with id ${String(input.id)}.`);
        return `<skill id="${skill.id}">\n${loadSkillBody(skill, SKILL_READ_MAX)}\n</skill>`;
      },
    },
  ];
}

const MAX_TOKENS: Record<ModelTier, number> = { simple: 300, standard: 600, complex: 1200 };
const MODEL_NAME: Record<ModelTier, string> = {
  simple: 'Haiku',
  standard: 'Sonnet',
  complex: 'Opus',
};
const YES = /^(yes|yeah|yep|sure|ok(ay)?|please do|do it|go ahead)\b/i;
const NO = /^(no|nope|don'?t|never mind|not now)\b/i;

/**
 * One spoken conversation: learning statements, model commands, routing,
 * streaming the reply sentence by sentence, and escalation (CLAUDE.md 7, 13.1).
 */
export class Conversation {
  readonly #o: ConversationOptions;
  #history: ChatMessage[] = [];
  /** Bumped by reset(), so a reply that finishes after "stop" cannot leak into the next conversation. */
  #generation = 0;
  #tier: ModelTier | undefined;
  #forcedNext: ModelTier | undefined;
  #pending: Proposal | undefined;
  #last: { kind: RequestKind; tier: ModelTier } | undefined;

  readonly #tools: LocalTool[];
  /** This request read installed-skill text, so actions are held (CLAUDE.md 10.3). */
  #tainted = false;

  constructor(options: ConversationOptions) {
    this.#o = options;
    const tier = options.toolTier ?? (() => 2);
    const lookups = retrievalTools(options.learner, options.skills ?? [])
      .filter((t) => tier(t.name) === 0)
      .map((t) =>
        t.name === 'skill_read'
          ? {
              ...t,
              run: (input: Record<string, unknown>) => {
                this.#tainted = true;
                return t.run(input);
              },
            }
          : t,
      );
    const gated = options.gated;
    if (gated) {
      // Phase 3: every tool goes through the permission gate (CLAUDE.md 9). It
      // runs tier 0/1, asks by voice for tier 2/3, denies tier 4, and after
      // outside text (a skill, a ticket, a file) asks even for tier 1 (10.3).
      this.#tools = [
        ...lookups.map((t) => gated.wrap(t.name === 'skill_read' ? { ...t, untrusted: true } : t)),
        ...(options.actions ?? []).map((t) => gated.wrap(t)),
        ...(options.tools ?? []).map((t) => gated.wrap(t)),
      ];
      return;
    }
    // No gate (tests, dev): tier 1 actions run without asking. After reading
    // text Jarvis did not write (a skill), they would need approval, which only
    // the gate provides, so they are refused for the rest of that request.
    const actions = (options.actions ?? [])
      .filter((t) => tier(t.name) <= 1)
      .map((t) => ({
        ...t,
        run: (input: Record<string, unknown>) =>
          this.#tainted && tier(t.name) >= 1
            ? 'Not done: this needs your spoken approval, which is not available yet.'
            : t.run(input),
      }));
    this.#tools = [...lookups, ...actions];
  }

  /** What the conversation is on, for "what are you doing?". */
  get tier(): ModelTier | undefined {
    return this.#tier;
  }

  /** The wake word was heard: let the model get ready while the user talks. */
  warm(): void {
    if (this.#history.length > 0 || !this.#o.model.warm) return;
    const { stable } = buildPromptParts({
      tier: 'simple',
      aboutUser: '',
      skills: [],
      now: '',
      retrieval: this.#tools.some((t) => t.name === 'memory_search'),
    });
    this.#o.model.warm({ model: this.#o.models.tiers.simple, system: stable, tools: this.#tools });
  }

  /** Ends the conversation (back to sleep): the next request starts fresh on Haiku. */
  reset(): void {
    this.#generation++;
    this.#history = [];
    this.#tier = undefined;
    this.#pending = undefined;
  }

  /**
   * What ask() would do with this text, without doing any of it: no model or
   * classifier call, nothing learned or saved, conversation state unchanged.
   * Mirrors the order of ask(). For the Settings window's voice test.
   */
  preview(text: string): ConversationPreview {
    if (this.#pending && (YES.test(text) || NO.test(text))) {
      return { outcome: 'pending_answer' };
    }
    const statement = parseStatement(text);
    if (statement) return { outcome: 'learning', detail: statement.type };

    let request = text;
    let forced = this.#forcedNext;
    const command = parseModelCommand(text);
    if (command) {
      forced = command.tier;
      if (!command.rest) return { outcome: 'model_command', tier: command.tier };
      request = command.rest;
    }
    const decision = route({
      text: request,
      forced,
      followUpTier: this.#tier,
      learned: this.#o.learner.routing(),
    });
    const skills = this.#o.skills
      ? selectSkills(this.#o.skills, request, { limit: this.#o.maxSkills ?? SKILL_INDEX_SIZE })
      : [];
    return {
      outcome: 'agent',
      request,
      decision,
      model: this.#o.models.tiers[decision.tier],
      classifier: decision.needsClassifier && this.#o.classifier !== undefined,
      skills: skills.map((m) => m.skill.name),
    };
  }

  async ask(text: string, options: AskOptions): Promise<AskResult> {
    const started = performance.now();
    this.#tainted = false;
    this.#o.gated?.newTask();
    let firstSentenceMs: number | null = null;
    const say = (s: string) => {
      firstSentenceMs ??= performance.now() - started;
      options.onSentence(s);
    };
    const local = (reply: string): AskResult => {
      say(reply);
      return {
        reply,
        tier: null,
        model: null,
        decision: null,
        escalations: 0,
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        firstSentenceMs,
      };
    };
    const { learner } = this.#o;

    // An answer to a question Jarvis asked ("Should I always use Opus for code?").
    if (this.#pending && (YES.test(text) || NO.test(text))) {
      const p = this.#pending;
      this.#pending = undefined;
      return local(await learner.answer(p.id, YES.test(text)));
    }
    this.#pending = undefined;

    const learned = await learner.handle(text, { last: this.#last });
    if (learned.handled) {
      this.#pending = learned.proposal;
      return local(
        learned.proposal ? `${learned.reply} ${learned.proposal.question}` : learned.reply,
      );
    }

    let request = text;
    let forced = this.#forcedNext;
    const command = parseModelCommand(text);
    if (command) {
      forced = command.tier;
      if (!command.rest) {
        this.#forcedNext = command.tier;
        return local(`Okay, I'll use ${MODEL_NAME[command.tier]} for the next request.`);
      }
      request = command.rest;
    }
    this.#forcedNext = undefined;

    // A plain action ("open Slack", "open github.com") is done in code with no
    // model call. Only tier 0/1 actions are in #tools, so this never skips a gate.
    for (const t of this.#tools) {
      const reply = t.quick ? await t.quick(request).catch(() => undefined) : undefined;
      if (reply) {
        this.#history.push(
          { role: 'user', content: request },
          { role: 'assistant', content: reply },
        );
        const max = (this.#o.maxTurns ?? 10) * 2;
        if (this.#history.length > max) this.#history = this.#history.slice(-max);
        return local(reply);
      }
    }

    let decision = route({
      text: request,
      forced,
      followUpTier: this.#tier,
      learned: learner.routing(),
    });
    // Rule 4: only when the code estimate is unsure; it may raise, never lower.
    let classifier: ClassifierOutcome | undefined;
    if (decision.needsClassifier && this.#o.classifier) {
      classifier = await classifyWithin(
        this.#o.classifier,
        request,
        decision.tier,
        this.#o.classifierTimeoutMs ?? 1500,
      );
      if (classifier.raised) {
        decision = {
          ...decision,
          tier: classifier.tier,
          decidedBy: 'classifier',
          reason: `classifier: ${classifier.classification?.reason || 'harder than it looks'}`,
        };
      }
    }
    if (forced) {
      const p = await learner.observe({ type: 'forced_model', kind: decision.kind, tier: forced });
      this.#pending ??= p;
    }
    const habit = await learner.observe({ type: 'request', kind: decision.kind, at: new Date() });
    this.#pending ??= habit;

    // Only names and descriptions go in the prompt; the model reads a skill with
    // skill_read when it needs it, so instructions never fill the context up front.
    const skills: PromptSkill[] = (
      this.#o.skills
        ? selectSkills(this.#o.skills, request, { limit: this.#o.maxSkills ?? SKILL_INDEX_SIZE })
        : []
    ).map((match) => ({ match }));

    const generation = this.#generation;
    this.#history.push({ role: 'user', content: request });
    let tier = decision.tier;
    let escalations = 0;
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
    let reply = '';
    for (;;) {
      const model = this.#o.models.tiers[tier];
      options.onModel?.(tier, model, decision.speed);
      const prompt = buildPromptParts({
        tier,
        aboutUser: learner.aboutUserBlock(),
        skills,
        now: spokenNow(this.#o.now?.() ?? new Date()),
        retrieval: this.#tools.some((t) => t.name === 'memory_search'),
      });
      let result: { text: string; escalate: boolean; usage: ModelUsage };
      try {
        result = await this.#streamOnce(model, tier, prompt, say, options.signal);
      } catch (err) {
        // Cancelled or failed: take the unanswered request back out, so the
        // history never has two user turns in a row (the user may say it again,
        // or a longer version of it).
        const last = this.#history.at(-1);
        if (generation === this.#generation && last?.role === 'user' && last.content === request) {
          this.#history.pop();
        }
        throw err;
      }
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.toolCalls += result.usage.toolCalls;
      // Never go down a tier, and stop at the top (CLAUDE.md 7 rules 5 and 6).
      if (result.escalate && tier !== 'complex') {
        tier = raiseTier(tier);
        escalations++;
        continue;
      }
      reply = result.escalate ? 'Sorry, that one is beyond me right now.' : result.text;
      if (result.escalate) say(reply);
      break;
    }

    if (generation !== this.#generation) {
      // Stopped mid-reply: the new conversation must not start with this answer.
      return {
        reply,
        tier,
        model: this.#o.models.tiers[tier],
        decision,
        escalations,
        usage,
        firstSentenceMs,
      };
    }
    this.#history.push({ role: 'assistant', content: reply });
    const max = (this.#o.maxTurns ?? 10) * 2;
    if (this.#history.length > max) this.#history = this.#history.slice(-max);
    this.#tier = tier;
    this.#last = { kind: decision.kind, tier };
    if (this.#pending) say(this.#pending.question);
    return {
      reply,
      tier,
      model: this.#o.models.tiers[tier],
      decision,
      escalations,
      usage,
      firstSentenceMs,
      classifier,
    };
  }

  /** One model call. Holds text back until it is clear it is not an escalation marker. */
  async #streamOnce(
    model: string,
    tier: ModelTier,
    prompt: { stable: string; context: string },
    say: (s: string) => void,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; escalate: boolean; usage: ModelUsage }> {
    const splitter = new SentenceSplitter();
    let text = '';
    let decided: 'speak' | 'escalate' | undefined;
    const usage = await this.#o.model.stream(
      {
        model,
        system: prompt.stable,
        context: prompt.context,
        messages: [...this.#history],
        maxTokens: MAX_TOKENS[tier],
        tools: this.#tools,
        signal,
      },
      (delta) => {
        text += delta;
        if (!decided) {
          const head = text.trimStart();
          // Wait for enough text to tell "[[ESCALATE: ...]]" from a real answer.
          if (head.length < 2) return;
          if (
            head.startsWith('[') &&
            head.length < 12 &&
            '[[ESCALATE'.startsWith(head.slice(0, 10).toUpperCase())
          ) {
            return;
          }
          decided = head.toUpperCase().startsWith('[[ESCALATE') ? 'escalate' : 'speak';
          if (decided === 'speak') for (const s of splitter.push(text)) say(s);
          return;
        }
        if (decided === 'speak') for (const s of splitter.push(delta)) say(s);
      },
    );
    if (!decided) {
      // Very short reply: nothing was released while streaming.
      decided = parseEscalation(text) ? 'escalate' : 'speak';
      if (decided === 'speak') for (const s of splitter.push(text)) say(s);
    }
    if (decided === 'escalate') return { text, escalate: true, usage };
    const rest = splitter.flush();
    if (rest) say(rest);
    return { text: text.trim(), escalate: false, usage };
  }
}
