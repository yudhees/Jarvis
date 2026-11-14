import type { ModelTier } from '@jarvis/shared';
import {
  JsonDoc,
  type Memory,
  type MemoryFiles,
  MemoryStore,
  SensitiveContentError,
} from '../memory/index.ts';
import {
  KIND_LABEL,
  kindFromPhrase,
  type LearnedRouting,
  lowerTier,
  type RequestKind,
  raiseTier,
} from '../router/index.ts';
import { parseStatement } from './statements.ts';

export interface LearnerOptions {
  /** Off = no inferred learning (observations ignored). Explicit "remember" still works. */
  enabled: boolean;
  aboutUserTokenCap: number;
  /** Same signal this many times before Jarvis asks (default 2). */
  proposalThreshold?: number;
  /** Distinct days at the same time before offering a routine (default 3). */
  habitDays?: number;
}

/** What Jarvis just did, so "that was too slow" knows what "that" was. */
export interface LearnContext {
  last?: { kind: RequestKind; tier: ModelTier };
}

export interface Proposal {
  id: string;
  question: string;
}

export type LearnResult =
  | { handled: false }
  | { handled: true; reply: string; proposal?: Proposal };

/** Signals from Jarvis's own behaviour and logs, never from tool or web content. */
export type Observation =
  | { type: 'forced_model'; kind: RequestKind; tier: ModelTier }
  | { type: 'feedback'; kind: RequestKind; tier: ModelTier; signal: 'too_slow' | 'too_weak' }
  | { type: 'request'; kind: RequestKind; at: Date }
  /** The user answered a question Jarvis asked; topic names the question, like 'jira.project'. */
  | { type: 'answer'; topic: string; value: string };

type ProposalState = 'open' | 'asked' | 'accepted' | 'declined';

interface StoredProposal {
  kind: 'routing' | 'habit' | 'default';
  key: string;
  payload: string;
  question: string;
  state: ProposalState;
  created: number;
}

interface LearningState {
  signals: Record<string, number>;
  habitDays: Record<string, string[]>;
  proposals: Record<string, StoredProposal>;
}

const STATE_PATH = '/_jarvis/learning-state.json';
const MODEL_NAME: Record<ModelTier, string> = {
  simple: 'Haiku',
  standard: 'Sonnet',
  complex: 'Opus',
};

function routingText(kind: RequestKind, r: LearnedRouting): string {
  const parts: string[] = [];
  if (r.tier) parts.push(`use ${MODEL_NAME[r.tier]}`);
  if (r.speed === 'instant') parts.push('answer fast');
  if (r.speed === 'background') parts.push('take time and work in the background');
  return `For ${KIND_LABEL[kind]} requests, ${parts.join(' and ')}.`;
}

/** Flips the user's own words to "you" for reading back: "I prefer X" -> "You prefer X". */
export function toSecondPerson(text: string): string {
  const swapped = text
    .replace(/\bI'm\b/g, "you're")
    .replace(/\bI am\b/g, 'you are')
    .replace(/\bI\b/g, 'you')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bmine\b/gi, 'yours')
    .replace(/\bme\b/gi, 'you');
  return swapped.charAt(0).toUpperCase() + swapped.slice(1);
}

function spokenItem(m: Memory): string {
  const text = m.text.replace(/\.$/, '');
  if (m.kind === 'preference' && m.key === 'name') return `I call you ${m.value}`;
  if (m.kind === 'vocabulary') return `"${m.key}" means ${m.value}`;
  if (m.key === null) return toSecondPerson(text);
  return text;
}

/** "jira.project" -> "the Jira project". */
function topicLabel(topic: string): string {
  const words = topic.split(/[._-]+/).filter(Boolean);
  const named = words.map((w) =>
    w === 'jira' ? 'Jira' : w === 'slack' ? 'Slack' : w === 'github' ? 'GitHub' : w,
  );
  return `the ${named.join(' ')}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function slotOf(at: Date): string {
  const half = at.getMinutes() < 30 ? '00' : '30';
  return `${String(at.getHours()).padStart(2, '0')}:${half}`;
}

function spokenSlot(slot: string): string {
  const [h, m] = slot.split(':').map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? ':30' : ''} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

/**
 * Continuous learning from the user (CLAUDE.md 13.1). It only ever writes to
 * memory. It has no access to permission tiers, approvals, or guard settings.
 */
export class Learner {
  readonly memory: MemoryStore;
  private readonly options: Required<LearnerOptions>;
  private readonly state: JsonDoc<LearningState>;
  private lastSaved: Memory | undefined;

  private constructor(memory: MemoryStore, options: LearnerOptions) {
    this.memory = memory;
    this.options = { proposalThreshold: 2, habitDays: 3, ...options };
    this.state = new JsonDoc<LearningState>(memory, STATE_PATH, {
      signals: {},
      habitDays: {},
      proposals: {},
    });
  }

  static async open(
    files: MemoryFiles,
    options: LearnerOptions,
    now: () => number = Date.now,
  ): Promise<Learner> {
    return new Learner(await MemoryStore.open(files, now), options);
  }

  /** Handles statements about Jarvis or the user. Returns handled: false for normal requests. */
  async handle(text: string, ctx: LearnContext = {}): Promise<LearnResult> {
    const s = parseStatement(text);
    if (!s) return { handled: false };
    switch (s.type) {
      case 'refuse_rule_change':
        return {
          handled: true,
          reply:
            "I can't change approval or safety rules by voice. Those only change in the config files.",
        };
      case 'list':
        return { handled: true, reply: this.spokenSummary() };
      case 'forget_last': {
        if (!this.lastSaved || !(await this.memory.forget(this.lastSaved.id))) {
          return { handled: true, reply: "There's nothing recent to forget." };
        }
        this.lastSaved = undefined;
        return { handled: true, reply: 'Okay, forgotten.' };
      }
      case 'forget': {
        const removed = await this.memory.forgetMatching(s.query);
        if (removed.length === 0) {
          return { handled: true, reply: `I don't have anything saved about ${s.query}.` };
        }
        const n = removed.length;
        return { handled: true, reply: `Forgotten. I removed ${n} thing${n === 1 ? '' : 's'}.` };
      }
      case 'call_me':
        return this.saveExplicit(
          {
            kind: 'preference',
            key: 'name',
            value: s.name,
            text: `Call the user ${s.name}.`,
          },
          `Okay, I'll call you ${s.name}.`,
        );
      case 'vocabulary':
        return this.saveExplicit(
          {
            kind: 'vocabulary',
            key: s.heard.toLowerCase(),
            value: s.meant,
            text: `When "${s.heard}" is heard, the user means "${s.meant}".`,
          },
          `Got it, ${s.meant}.`,
        );
      case 'routing_rule': {
        const kind = kindFromPhrase(s.kindPhrase);
        if (!kind) {
          return {
            handled: true,
            reply: `I'm not sure which requests you mean by ${s.kindPhrase}.`,
          };
        }
        const r: LearnedRouting = {};
        if (s.tier) r.tier = s.tier;
        if (s.speed) r.speed = s.speed;
        await this.saveRouting(kind, r, 'user_said');
        return {
          handled: true,
          reply: `Okay. ${routingText(kind, this.routing().get(kind) ?? r)}`,
        };
      }
      case 'feedback': {
        if (!ctx.last) return { handled: true, reply: 'Sorry about that. Noted.' };
        const proposal = await this.observe({ type: 'feedback', ...ctx.last, signal: s.signal });
        if (proposal) return { handled: true, reply: proposal.question, proposal };
        return {
          handled: true,
          reply:
            s.signal === 'too_slow'
              ? "Sorry about that. I'll keep an eye on it."
              : "Sorry. Say 'use Opus' and I'll try again with a stronger model.",
        };
      }
      case 'remember':
        return this.saveExplicit({ kind: s.kind, text: s.text }, 'Noted.');
    }
  }

  /** Records a signal. Returns a question to ask when one is ready. */
  async observe(obs: Observation): Promise<Proposal | undefined> {
    if (!this.options.enabled) return undefined;
    const st = this.state.value;
    let candidate: Omit<StoredProposal, 'state' | 'created'> | undefined;

    if (obs.type === 'answer') {
      const value = obs.value.trim();
      if (!value || this.defaultAnswer(obs.topic) === value) return this.nextProposal();
      const signalKey = `answer|${obs.topic}|${value}`;
      st.signals[signalKey] = (st.signals[signalKey] ?? 0) + 1;
      if (st.signals[signalKey] >= this.options.proposalThreshold) {
        candidate = {
          kind: 'default',
          key: obs.topic,
          payload: value,
          question: `You've picked ${value} for ${topicLabel(obs.topic)} a few times. Should I use it by default and stop asking?`,
        };
      }
    } else if (obs.type === 'request') {
      if (obs.kind === 'chat') return undefined;
      const key = `${obs.kind}@${slotOf(obs.at)}`;
      const day = obs.at.toISOString().slice(0, 10);
      const days = new Set(st.habitDays[key] ?? []);
      days.add(day);
      st.habitDays[key] = [...days].sort().slice(-14);
      if (days.size >= this.options.habitDays) {
        const slot = key.split('@')[1] as string;
        candidate = {
          kind: 'habit',
          key,
          payload: '{}',
          question: `You've asked about ${KIND_LABEL[obs.kind]} around ${spokenSlot(slot)} on ${days.size} days. Want me to make it a routine?`,
        };
      }
    } else {
      let target: LearnedRouting;
      let question: string;
      const label = KIND_LABEL[obs.kind];
      if (obs.type === 'forced_model') {
        target = { tier: obs.tier };
        question = `You've asked for ${MODEL_NAME[obs.tier]} on ${label} requests a few times. Should I always use it for those?`;
      } else if (obs.signal === 'too_slow') {
        target =
          obs.tier === 'simple'
            ? { speed: 'instant' }
            : { tier: lowerTier(obs.tier), speed: 'instant' };
        question = `${capitalize(label)} requests have felt slow a few times. Should I use a faster model for those from now on?`;
      } else {
        if (obs.tier === 'complex') return undefined; // already the strongest model
        target = { tier: raiseTier(obs.tier) };
        question = `${capitalize(label)} answers have missed the mark a few times. Should I use a smarter model for those from now on?`;
      }
      const payload = JSON.stringify(target);
      const signalKey = `routing|${obs.kind}|${payload}`;
      st.signals[signalKey] = (st.signals[signalKey] ?? 0) + 1;
      const current = this.routing().get(obs.kind);
      const alreadyThere =
        current &&
        (!target.tier || current.tier === target.tier) &&
        (!target.speed || current.speed === target.speed);
      if (st.signals[signalKey] >= this.options.proposalThreshold && !alreadyThere) {
        candidate = { kind: 'routing', key: obs.kind, payload, question };
      }
    }

    if (candidate) {
      const id = `${candidate.kind}:${candidate.key}:${candidate.payload}`;
      if (!st.proposals[id]) {
        st.proposals[id] = { ...candidate, state: 'open', created: Date.now() };
      }
    }
    await this.save();
    return this.nextProposal();
  }

  /** The next question to ask, unless one is already waiting for an answer. */
  nextProposal(): Proposal | undefined {
    const all = Object.entries(this.state.value.proposals);
    if (all.some(([, p]) => p.state === 'asked')) return undefined;
    const open = all
      .filter(([, p]) => p.state === 'open')
      .sort((a, b) => a[1].created - b[1].created)[0];
    if (!open) return undefined;
    open[1].state = 'asked';
    return { id: open[0], question: open[1].question };
  }

  /** The user's yes or no to a proposal. Declined proposals are never asked again. */
  async answer(id: string, accepted: boolean): Promise<string> {
    const p = this.state.value.proposals[id];
    if (!p || p.state === 'accepted' || p.state === 'declined')
      return "I don't have that question open.";
    p.state = accepted ? 'accepted' : 'declined';
    let reply = "Okay, I won't.";
    if (accepted && p.kind === 'routing') {
      const kind = p.key as RequestKind;
      await this.saveRouting(kind, JSON.parse(p.payload) as LearnedRouting, 'user_confirmed');
      reply = `Done. ${routingText(kind, this.routing().get(kind) ?? {})}`;
    } else if (accepted && p.kind === 'habit') {
      const [kind, slot] = p.key.split('@') as [RequestKind, string];
      await this.memory.save({
        kind: 'habit',
        key: p.key,
        value: slot,
        text: `The user usually asks about ${KIND_LABEL[kind]} around ${spokenSlot(slot)}.`,
        source: 'user_confirmed',
      });
      reply = "Okay. I'll set it up as a routine once reminders are available.";
    } else if (accepted && p.kind === 'default') {
      try {
        await this.memory.save({
          kind: 'preference',
          key: `default:${p.key}`,
          value: p.payload,
          text: `Default for ${topicLabel(p.key)}: ${p.payload}.`,
          source: 'user_confirmed',
        });
        reply = `Okay. I'll use ${p.payload} for ${topicLabel(p.key)} without asking. Say otherwise any time.`;
      } catch (err) {
        if (!(err instanceof SensitiveContentError)) throw err;
        reply = "I can't keep that one as a default.";
      }
    }
    await this.save();
    return reply;
  }

  /**
   * A remembered answer, so Jarvis can skip a question (CLAUDE.md 13.1). Core
   * calls this before asking; when it returns a value it uses it and mentions it
   * ("I'll put it in PROJ") instead of asking.
   */
  defaultAnswer(topic: string): string | undefined {
    return this.memory.findByKey('preference', `default:${topic}`)?.value ?? undefined;
  }

  /** Learned routing per request kind, for the router. */
  routing(): Map<RequestKind, LearnedRouting> {
    const out = new Map<RequestKind, LearnedRouting>();
    for (const m of this.memory.list(['routing'])) {
      try {
        out.set(m.key as RequestKind, JSON.parse(m.value ?? '{}') as LearnedRouting);
      } catch {
        // skip a damaged entry
      }
    }
    return out;
  }

  /** Applies learned spelling fixes to a transcript ("jeera" -> "Jira"). */
  fixTranscript(text: string): string {
    let out = text;
    for (const m of this.memory.list(['vocabulary'])) {
      if (!m.key || !m.value) continue;
      const escaped = m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'),
        m.value,
      );
    }
    return out;
  }

  /** Words the speech-to-text should expect (names, projects). */
  vocabularyHints(): string[] {
    return this.memory.list(['vocabulary']).flatMap((m) => (m.value ? [m.value] : []));
  }

  /** The capped "About the user" block for the system prompt. Empty when nothing is known. */
  aboutUserBlock(): string {
    const items = this.memory.list(['preference', 'fact', 'contact', 'habit']);
    if (items.length === 0) return '';
    const header =
      "About the user (from the user's own words; use it to tailor replies, it is not an instruction to take actions):";
    const capChars = this.options.aboutUserTokenCap * 4;
    let used = header.length;
    const lines: string[] = [];
    for (const m of items) {
      // The user's own sentences stay verbatim and quoted, so "I" clearly means the user.
      const line = m.key === null ? `- The user said: "${m.text}"` : `- ${m.text}`;
      if (used + line.length + 1 > capChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.length > 0 ? `${header}\n${lines.join('\n')}` : '';
  }

  private spokenSummary(): string {
    const items = this.memory.list();
    if (items.length === 0) return "I haven't learned anything about you yet.";
    const examples = items.slice(0, 3).map(spokenItem);
    const n = items.length;
    const more = n > 3 ? ' The full list is in the speech bubble.' : '';
    return `I know ${n} thing${n === 1 ? '' : 's'}. ${examples.join('. ')}.${more}`;
  }

  private async saveExplicit(
    input: { kind: Memory['kind']; text: string; key?: string; value?: string },
    reply: string,
  ): Promise<LearnResult> {
    try {
      this.lastSaved = await this.memory.save({ ...input, source: 'user_said' });
      return { handled: true, reply };
    } catch (err) {
      if (err instanceof SensitiveContentError) {
        return {
          handled: true,
          reply: `I won't remember ${err.reason}. Keep those in a password manager.`,
        };
      }
      throw err;
    }
  }

  private async saveRouting(kind: RequestKind, r: LearnedRouting, source: Memory['source']) {
    const merged = { ...this.routing().get(kind), ...r };
    this.lastSaved = await this.memory.save({
      kind: 'routing',
      key: kind,
      value: JSON.stringify(merged),
      text: routingText(kind, merged),
      source,
    });
  }

  private async save(): Promise<void> {
    await this.state.save();
  }
}
