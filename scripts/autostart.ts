/**
 * Start Jarvis when you sign in to Windows (hidden, no console window).
 *
 *   npm run autostart -- on       add it to your Startup folder
 *   npm run autostart -- off      remove it
 *   npm run autostart             show whether it is on
 *
 * Run this from your own terminal, not through the Claude desktop app (that app
 * is packaged, so Windows would hide the file in a private folder).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@jarvis/core/config';

const ROOT = path.resolve(import.meta.dirname, '..');
const appData = process.env.APPDATA;
if (!appData) throw new Error('APPDATA is not set');
const startup = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const launcher = path.join(startup, 'Jarvis.vbs');
const logFile = path.join(loadConfig().jarvis.dataDir, 'logs', 'jarvis.log');

/** VBScript string literal. */
const vbs = (s: string) => `"${s.replace(/"/g, '""')}"`;

const mode = process.argv[2] ?? 'status';
if (mode === 'on') {
  mkdirSync(startup, { recursive: true });
  const command = [process.execPath, path.join(ROOT, 'scripts', 'supervisor.ts'), '--log', logFile]
    .map((p) => `""${p}""`)
    .join(' ');
  writeFileSync(
    launcher,
    [
      "' Starts Jarvis at sign-in (created by: npm run autostart -- on).",
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = ${vbs(ROOT)}`,
      `sh.Run "${command}", 0, False`,
      '',
    ].join('\r\n'),
  );
  console.log(
    `On. Jarvis will start when you sign in.\n  launcher: ${launcher}\n  log:      ${logFile}`,
  );
  console.log('To start it now without signing out: npm run jarvis');
} else if (mode === 'off') {
  rmSync(launcher, { force: true });
  console.log('Off. Jarvis will no longer start at sign-in.');
} else {
  console.log(existsSync(launcher) ? `On (${launcher}).` : 'Off.');
}
