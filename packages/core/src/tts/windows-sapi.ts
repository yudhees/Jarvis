import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { TtsAudio, TtsProvider } from './types.ts';

const SAMPLE_RATE = 16000;
const HOST_SCRIPT = path.join(import.meta.dirname, 'sapi-host.ps1');

export interface WindowsSapiOptions {
  /** Voice name, or null for the Windows default. */
  voice: string | null;
  /** -10 (slow) .. 10 (fast). */
  rate: number;
  timeoutMs: number;
}

interface Pending {
  resolve: (audio: TtsAudio) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type HostMessage =
  | { type: 'ready'; voices: string[] | string | null }
  | { type: 'done'; id: number; pcm: string }
  | { type: 'error'; id: number | null; message: string };

/**
 * Windows built-in voices through one long-lived Windows PowerShell process.
 * Starting PowerShell per reply costs hundreds of milliseconds, so the host
 * starts once (lazily) and is restarted only if it dies.
 */
export class WindowsSapiTts implements TtsProvider {
  private options: WindowsSapiOptions;
  private proc: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<string[]> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = '';

  constructor(options: WindowsSapiOptions) {
    this.options = options;
  }

  /** Changes the voice for the next sentence (Settings window, jarvis.yaml reload). */
  setVoice(voice: string | null, rate: number): void {
    this.options = { ...this.options, voice, rate };
  }

  /** Installed, enabled voice names. */
  voices(): Promise<string[]> {
    return this.ensureStarted();
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<TtsAudio> {
    if (text.trim().length === 0) return { sampleRate: SAMPLE_RATE, pcm: new Int16Array(0) };
    signal?.throwIfAborted();
    await this.ensureStarted();
    // The abort may have happened while waiting for the host; the listener below
    // would never fire for an already-aborted signal.
    signal?.throwIfAborted();
    const proc = this.proc;
    if (!proc) throw new Error('TTS host is not running');

    const id = this.nextId++;
    return new Promise<TtsAudio>((resolve, reject) => {
      const onAbort = () => {
        this.settle(id)?.reject(signal?.reason ?? new Error('aborted'));
      };
      const timer = setTimeout(() => {
        this.settle(id)?.reject(new Error(`TTS timed out after ${this.options.timeoutMs} ms`));
      }, this.options.timeoutMs);
      this.pending.set(id, {
        resolve: (audio) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(audio);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      const request = { id, text, voice: this.options.voice, rate: this.options.rate };
      proc.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  private ensureStarted(): Promise<string[]> {
    if (this.ready) return this.ready;
    this.ready = new Promise<string[]>((resolveReady, rejectReady) => {
      const proc = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          HOST_SCRIPT,
        ],
        { windowsHide: true },
      );
      this.proc = proc;
      this.stderrTail = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      });

      const lines = createInterface({ input: proc.stdout });
      lines.on('line', (line) => {
        let msg: HostMessage;
        try {
          msg = JSON.parse(line) as HostMessage;
        } catch {
          return; // ignore stray output
        }
        if (msg.type === 'ready') {
          const v = msg.voices;
          resolveReady(Array.isArray(v) ? v : v ? [v] : []);
        } else if (msg.type === 'done') {
          const bytes = Buffer.from(msg.pcm, 'base64');
          // Copy into a fresh, aligned buffer for Int16Array.
          const pcm = new Int16Array(new Uint8Array(bytes).buffer, 0, Math.floor(bytes.length / 2));
          this.settle(msg.id)?.resolve({ sampleRate: SAMPLE_RATE, pcm });
        } else if (msg.type === 'error' && msg.id !== null) {
          this.settle(msg.id)?.reject(new Error(`TTS failed: ${msg.message}`));
        }
      });

      const onGone = (reason: string) => {
        if (this.proc !== proc) return;
        this.proc = undefined;
        this.ready = undefined;
        const detail = this.stderrTail.trim();
        const err = new Error(`TTS host ${reason}${detail ? `: ${detail}` : ''}`);
        rejectReady(err);
        for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
      };
      proc.on('error', (err) => onGone(`failed to start (${err.message})`));
      proc.on('exit', (code) => onGone(`exited with code ${code}`));
    });
    return this.ready;
  }
}
