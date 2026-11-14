import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CoreToPetEvent, JarvisState, PetToCoreEvent } from '@jarvis/shared';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type NativeImage,
  nativeImage,
  type Rectangle,
  screen,
  shell,
  Tray,
} from 'electron';
import {
  type Appearance,
  checkLogoDataUrl,
  DEFAULT_APPEARANCE,
  inkFor,
  parseAppearance,
} from './appearance.ts';
import { CoreLink } from './core-link.ts';
import {
  DEMO_PROJECT_QUESTION,
  DEMO_TITLE_QUESTION,
  demoFinish,
  demoNoAnswer,
  demoScript,
  demoTitleQuestion,
  playScript,
} from './demo.ts';
import { cleanAnswer } from './events.ts';
import {
  openSettings,
  pushSettingsStatus,
  pushVoiceTest,
  registerSettingsIpc,
  type SettingsDeps,
} from './settings-window.ts';
import { trayIcon } from './tray-icon.ts';
import { type PetPrefs, parsePrefs, visibilityFor } from './visibility.ts';

/**
 * The Jarvis pet (CLAUDE.md 11): a small transparent window that sits above the
 * taskbar, shows what Jarvis is doing, and never takes focus. It only displays
 * events. It sends core only stop / mute / unmute / quit and answers to questions
 * (input_reply / input_cancel), which core never treats as approvals.
 */

const WIDTH = 340;
const HEIGHT = 460;
const MARGIN = 12;
const SRC = path.resolve(import.meta.dirname, '..');
const REPO_DIR = path.resolve(SRC, '..', '..', '..');
const CONFIG_DIR = path.join(REPO_DIR, 'config');
const CORE_START_TIMEOUT_MS = 45000;

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let link: CoreLink | undefined;
let connected = false;
let state: JarvisState = 'SLEEPING';
let muted = false;
let stopDemo: (() => void) | undefined;
let dragTimer: NodeJS.Timeout | undefined;
let openInput: string | undefined;
let inputTimer: NodeJS.Timeout | undefined;
let demoProject = '';
let prefs: PetPrefs = parsePrefs(undefined);
let manuallyHidden = false;
let hideTimer: NodeJS.Timeout | undefined;
let petVisible = false;
let appearance: Appearance = DEFAULT_APPEARANCE;
let logo: string | null = null; // data URL of logo.png
let settingsOpen = false;
let coreStarting: NodeJS.Timeout | undefined;

/** Where core's bridge is, from the environment core started us with. */
function coreFromEnv(): { port: number; token: string } | undefined {
  return parseCoreAddress({
    port: Number(process.env.JARVIS_CORE_PORT),
    token: process.env.JARVIS_PET_TOKEN,
  });
}

function parseCoreAddress(data: unknown): { port: number; token: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { port, token } = data as { port?: unknown; token?: unknown };
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return undefined;
  return { port, token };
}

// The pet no longer starts itself with Windows (Jarvis starts it); undo an
// older setting that would put a lone pet on the desktop at sign-in.
if (app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: false });

// Started by core: if core ends without closing us (crash, closed terminal),
// quit too, so no pet is left on the desktop with nothing behind it.
if (coreFromEnv()) {
  const core = process.ppid;
  setInterval(() => {
    try {
      process.kill(core, 0); // only checks that it still exists
    } catch {
      app.quit();
    }
  }, 3000).unref();
}

// One pet at a time. A second copy started by a new core hands over the core
// address, and this pet reconnects to it (see 'second-instance' below).
// A separate profile lets a second copy run beside the real pet (screenshots, checks).
if (process.env.JARVIS_PET_PROFILE) app.setPath('userData', process.env.JARVIS_PET_PROFILE);
const isPrimaryPet = app.requestSingleInstanceLock(coreFromEnv() ?? {});
if (!isPrimaryPet) app.quit();

// Keep the pet light: it draws a few SVG shapes, so it needs no GPU process,
// a small JavaScript heap, and none of Chromium's background extras.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=48');
app.commandLine.appendSwitch(
  'disable-features',
  'SpareRendererForSitePerProcess,CalculateNativeWinOcclusion,MediaRouter,Translate',
);
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ---------- position: remembered, and always kept on a screen ----------

const positionFile = () => path.join(app.getPath('userData'), 'pet-position.json');

function defaultPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - WIDTH - MARGIN, y: area.y + area.height - HEIGHT };
}

function clampToScreen(x: number, y: number): { x: number; y: number } {
  const display = screen.getDisplayMatching({ x, y, width: WIDTH, height: HEIGHT });
  const a: Rectangle = display.workArea;
  return {
    x: Math.min(Math.max(x, a.x - WIDTH + 120), a.x + a.width - 120),
    y: Math.min(Math.max(y, a.y), a.y + a.height - HEIGHT),
  };
}

function loadPosition(): { x: number; y: number } {
  try {
    const p = JSON.parse(readFileSync(positionFile(), 'utf8')) as { x: number; y: number };
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return clampToScreen(p.x, p.y);
  } catch {
    // first run
  }
  return defaultPosition();
}

function savePosition(): void {
  if (!win) return;
  const [x, y] = win.getPosition() as [number, number];
  try {
    writeFileSync(positionFile(), JSON.stringify({ x, y }));
  } catch {
    // not important enough to fail over
  }
}

function keepOnScreen(): void {
  if (!win) return;
  const [x, y] = win.getPosition() as [number, number];
  const p = clampToScreen(x, y);
  win.setPosition(p.x, p.y);
}

// ---------- pet settings (hide when idle) ----------

const prefsFile = () => path.join(app.getPath('userData'), 'pet-settings.json');

function loadPrefs(): void {
  try {
    prefs = parsePrefs(JSON.parse(readFileSync(prefsFile(), 'utf8')));
  } catch {
    prefs = parsePrefs(undefined);
  }
}

function savePrefs(): void {
  try {
    writeFileSync(prefsFile(), JSON.stringify(prefs));
  } catch {
    // keep going with in-memory settings
  }
}

// ---------- appearance (Settings window): look, logo, theme, colors, size ----------

const appearanceFile = () => path.join(app.getPath('userData'), 'pet-appearance.json');
const logoFile = () => path.join(app.getPath('userData'), 'logo.png');
const LOGO_MAX_SIDE = 256;

function loadAppearance(): void {
  try {
    appearance = parseAppearance(JSON.parse(readFileSync(appearanceFile(), 'utf8')));
  } catch {
    appearance = DEFAULT_APPEARANCE;
  }
  try {
    const png = nativeImage.createFromPath(logoFile());
    logo = png.isEmpty() ? null : png.toDataURL();
  } catch {
    logo = null;
  }
  if (appearance.look === 'logo' && !logo) appearance = { ...appearance, look: 'robot' };
}

function saveAppearance(): void {
  try {
    writeFileSync(appearanceFile(), JSON.stringify(appearance));
  } catch {
    // keep going with in-memory settings
  }
}

/** What the pet window needs to draw itself; colors already checked as #rrggbb. */
function sendAppearance(): void {
  win?.webContents.send('pet:appearance', {
    look: appearance.look,
    theme: appearance.theme,
    accent: appearance.accent,
    accentInk: appearance.accent ? inkFor(appearance.accent) : null,
    glow: appearance.glow,
    size: appearance.size,
    logo: appearance.look === 'logo' ? logo : null,
  });
  updateTray();
}

/** Decodes a picked image and stores it as a fresh, small PNG (only pixels survive). */
function storeLogo(dataUrl: unknown): { ok: true; logo: string } | { ok: false; error: string } {
  const checked = checkLogoDataUrl(dataUrl);
  if (!checked) return { ok: false, error: 'Pick a PNG or JPEG image under 2 MB.' };
  let image = nativeImage.createFromDataURL(checked);
  if (image.isEmpty()) return { ok: false, error: 'That image could not be read.' };
  const { width, height } = image.getSize();
  if (width < 16 || height < 16) return { ok: false, error: 'The image is too small.' };
  if (Math.max(width, height) > LOGO_MAX_SIDE) {
    image =
      width >= height
        ? image.resize({ width: LOGO_MAX_SIDE, quality: 'best' })
        : image.resize({ height: LOGO_MAX_SIDE, quality: 'best' });
  }
  try {
    writeFileSync(logoFile(), image.toPNG());
  } catch (err) {
    return { ok: false, error: `Could not save the logo: ${(err as Error).message}` };
  }
  logo = image.toDataURL();
  appearance = { ...appearance, look: 'logo' };
  saveAppearance();
  sendAppearance();
  return { ok: true, logo };
}

function removeLogo(): void {
  rmSync(logoFile(), { force: true });
  logo = null;
  if (appearance.look === 'logo') appearance = { ...appearance, look: 'robot' };
  saveAppearance();
  sendAppearance();
}

function currentTrayIcon(isMuted: boolean): NativeImage {
  if (!isMuted && logo && appearance.logoInTray) {
    const image = nativeImage.createFromDataURL(logo);
    if (!image.isEmpty()) return image.resize({ width: 32, height: 32, quality: 'best' });
  }
  return trayIcon(isMuted);
}

// ---------- starting and stopping Jarvis core (Settings window, tray) ----------

type CoreStatus = 'running' | 'starting' | 'restarting' | 'stopped';
function coreStatus(): CoreStatus {
  if (connected && !restarting) return 'running';
  if (restarting) return 'restarting';
  return coreStarting ? 'starting' : 'stopped';
}

/** Set while a restart is under way; gives up after RESTART_TIMEOUT_MS. */
let restarting: NodeJS.Timeout | undefined;
const RESTART_TIMEOUT_MS = 60000;

function endRestart(): void {
  clearTimeout(restarting);
  restarting = undefined;
  statusChanged();
}

/**
 * Stops core cleanly, then starts it again once it is gone. The old core holds
 * the one-Jarvis lock until it has closed its helpers, so a start that exits at
 * once is retried every second until the restart times out.
 */
function restartCore(): void {
  if (restarting || coreStarting) return;
  if (!connected) {
    startCore();
    return;
  }
  restarting = setTimeout(endRestart, RESTART_TIMEOUT_MS);
  stopCore();
  statusChanged();
}

/** Called when the link to core drops during a restart. */
function continueRestart(): void {
  link?.stop(); // the old core is going away; the new one hands over its own address
  link = undefined;
  setTimeout(() => startCore({ retryWhileRestarting: true }), 1000);
}

function statusChanged(): void {
  updateTray();
  pushSettingsStatus(coreStatus());
}

/**
 * Starts core the same way `npm start` does, without a console window. Core
 * then opens its own pet, which hands its address to this pet (one pet at a
 * time), so this pet connects to it.
 */
function startCore(options: { retryWhileRestarting?: boolean } = {}): void {
  if (connected || coreStarting) return;
  const done = () => {
    clearTimeout(coreStarting);
    coreStarting = undefined;
    if (options.retryWhileRestarting && restarting && !connected) {
      setTimeout(() => startCore(options), 1000); // the old Jarvis is still closing
      return;
    }
    statusChanged();
  };
  coreStarting = setTimeout(done, CORE_START_TIMEOUT_MS);
  try {
    const child = spawn('node', [path.join('packages', 'core', 'src', 'main.ts')], {
      cwd: REPO_DIR,
      detached: true,
      stdio: 'ignore', // core's console shows transcripts; nothing is written to disk
      windowsHide: true,
    });
    child.once('error', done);
    child.once('exit', done); // e.g. Jarvis was already running, or bad config
    child.unref();
  } catch {
    done();
    return;
  }
  statusChanged();
}

/** Asks core to quit (cancels any task first). The pet stays open. */
function stopCore(): void {
  if (connected) link?.send({ type: 'quit' });
}

// ---------- showing and hiding ----------

function showPet(): void {
  clearTimeout(hideTimer);
  if (!win) return;
  if (!petVisible) {
    petVisible = true;
    win.showInactive();
    win.webContents.send('pet:visibility', true);
  }
  updateTray();
}

function hidePet(): void {
  clearTimeout(hideTimer);
  if (!win || !petVisible) return;
  petVisible = false;
  win.webContents.send('pet:visibility', false); // fade out first
  hideTimer = setTimeout(() => {
    if (!petVisible) win?.hide();
  }, 350);
  updateTray();
}

function applyVisibility(): void {
  // While Settings is open the pet stays up, so changes can be seen on it.
  if (settingsOpen) {
    showPet();
    return;
  }
  const v = visibilityFor(state, manuallyHidden, prefs);
  if (v.action === 'show') {
    if (v.clearManualHide) manuallyHidden = false;
    showPet();
  } else if (v.action === 'hide') {
    hidePet();
  } else {
    showPet();
    hideTimer = setTimeout(hidePet, v.afterMs);
  }
}

// ---------- questions from Jarvis (input requests) ----------

function closeInput(): void {
  clearTimeout(inputTimer);
  openInput = undefined;
  // Typing needs focus; outside a question the pet never takes focus.
  win?.setFocusable(false);
}

// ---------- events into the window ----------

function show(event: CoreToPetEvent): void {
  if (event.type === 'voice_test_result') {
    pushVoiceTest(event); // for the Settings window only, not the pet
    return;
  }
  if (event.type === 'state') {
    state = event.state;
    if (state !== 'AWAITING_INPUT' && openInput) closeInput();
    applyVisibility();
    updateTray();
  } else if (event.type === 'input_request') {
    openInput = event.id;
    // Focusable, but not focused: clicking the text box gives it focus, so the
    // pet never steals the keyboard from what the user is doing.
    win?.setFocusable(true);
    if (!connected) {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => demoAnswerTimeout(event.id), 30000);
    }
  } else if (event.type === 'input_closed' && event.id === openInput) {
    closeInput();
  }
  win?.webContents.send('pet:event', event);
}

function toCore(event: PetToCoreEvent): void {
  if (connected && link?.send(event)) return;
  // Demo mode: act locally.
  if (event.type === 'input_reply') {
    demoAnswer(event.id, event.value);
  } else if (event.type === 'input_cancel') {
    stopDemo?.();
    closeInput();
    show({ type: 'input_closed', id: event.id });
    show({ type: 'reply_text', text: 'Okay, stopped. Nothing was created.' });
    show({ type: 'state', state: 'SLEEPING' });
  } else if (event.type === 'stop') {
    closeInput();
    stopDemo?.();
    stopDemo = undefined;
    show({ type: 'state', state: muted ? 'MUTED' : 'SLEEPING' });
  } else if (event.type === 'mute') {
    stopDemo?.();
    muted = true;
    show({ type: 'state', state: 'MUTED' });
  } else if (event.type === 'unmute') {
    muted = false;
    show({ type: 'state', state: 'SLEEPING' });
  }
}

function playDemo(): void {
  if (connected) return;
  stopDemo?.();
  closeInput();
  muted = false;
  stopDemo = playScript(demoScript(), show);
}

function demoAnswer(id: string, value: string): void {
  closeInput();
  stopDemo?.();
  if (id === DEMO_PROJECT_QUESTION) {
    demoProject = value;
    stopDemo = playScript(demoTitleQuestion(value), show);
  } else if (id === DEMO_TITLE_QUESTION) {
    stopDemo = playScript(demoFinish(demoProject || 'PROJ', value), show);
  }
}

function demoAnswerTimeout(id: string): void {
  if (openInput !== id) return;
  closeInput();
  stopDemo?.();
  stopDemo = playScript(demoNoAnswer(id), show);
}

// ---------- tray ----------

const STATE_LABEL: Record<JarvisState, string> = {
  SLEEPING: 'Sleeping',
  LISTENING: 'Listening',
  THINKING: 'Thinking',
  AWAITING_APPROVAL: 'Waiting for your OK',
  AWAITING_INPUT: 'Waiting for your answer',
  SPEAKING: 'Speaking',
  FOLLOW_UP: 'Listening for a follow-up',
  MUTED: 'Muted',
  ERROR: 'Something went wrong',
};

function updateTray(): void {
  if (!tray) return;
  const isMuted = state === 'MUTED';
  tray.setImage(currentTrayIcon(isMuted));
  tray.setToolTip(`Jarvis: ${STATE_LABEL[state]}${connected ? '' : ' (demo)'}`);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Jarvis: ${STATE_LABEL[state]}`, enabled: false },
      {
        label: connected ? 'Connected to Jarvis core' : 'Demo mode (core not running)',
        enabled: false,
      },
      { type: 'separator' },
      isMuted
        ? { label: 'Unmute', click: () => toCore({ type: 'unmute' }) }
        : { label: 'Mute', click: () => toCore({ type: 'mute' }) },
      { label: 'Stop current task', click: () => toCore({ type: 'stop' }) },
      ...(restarting
        ? [{ label: 'Restarting Jarvis…', enabled: false }]
        : connected
          ? [
              { label: 'Restart Jarvis', click: restartCore },
              { label: 'Stop Jarvis', click: stopCore },
            ]
          : [
              {
                label: coreStarting ? 'Starting Jarvis…' : 'Start Jarvis',
                enabled: !coreStarting,
                click: () => startCore(),
              },
            ]),
      { label: 'Play demo', enabled: !connected, click: playDemo },
      { type: 'separator' },
      petVisible
        ? {
            label: 'Hide pet',
            click: () => {
              manuallyHidden = true;
              applyVisibility();
            },
          }
        : {
            label: 'Show pet',
            click: () => {
              manuallyHidden = false;
              applyVisibility();
            },
          },
      {
        label: 'Hide when idle',
        type: 'checkbox',
        checked: prefs.hideWhenIdle,
        click: (item) => {
          prefs = { ...prefs, hideWhenIdle: item.checked };
          savePrefs();
          applyVisibility();
        },
      },
      { label: 'Settings…', click: () => openSettings(settingsDeps) },
      { label: 'Open config folder', click: () => void shell.openPath(CONFIG_DIR) },
      // Jarvis (core) starts the pet; starting the pet alone would leave an icon
      // with no Jarvis behind it. Set up with: npm run autostart -- on
      { label: 'Start with Windows: npm run autostart -- on', enabled: false },
      { type: 'separator' },
      {
        label: connected ? 'Quit Jarvis' : 'Quit pet',
        click: () => {
          if (connected) link?.send({ type: 'quit' });
          app.quit();
        },
      },
    ]),
  );
}

// ---------- window ----------

function createWindow(): void {
  const pos = loadPosition();
  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: WIDTH,
    height: HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(SRC, 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  // Click-through everywhere except the pet and its bubble (the renderer says when).
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => applyVisibility());
  void win.loadFile(path.join(SRC, 'renderer', 'index.html'));
}

ipcMain.on('pet:interactive', (_e, on: unknown) => {
  win?.setIgnoreMouseEvents(on !== true, { forward: true });
});

ipcMain.on('pet:drag-start', (_e, offset: unknown) => {
  if (!win || !offset || typeof offset !== 'object') return;
  const { x: ox, y: oy } = offset as { x: number; y: number };
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    const c = screen.getCursorScreenPoint();
    win?.setPosition(Math.round(c.x - ox), Math.round(c.y - oy));
  }, 16);
});

ipcMain.on('pet:drag-end', () => {
  clearInterval(dragTimer);
  dragTimer = undefined;
  keepOnScreen();
  savePosition();
});

ipcMain.on('pet:input-reply', (_e, id: unknown, value: unknown) => {
  const answer = cleanAnswer(id, value);
  if (!answer || answer.id !== openInput) return;
  closeInput();
  toCore({ type: 'input_reply', id: answer.id, value: answer.value });
});

ipcMain.on('pet:input-cancel', (_e, id: unknown) => {
  if (typeof id !== 'string' || id !== openInput) return;
  closeInput();
  toCore({ type: 'input_cancel', id });
});

ipcMain.on('pet:clicked', () => {
  if (!connected && (state === 'SLEEPING' || state === 'MUTED')) playDemo();
});

ipcMain.on('pet:ready', () => {
  sendAppearance();
  show({ type: 'state', state });
  if (connected) return;
  if (process.env.JARVIS_PET_DEMO === '1') {
    playDemo(); // for screenshots and quick checks
    return;
  }
  show({
    type: 'reply_text',
    text: 'Demo mode: Jarvis core is not running yet. Click me, or use the tray menu, to see a request.',
  });
});

const settingsDeps: SettingsDeps = {
  srcDir: SRC,
  configDir: CONFIG_DIR,
  getAppearance: () => appearance,
  setAppearance: (patch) => {
    appearance = parseAppearance(patch, appearance);
    if (appearance.look === 'logo' && !logo) appearance = { ...appearance, look: 'robot' };
    saveAppearance();
    sendAppearance();
    return appearance;
  },
  getLogo: () => logo,
  setLogo: storeLogo,
  clearLogo: removeLogo,
  getBehavior: () => ({ ...prefs, startWithWindows: app.getLoginItemSettings().openAtLogin }),
  setBehavior: (patch) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    prefs = parsePrefs({ ...prefs, ...p });
    savePrefs();
    if (typeof p.startWithWindows === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: p.startWithWindows });
    }
    applyVisibility();
    updateTray();
  },
  coreStatus,
  startCore,
  stopCore,
  restartCore,
  voiceTest: () => connected && link?.send({ type: 'voice_test' }) === true,
  onOpenChange: (open) => {
    settingsOpen = open;
    if (open) manuallyHidden = false;
    applyVisibility();
  },
};

app.whenReady().then(() => {
  // A copy that handed over to the running pet only quits. If it also connected
  // to core, core would drop the real pet for it ("a newer pet replaces the old
  // one") and the real pet would be cut off until it reconnected.
  if (!isPrimaryPet) return;
  app.setAppUserModelId('Jarvis.Pet');
  loadPrefs();
  loadAppearance();
  registerSettingsIpc(settingsDeps);
  createWindow();
  tray = new Tray(currentTrayIcon(false));
  tray.on('click', () => tray?.popUpContextMenu());
  updateTray();

  screen.on('display-metrics-changed', keepOnScreen);
  screen.on('display-removed', keepOnScreen);

  const core = coreFromEnv();
  if (core) connectCore(core);
  if (process.env.JARVIS_PET_SETTINGS === '1') openSettings(settingsDeps); // for screenshots
});

function connectCore(core: { port: number; token: string }): void {
  link?.stop();
  link = new CoreLink({
    ...core,
    onEvent: show,
    onStatus: (up) => {
      const wasConnected = connected;
      connected = up;
      if (up) {
        stopDemo?.();
        clearTimeout(coreStarting);
        coreStarting = undefined;
        // A new core connected: the restart is done. (The old link never
        // reconnects during a restart; continueRestart stops it.)
        if (restarting) {
          endRestart();
          return;
        }
      } else if (restarting && wasConnected) {
        continueRestart();
      }
      statusChanged();
    },
  });
  link.start();
}

app.on('second-instance', (_event, _argv, _cwd, data) => {
  manuallyHidden = false;
  showPet();
  // A newer core started another pet: follow that core instead.
  const core = parseCoreAddress(data);
  if (core) connectCore(core);
});
app.on('before-quit', () => {
  savePosition();
  link?.stop();
  stopDemo?.();
});
app.on('window-all-closed', () => app.quit());
