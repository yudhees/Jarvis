import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CoreToPetEvent, JarvisState, PetToCoreEvent } from '@jarvis/shared';
import { app, BrowserWindow, ipcMain, Menu, type Rectangle, screen, shell, Tray } from 'electron';
import { CoreLink } from './core-link.ts';
import { demoScript, playScript } from './demo.ts';
import { trayIcon } from './tray-icon.ts';

/**
 * The Jarvis pet (CLAUDE.md 11): a small transparent window that sits above the
 * taskbar, shows what Jarvis is doing, and never takes focus. It only displays
 * events; the one thing it sends to core is stop / mute / unmute / quit.
 */

const WIDTH = 340;
const HEIGHT = 400;
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

if (!app.requestSingleInstanceLock()) app.quit();

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

// ---------- events into the window ----------

function show(event: CoreToPetEvent): void {
  if (event.type === 'state') {
    state = event.state;
    updateTray();
  }
  win?.webContents.send('pet:event', event);
}

function toCore(event: PetToCoreEvent): void {
  if (connected && link?.send(event)) return;
  // Demo mode: act locally.
  if (event.type === 'stop') {
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
  muted = false;
  stopDemo = playScript(demoScript(), show);
}

// ---------- tray ----------

const STATE_LABEL: Record<JarvisState, string> = {
  SLEEPING: 'Sleeping',
  LISTENING: 'Listening',
  THINKING: 'Thinking',
  AWAITING_APPROVAL: 'Waiting for your OK',
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
      {
        label: 'Show or hide pet',
        click: () => (win?.isVisible() ? win.hide() : win?.showInactive()),
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
  win.once('ready-to-show', () => win?.showInactive());
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

app.on('second-instance', () => win?.showInactive());
app.on('before-quit', () => {
  savePosition();
  link?.stop();
  stopDemo?.();
});
app.on('window-all-closed', () => app.quit());
