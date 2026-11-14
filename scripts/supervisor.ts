/**
 * Keeps Jarvis running (what starts with Windows).
 *
 *   npm run jarvis                    run Jarvis, restart it if it crashes,
 *                                     reload it when the code changes
 *   npm run jarvis -- --log <file>    write its output to a file (no console)
 *
 * Quit Jarvis from the pet's tray menu (or Ctrl+C here) to stop it for good.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  renameSync,
  statSync,
  type WriteStream,
  watch,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { scriptArgs } from './args.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORE = path.join(ROOT, 'packages', 'core', 'src', 'main.ts');
/** Code that, when changed, needs a restart. jarvis.yaml is applied live by core. */
const WATCHED = ['packages/core/src', 'packages/shared/src', 'packages/pet/src', 'config'];
const RELOAD_EXT = /\.(ts|js|cjs|mjs|ps1|html|css|json|yaml)$/i;
const LIVE_FILES = new Set(['jarvis.yaml']);
const RELOAD_DEBOUNCE_MS = 1000;
/** After asking core to stop, how long before it is ended by force. */
const STOP_GRACE_MS = 8000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const SUPERVISOR_LOCK_PORT = 48179;

const args = scriptArgs({ log: { type: 'string' } });
const logPath = typeof args.log === 'string' ? args.log : undefined;

// One supervisor at a time.
const lock = createServer();
await new Promise<void>((resolve) => {
  lock.once('error', () => {
    console.error('Jarvis is already running (its supervisor is active).');
    process.exit(1);
  });
  lock.listen(SUPERVISOR_LOCK_PORT, '127.0.0.1', () => resolve());
});
lock.unref();

let log: WriteStream | undefined;
if (logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    // Keep one old log; the current one starts fresh, so it never grows large.
    if (statSync(logPath).size > 0) renameSync(logPath, `${logPath}.old`);
  } catch {
    // no previous log
  }
  log = createWriteStream(logPath, { flags: 'a' });
}
let logged = 0;
function say(line: string): void {
  const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
  if (log) {
    if (logged < LOG_MAX_BYTES) log.write(`${stamped}\n`);
    logged += stamped.length + 1;
  } else {
    console.log(stamped);
  }
}

let child: ChildProcess | undefined;
let stopping = false;
let reloadAfterExit = false;
let quickFailures = 0;
let startedAt = 0;

function start(): void {
  startedAt = Date.now();
  child = spawn(process.execPath, [CORE], {
    cwd: ROOT,
    stdio: log ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  if (log) {
    const forward = (b: Buffer) => {
      if (logged < LOG_MAX_BYTES) log?.write(b);
      logged += b.length;
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
  }
  child.on('exit', (code) => {
    child = undefined;
    if (stopping) return finish();
    if (reloadAfterExit) {
      reloadAfterExit = false;
      quickFailures = 0;
      say('Restarting with the new code.');
      return start();
    }
    if (code === 0) {
      say('Jarvis was quit. Supervisor stopping.');
      return finish();
    }
    // Crashed (or refused to start). Back off if it keeps failing quickly.
    quickFailures = Date.now() - startedAt < 30_000 ? quickFailures + 1 : 0;
    const wait = Math.min(60_000, 2000 * 2 ** Math.max(0, quickFailures - 1));
    say(`Jarvis stopped unexpectedly (exit ${code}). Restarting in ${wait / 1000} s.`);
    setTimeout(() => {
      if (!stopping) start();
    }, wait);
  });
}

/** Asks core to stop cleanly (it closes its helpers), then forces it if needed. */
function stopChild(): void {
  const c = child;
  if (!c) return;
  if (c.connected) c.send({ type: 'quit' });
  const force = setTimeout(() => {
    if (c.exitCode === null && c.pid) {
      spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true });
    }
  }, STOP_GRACE_MS);
  c.once('exit', () => clearTimeout(force));
}

function finish(): void {
  log?.end();
  process.exit(0);
}

let reloadTimer: NodeJS.Timeout | undefined;
let changed = '';
for (const dir of WATCHED) {
  watch(path.join(ROOT, dir), { recursive: true }, (_event, file) => {
    if (!file || !RELOAD_EXT.test(file) || LIVE_FILES.has(path.basename(file))) return;
    changed = path.join(dir, file);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      say(`Code changed (${changed}). Reloading Jarvis.`);
      if (child) {
        reloadAfterExit = true;
        stopChild();
      } else if (!stopping) {
        start();
      }
    }, RELOAD_DEBOUNCE_MS);
  });
}

process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  say('Stopping Jarvis.');
  if (child) stopChild();
  else finish();
});

say(`Supervisor started. Watching ${WATCHED.join(', ')} for changes.`);
start();
