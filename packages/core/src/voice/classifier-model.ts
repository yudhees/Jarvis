import {
  CLASSIFIER_PROMPT,
  type Classification,
  type Classifier,
  parseClassification,
} from '../router/index.ts';
import type { ChatMessage, ReplyModel } from './conversation.ts';

/** Earlier classifications kept, so a warm CLI session is reused (pairs). */
const KEEP_MESSAGES = 16;

/**
 * The Haiku classifier (CLAUDE.md 7, rule 4) on top of any reply model: the
 * Claude CLI on the subscription, or the API. One request at a time.
 */
export class ReplyModelClassifier implements Classifier {
  readonly #model: ReplyModel;
  readonly #modelId: string;
  #history: ChatMessage[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(model: ReplyModel, modelId: string) {
    this.#model = model;
    this.#modelId = modelId;
  }

  classify(text: string): Promise<Classification | null> {
    const run = this.#queue.then(() => this.#classify(text));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #classify(text: string): Promise<Classification | null> {
    const messages: ChatMessage[] = [
      ...this.#history,
      { role: 'user', content: `Request: ${text.slice(0, 600)}` },
    ];
    let out = '';
    await this.#model.stream(
      { model: this.#modelId, system: CLASSIFIER_PROMPT, context: '', messages, maxTokens: 80 },
      (delta) => {
        out += delta;
      },
    );
    this.#history = [...messages, { role: 'assistant' as const, content: out.trim() }].slice(
      -KEEP_MESSAGES,
    );
    return parseClassification(out);
  }
}
