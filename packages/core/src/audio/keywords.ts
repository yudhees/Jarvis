import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import porcupine from '@picovoice/porcupine-node';

const { Porcupine } = porcupine;

export type Keyword = 'wake' | 'stop';

export interface KeywordHit {
  keyword: Keyword;
  /**
   * Set when the request was said in the same breath ("Jarvis, what's the
   * time"): the mic sample where the phrase began, counted from the first frame
   * given to `process`. The loop replays the audio from there.
   */
  startSample?: number;
}

/** Hears fixed keywords in mic frames (CLAUDE.md 6.1). Behind an interface for tests. */
export interface KeywordSpotter {
  process(frame: Int16Array): KeywordHit | null;
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

  process(frame: Int16Array): KeywordHit | null {
    const i = this.#porcupine.process(frame);
    const keyword = i >= 0 ? this.#labels[i] : undefined;
    return keyword ? { keyword } : null;
  }

  release(): void {
    this.#porcupine.release();
  }
}

const HOST = path.join(import.meta.dirname, 'winspeech-keywords.ps1');

/** Parses one line from the Windows keyword host. */
export function parseKeywordLine(line: string, sampleRate: number): KeywordHit | null {
  const m = /^(wake|stop) ([\d.]+) (-?[\d.]+) (.*)$/.exec(line.trim());
  if (!m) return null;
  const keyword = m[1] as Keyword;
  const startSeconds = Number(m[3]);
  const text = (m[4] ?? '').trim().toLowerCase();
  // Only the wake phrase on its own: the request comes next, nothing to replay.
  const alone = /^(?:(?:hey|hi|okay|ok)\s+)?jarvis$/.test(text);
  if (keyword === 'stop' || alone || startSeconds < 0) return { keyword };
  return { keyword, startSample: Math.round(startSeconds * sampleRate) };
}

/**
 * Wake and stop keywords with the speech recognizer built into Windows
 * (System.Speech): no download, no account. Mic frames are piped to a small
 * PowerShell host; ordinary speech is matched against dictation and ignored
 * unless it starts with "Jarvis". Hits arrive a moment after the phrase ends.
 */
export class WindowsKeywordSpotter implements KeywordSpotter {
  readonly #sampleRate: number;
  readonly #minConfidence: number;
  readonly #hits: KeywordHit[] = [];
  #ps: ChildProcess | undefined;
  #dead = false;

  constructor(options: { sampleRate: number; minConfidence: number }) {
    this.#sampleRate = options.sampleRate;
    this.#minConfidence = options.minConfidence;
  }

  /** Starts the recognizer (about 0.7 s). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          HOST,
          '-MinConfidence',
          String(this.#minConfidence),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      this.#ps = ps;
      let ready = false;
      let stderr = '';
      ps.stderr?.on('data', (b: Buffer) => {
        stderr = (stderr + b.toString()).slice(-1000);
      });
      ps.stdin?.on('error', () => {
        this.#dead = true;
      });
      ps.on('error', (err) => {
        this.#dead = true;
        if (!ready) reject(err);
      });
      ps.on('exit', (code) => {
        this.#dead = true;
        if (!ready)
          reject(new Error(`Windows speech recognizer did not start (${code}): ${stderr.trim()}`));
      });
      createInterface({ input: ps.stdout as NodeJS.ReadableStream }).on('line', (line) => {
        if (line.trim() === 'ready') {
          ready = true;
          resolve();
          return;
        }
        const hit = parseKeywordLine(line, this.#sampleRate);
        if (hit) this.#hits.push(hit);
      });
    });
  }

  process(frame: Int16Array): KeywordHit | null {
    if (!this.#dead) {
      this.#ps?.stdin?.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    }
    return this.#hits.shift() ?? null;
  }

  release(): void {
    this.#dead = true;
    this.#ps?.kill();
    this.#ps = undefined;
  }
}
