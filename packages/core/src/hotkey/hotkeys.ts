import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

export type HotkeyAction = 'stop' | 'mute' | 'talk';

const SCRIPT = path.join(import.meta.dirname, 'hotkey-host.ps1');

/**
 * Ctrl+Alt+J (stop), Ctrl+Alt+M (mute toggle) and Ctrl+Alt+L (talk), registered by core so they
 * work with the pet closed (CLAUDE.md 10.6). Runs a small PowerShell process
 * with a Windows message loop; no native Node module needed.
 */
export class WindowsHotkeys {
  #ps: ChildProcess | undefined;

  /** Starts listening. Resolves with the keys another program already owns. */
  start(onPress: (action: HotkeyAction) => void): Promise<HotkeyAction[]> {
    return new Promise((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      this.#ps = ps;
      const taken: HotkeyAction[] = [];
      let ready = false;
      ps.on('error', reject);
      ps.on('exit', (code) => {
        if (!ready) reject(new Error(`hotkey host exited early (${code})`));
      });
      createInterface({ input: ps.stdout as NodeJS.ReadableStream }).on('line', (raw) => {
        const line = raw.trim();
        if (line === 'ready') {
          ready = true;
          resolve(taken);
        } else if (line.startsWith('error ')) {
          taken.push(line.slice(6) as HotkeyAction);
        } else if (line === 'stop' || line === 'mute' || line === 'talk') {
          onPress(line);
        }
      });
    });
  }

  close(): void {
    this.#ps?.kill();
    this.#ps = undefined;
  }
}
