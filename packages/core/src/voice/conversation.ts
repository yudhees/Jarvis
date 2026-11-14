import type Anthropic from '@anthropic-ai/sdk';
import type { ModelTier, Speed } from '@jarvis/shared';
import { buildPromptParts, type PromptSkill } from '../agent/index.ts';
import type { ModelsConfig } from '../config/index.ts';
import type { Learner, Proposal } from '../learning/index.ts';
import {
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

/** A read-only tool Jarvis runs itself (tier 0 in permissions.yaml). */
export interface LocalTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  run(input: Record<string, unknown>): Promise<string> | string;
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
}

export interface ConversationOptions {
  model: ReplyModel;
  models: ModelsConfig;
  learner: Learner;
  skills?: readonly Skill[];
  maxSkills?: number;
  /**
   * Risk tier of a tool from permissions.yaml (unlisted = 2). Until the approval
   * gate exists (phase 3), only tier 0 tools are offered to the model.
   */
  toolTier?: (name: string) => number;
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

  constructor(options: ConversationOptions) {
    this.#o = options;
    const tier = options.toolTier ?? (() => 2);
    this.#tools = retrievalTools(options.learner, options.skills ?? []).filter(
      (t) => tier(t.name) === 0,
    );
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

  async ask(text: string, options: AskOptions): Promise<AskResult> {
    const started = performance.now();
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

    const decision = route({
      text: request,
      forced,
      followUpTier: this.#tier,
      learned: learner.routing(),
    });
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
      const result = await this.#streamOnce(model, tier, prompt, say, options.signal);
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
