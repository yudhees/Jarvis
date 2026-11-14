import path from 'node:path';
import {
  expandWindowsVars,
  LIVE_SETTINGS,
  loadConfig,
  readSettings,
  writeSettings,
} from '@jarvis/core/config';
import { WindowsSapiTts } from '@jarvis/core/tts';
import { readUsage } from '@jarvis/core/usage';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, nativeTheme, shell } from 'electron';
import type { Appearance } from './appearance.ts';
import type { PetPrefs } from './visibility.ts';

/**
 * The Settings window (tray > Settings): the pet's look (character or logo,
 * theme, colors, size), Jarvis's voice, listening timings, and pet behavior.
 *
 * Only a short allow-list of jarvis.yaml settings can be changed here
 * (EDITABLE_SETTINGS in core). Permission tiers, approvals, budgets, folders and
 * services stay in the config files, so this window can never loosen a guardrail.
 * Every IPC call is checked to come from this window, never from the pet.
 */

export type CoreStatus = 'running' | 'starting' | 'restarting' | 'stopped';

export interface SettingsDeps {
  srcDir: string;
  configDir: string;
  getAppearance(): Appearance;
  /** Applies and saves; returns what was stored. */
  setAppearance(patch: unknown): Appearance;
  /** Data URL of the current logo, or null. */
  getLogo(): string | null;
  /** Validates, re-encodes and saves a picked image; returns the stored logo or an error. */
  setLogo(dataUrl: unknown): { ok: true; logo: string } | { ok: false; error: string };
  clearLogo(): void;
  getBehavior(): PetPrefs & { startWithWindows: boolean };
  setBehavior(patch: unknown): void;
  coreStatus(): CoreStatus;
  startCore(): void;
  stopCore(): void;
  restartCore(): void;
  /** The pet stays on screen while settings are open, so changes can be seen. */
  onOpenChange(open: boolean): void;
}

const PREVIEW_MAX_CHARS = 200;

/** Jarvis's data folder (where core keeps usage totals). */
function dataDir(configDir: string): string {
  try {
    return loadConfig(configDir).jarvis.dataDir;
  } catch {
    return path.normalize(expandWindowsVars('%APPDATA%/jarvis'));
  }
}

let win: BrowserWindow | undefined;
let tts: WindowsSapiTts | undefined;

/** Tells an open Settings window that Jarvis started or stopped. */
export function pushSettingsStatus(status: CoreStatus): void {
  if (win && !win.isDestroyed()) win.webContents.send('settings:status', status);
}

export function openSettings(deps: SettingsDeps): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 640,
    minHeight: 520,
    title: 'Jarvis Settings',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12161f' : '#f6f7f9',
    webPreferences: {
      preload: path.join(deps.srcDir, 'preload', 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = undefined;
    // The voice host only runs while this window is open (keeps Jarvis light).
    void tts?.close();
    tts = undefined;
    deps.onOpenChange(false);
  });
  deps.onOpenChange(true);
  void win.loadFile(path.join(deps.srcDir, 'renderer', 'settings.html'));
}

/** Registers the window's IPC handlers once, at startup. */
export function registerSettingsIpc(deps: SettingsDeps): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // Only the Settings window may call these; the pet window cannot.
      if (!win || win.isDestroyed() || event.sender !== win.webContents) {
        throw new Error('not allowed');
      }
      return fn(...args);
    });
  };

  handle('settings:load', () => {
    let core: Record<string, unknown> | null = null;
    let coreError: string | null = null;
    try {
      core = readSettings(deps.configDir);
    } catch (err) {
      coreError = (err as Error).message;
    }
    return {
      appearance: deps.getAppearance(),
      logo: deps.getLogo(),
      behavior: deps.getBehavior(),
      core,
      coreError,
      live: [...LIVE_SETTINGS],
      coreStatus: deps.coreStatus(),
      configDir: deps.configDir,
    };
  });
  handle('settings:appearance', (patch) => deps.setAppearance(patch));
  handle('settings:logo', (dataUrl) => deps.setLogo(dataUrl));
  handle('settings:clear-logo', () => deps.clearLogo());
  handle('settings:behavior', (patch) => {
    deps.setBehavior(patch);
    return deps.getBehavior();
  });
  handle('settings:core', (patch) => writeSettings(deps.configDir, patch));
  handle('settings:voices', async () => {
    tts ??= new WindowsSapiTts({ voice: null, rate: 0, timeoutMs: 15000 });
    return tts.voices();
  });
  handle('settings:preview', async (voice, rate, text) => {
    const v = typeof voice === 'string' && voice.length > 0 && voice.length < 200 ? voice : null;
    const r = Number(rate);
    const sentence =
      typeof text === 'string' && text.trim() ? text.trim().slice(0, PREVIEW_MAX_CHARS) : 'Hello.';
    tts ??= new WindowsSapiTts({ voice: null, rate: 0, timeoutMs: 15000 });
    tts.setVoice(v, Number.isInteger(r) && r >= -10 && r <= 10 ? r : 0);
    const audio = await tts.synthesize(sentence);
    // Played by the window with Web Audio; never written to disk.
    return {
      sampleRate: audio.sampleRate,
      pcm: new Uint8Array(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength),
    };
  });
  handle('settings:start-core', () => {
    deps.startCore();
    return deps.coreStatus();
  });
  handle('settings:restart-core', () => {
    deps.restartCore();
    return deps.coreStatus();
  });
  handle('settings:stop-core', () => {
    deps.stopCore();
    return deps.coreStatus();
  });
  handle('settings:usage', (days) => {
    const n = Number(days);
    return readUsage(dataDir(deps.configDir), Number.isInteger(n) && n >= 1 && n <= 30 ? n : 14);
  });
  handle('settings:open-config', () => shell.openPath(deps.configDir));
}
