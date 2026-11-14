import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { encodeWav } from '../audio/wav.ts';
import type { SttProvider, TranscribeOptions, Transcript } from './types.ts';

export interface WhisperCppOptions {
  serverExe: string;
  modelPath: string;
  port: number;
  threads: number;
  language: string;
  /** How long to wait for the model to load. */
  startTimeoutMs?: number;
  /**
   * Stop the server after this long without a request, to give its memory back
   * (about 140 MB with the base model). It restarts in well under a second.
   * 0 keeps it running.
   */
  idleStopMs?: number;
}

/** Written by `npm run setup-whisper`. */
export interface WhisperInstall {
  build: string;
  server: string;
  cli: string;
}

export function installFile(dataDir: string): string {
  return path.join(dataDir, 'whisper', 'install.json');
}

/** Finds the installed server and model, or explains how to install them. */
export function resolveWhisper(
  dataDir: string,
  model: string,
): { serverExe: string; modelPath: string } {
  const file = installFile(dataDir);
  const modelPath = path.join(dataDir, 'models', model);
  if (!existsSync(file)) throw new Error('Whisper is not installed. Run: npm run setup-whisper');
  const install = JSON.parse(readFileSync(file, 'utf8')) as WhisperInstall;
  if (!existsSync(install.server)) {
    throw new Error(`Whisper server is missing (${install.server}). Run: npm run setup-whisper`);
  }
  if (!existsSync(modelPath)) {
    throw new Error(`Model ${model} is missing. Run: npm run setup-whisper -- --model ${model}`);
  }
  return { serverExe: install.server, modelPath };
}

/** Whisper writes these for silence or noise; they are not words the user said. */
// Any [label], (label) or *label*: Whisper's descriptions of sound, like
// "[BLANK_AUDIO]", "(speaking in foreign language)" or "*coughs*".
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;

export function cleanTranscript(raw: string): string {
  return raw.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * whisper.cpp running on this PC (CLAUDE.md 4). Starts `whisper-server` once,
 * bound to 127.0.0.1, so the model stays loaded and each request is fast. Audio
 * is sent in memory and never written to disk (10.4).
 */
export class WhisperCppStt implements SttProvider {
  private readonly options: WhisperCppOptions;
  private proc: ChildProcess | undefined;
  private ready: Promise<void> | undefined;
  private stderrTail = '';
  private idleTimer: NodeJS.Timeout | undefined;

  /** True while the server process (and the model in memory) is up. */
  get running(): boolean {
    return this.proc !== undefined;
  }

  private scheduleIdleStop(): void {
    clearTimeout(this.idleTimer);
    const ms = this.options.idleStopMs ?? 0;
    if (ms > 0) this.idleTimer = setTimeout(() => void this.close(), ms);
  }

  constructor(options: WhisperCppOptions) {
    this.options = options;
  }

  private get url(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  /** Starts the server (once) and waits until the model is loaded. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const o = this.options;
      const proc = spawn(
        o.serverExe,
        [
          '-m',
          o.modelPath,
          '--host',
          '127.0.0.1',
          '--port',
          String(o.port),
          '-t',
          String(o.threads),
          '-l',
          o.language,
          '-nt',
          '-ng',
        ],
        { windowsHide: true, cwd: path.dirname(o.serverExe) },
      );
      this.proc = proc;
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.setEncoding('utf8');
      const keep = (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-1500);
      };
      proc.stderr?.on('data', keep);
      proc.stdout?.on('data', keep);

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.ready = undefined;
        reject(err);
      };
      proc.on('error', (err) => fail(new Error(`whisper-server failed to start: ${err.message}`)));
      proc.on('exit', (code) => {
        this.proc = undefined;
        this.ready = undefined;
        fail(
          new Error(
            `whisper-server exited (code ${code}). ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}`,
          ),
        );
      });

      const deadline = Date.now() + (o.startTimeoutMs ?? 30000);
      const poll = async () => {
        if (settled) return;
        try {
          const res = await fetch(`${this.url}/`, { signal: AbortSignal.timeout(1000) });
          await res.body?.cancel();
          settled = true;
          resolve();
          return;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) {
          proc.kill();
          fail(new Error('whisper-server did not start in time'));
          return;
        }
        setTimeout(poll, 150);
      };
      void poll();
    });
    return this.ready;
  }

  async transcribe(
    pcm: Int16Array,
    sampleRate: number,
    options: TranscribeOptions = {},
  ): Promise<Transcript> {
    if (sampleRate !== 16000) throw new Error('whisper.cpp expects 16 kHz audio');
    if (pcm.length < sampleRate * 0.3) return { text: '', ms: 0 }; // under 0.3 s: nothing to hear
    clearTimeout(this.idleTimer);
    await this.start();
    const t0 = performance.now();
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(encodeWav(pcm, sampleRate))], { type: 'audio/wav' }),
      'audio.wav',
    );
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    if (options.hints && options.hints.length > 0) {
      form.append('prompt', options.hints.slice(0, 40).join(', '));
    }
    const res = await fetch(`${this.url}/inference`, {
      method: 'POST',
      body: form,
      signal: options.signal ?? AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`whisper-server returned HTTP ${res.status}`);
    const body = (await res.json()) as { text?: unknown; error?: unknown };
    if (typeof body.error === 'string') throw new Error(`whisper-server: ${body.error}`);
    const text = cleanTranscript(typeof body.text === 'string' ? body.text : '');
    this.scheduleIdleStop();
    return { text, ms: Math.round(performance.now() - t0) };
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill();
    await exited;
  }
}
