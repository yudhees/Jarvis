import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CoreToPetEvent, JarvisState, PetToCoreEvent } from '@jarvis/shared';
import { app, BrowserWindow, ipcMain, Menu, type Rectangle, screen, shell, Tray } from 'electron';
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
const CONFIG_DIR = path.resolve(SRC, '..', '..', '..', 'config');

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

if (!app.requestSingleInstanceLock()) app.quit();

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
  tray.setImage(trayIcon(isMuted));
  tray.setToolTip(`Jarvis: ${STATE_LABEL[state]}${connected ? '' : ' (demo)'}`);
  const startWithWindows = app.getLoginItemSettings().openAtLogin;
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
      { label: 'Settings (config folder)', click: () => void shell.openPath(CONFIG_DIR) },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startWithWindows,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          updateTray();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit pet',
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

app.whenReady().then(() => {
  app.setAppUserModelId('Jarvis.Pet');
  loadPrefs();
  createWindow();
  tray = new Tray(trayIcon(false));
  tray.on('click', () => tray?.popUpContextMenu());
  updateTray();

  screen.on('display-metrics-changed', keepOnScreen);
  screen.on('display-removed', keepOnScreen);

  const port = Number(process.env.JARVIS_CORE_PORT);
  const token = process.env.JARVIS_PET_TOKEN;
  if (Number.isInteger(port) && port > 0 && token) {
    link = new CoreLink({
      port,
      token,
      onEvent: show,
      onStatus: (up) => {
        connected = up;
        if (up) stopDemo?.();
        updateTray();
      },
    });
    link.start();
  }
});

app.on('second-instance', () => {
  manuallyHidden = false;
  showPet();
});
app.on('before-quit', () => {
  savePosition();
  link?.stop();
  stopDemo?.();
});
app.on('window-all-closed', () => app.quit());
