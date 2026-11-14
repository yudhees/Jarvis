import porcupine from '@picovoice/porcupine-node';

const { Porcupine } = porcupine;

export type Keyword = 'wake' | 'stop';

/** Hears fixed keywords in mic frames (CLAUDE.md 6.1). Behind an interface for tests. */
export interface KeywordSpotter {
  readonly frameLength: number;
  process(frame: Int16Array): Keyword | null;
  release(): void;
}

export interface PorcupineSpotterOptions {
  accessKey: string;
  /** Built-in keyword name ("jarvis") or a path to a Windows .ppn file. */
  wake: string;
  /** Optional "Jarvis stop" .ppn path. */
  stop: string | null;
  sensitivity: number;
}

/** One Porcupine instance listening for the wake keyword and, if set, the stop keyword. */
export class PorcupineSpotter implements KeywordSpotter {
  readonly #porcupine: InstanceType<typeof Porcupine>;
  readonly #labels: Keyword[];

  constructor(o: PorcupineSpotterOptions) {
    const keywords = [o.wake];
    this.#labels = ['wake'];
    if (o.stop) {
      keywords.push(o.stop);
      this.#labels.push('stop');
    }
    this.#porcupine = new Porcupine(
      o.accessKey,
      keywords,
      keywords.map(() => o.sensitivity),
    );
  }

  get frameLength(): number {
    return this.#porcupine.frameLength;
  }

  process(frame: Int16Array): Keyword | null {
    const i = this.#porcupine.process(frame);
    return i >= 0 ? (this.#labels[i] ?? null) : null;
  }

  release(): void {
    this.#porcupine.release();
  }
}
