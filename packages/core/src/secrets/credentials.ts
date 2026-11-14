import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/** Keys Jarvis knows about. Stored as "jarvis:<name>" in Windows Credential Manager. */
export const SECRET_NAMES = ['anthropic', 'picovoice'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const SECRET_HELP: Record<SecretName, string> = {
  anthropic: 'Anthropic API key (console.anthropic.com > API keys)',
  picovoice: 'Picovoice AccessKey (console.picovoice.ai)',
};

const SCRIPT = path.join(import.meta.dirname, 'credman.ps1');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name);
}

/**
 * Reads a key from Credential Manager into memory. Returns undefined when it is
 * not saved. The value is never logged or written anywhere.
 */
export function readSecret(name: SecretName): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [...PS_ARGS, '-Read', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let err = '';
    ps.stdout.on('data', (b: Buffer) => out.push(b));
    ps.stderr.on('data', (b: Buffer) => {
      err += b.toString();
    });
    ps.on('error', reject);
    ps.on('close', (code) => {
      const value = Buffer.concat(out).toString('utf8');
      if (code === 3) resolve(undefined);
      else if (code === 0 && value) resolve(value);
      else
        reject(
          new Error(`Credential Manager read failed (exit ${code}): ${err.trim().split('\n')[0]}`),
        );
    });
  });
}

/**
 * Asks for a key with a hidden prompt in this terminal and saves it. The key goes
 * straight from the keyboard into PowerShell; Node never sees it.
 */
export function promptAndSaveSecret(name: SecretName): boolean {
  const r = spawnSync(
    'powershell.exe',
    [...PS_ARGS.filter((a) => a !== '-NonInteractive'), '-Set', name],
    {
      stdio: 'inherit',
    },
  );
  return r.status === 0;
}
