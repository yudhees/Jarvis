import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const PET_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'pet');

/**
 * Starts the desktop pet (Electron) and points it at core's bridge. Core keeps
 * working if the pet fails; it restarts the pet once if it exits unexpectedly
 * (CLAUDE.md 10.6).
 */
export class PetProcess {
  readonly #port: number;
  readonly #token: string;
  #child: ChildProcess | undefined;
  #restarts = 0;
  #stopping = false;
  readonly #onLog: (line: string) => void;

  constructor(port: number, token: string, onLog: (line: string) => void = () => {}) {
    this.#port = port;
    this.#token = token;
    this.#onLog = onLog;
  }

  start(): void {
    // The electron package exports the path to its executable.
    const electron = createRequire(path.join(PET_DIR, 'package.json'))('electron') as string;
    const child = spawn(electron, [PET_DIR], {
      cwd: PET_DIR,
      env: {
        ...process.env,
        JARVIS_CORE_PORT: String(this.#port),
        JARVIS_PET_TOKEN: this.#token,
        ELECTRON_ENABLE_LOGGING: undefined,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    this.#child = child;
    child.on('error', (err) => this.#onLog(`Pet could not start: ${err.message}`));
    child.on('exit', (code) => {
      if (this.#stopping) return;
      if (this.#restarts < 1) {
        this.#restarts++;
        this.#onLog(`Pet exited (${code}); restarting it once.`);
        this.start();
      } else {
        this.#onLog(`Pet exited (${code}). Jarvis keeps running without it.`);
      }
    });
  }

  stop(): void {
    this.#stopping = true;
    this.#child?.kill();
  }
}
