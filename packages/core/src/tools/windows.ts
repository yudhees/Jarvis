import { execFile, spawn } from 'node:child_process';
import type { LocalTool } from '../voice/conversation.ts';

/** One entry of the Windows Start menu (Get-StartApps). */
export interface StartApp {
  name: string;
  appId: string;
}

/**
 * Apps Jarvis never opens by voice, even though they are in the Start menu:
 * uninstallers, installers, and tools that change the system or its security
 * (CLAUDE.md 10.1). Matched on the app's name.
 */
const BLOCKED_APP =
  /\b(uninstall\w*|uninst|setup|installer|install|regedit|registry|recovery|reset|diskpart|format|bitlocker|credential manager|windows security|firewall|defender|group policy|security policy|computer management|disk management|services|task scheduler|user accounts|system configuration|msconfig)\b/i;

export function isBlockedApp(name: string): boolean {
  return BLOCKED_APP.test(name);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Words people say before the app name ("open the Slack app"). */
const FILLER = /\b(the|app|application|program|please|my)\b/g;

/**
 * Picks the Start menu app the user meant: exact name, then the name starting
 * with what was said, then every spoken word inside the name. Blocked apps are
 * never picked. Shorter names win ties ("Slack" over "Slack Beta").
 */
export function matchApp(
  spoken: string,
  apps: readonly StartApp[],
  { loose = true }: { loose?: boolean } = {},
): StartApp | undefined {
  const want = norm(norm(spoken).replace(FILLER, ' '));
  if (!want) return undefined;
  const usable = apps.filter((a) => !isBlockedApp(a.name));
  const byLength = (a: StartApp, b: StartApp) => a.name.length - b.name.length;
  const exact = usable.find((a) => norm(a.name) === want);
  if (exact) return exact;
  const starts = usable.filter((a) => norm(a.name).startsWith(want)).sort(byLength);
  if (starts[0]) return starts[0];
  const words = want.split(' ');
  // Strict (no model checked the request): only exact, prefix and initials.
  const all = !loose
    ? []
    : usable
        .filter((a) => {
          const have = norm(a.name).split(' ');
          return words.every((w) => have.some((h) => h.startsWith(w)));
        })
        .sort(byLength);
  if (all[0]) return all[0];
  // Initials for the first words: "vs code" = Visual Studio Code.
  return usable.filter((a) => shortForms(norm(a.name)).includes(want)).sort(byLength)[0];
}

/** "visual studio code" -> ["vs code", "vsc"]: the first 2+ words as initials. */
function shortForms(name: string): string[] {
  const w = name.split(' ');
  const out: string[] = [];
  for (let k = 2; k <= w.length; k++) {
    out.push(
      [
        w
          .slice(0, k)
          .map((x) => x[0])
          .join(''),
        ...w.slice(k),
      ].join(' '),
    );
  }
  return out;
}

/** Browsers Jarvis can open a page in, by spoken name -> exe in App Paths. */
const BROWSER_EXE: Record<string, string> = {
  vivaldi: 'vivaldi.exe',
  chrome: 'chrome.exe',
  'google chrome': 'chrome.exe',
  edge: 'msedge.exe',
  'microsoft edge': 'msedge.exe',
  firefox: 'firefox.exe',
  brave: 'brave.exe',
  opera: 'opera.exe',
};

export function browserExeName(spoken: string): string | undefined {
  return BROWSER_EXE[
    norm(spoken)
      .replace(/\bbrowser\b/, '')
      .trim()
  ];
}

/**
 * What to open: a web address ("github.com", "https://...") as it is, anything
 * else as a web search. Only http and https; never file:, javascript: or other
 * schemes.
 */
export function pageFor(target: string, searchUrl: string): string {
  const t = target.trim();
  if (!t) throw new Error('Nothing to open.');
  // "localhost:3000" has a port, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t);
  const looksLikeHost =
    !/\s/.test(t) && /^([\w-]+(\.[\w-]+)+|localhost)(:\d+)?([/?#].*)?$/i.test(t);
  if (hasScheme && !/^https?:\/\//i.test(t)) throw new Error('Only web pages can be opened.');
  if (hasScheme || looksLikeHost) {
    const url = URL.canParse(hasScheme ? t : `https://${t}`)
      ? new URL(hasScheme ? t : `https://${t}`)
      : undefined;
    if (url && (url.protocol === 'https:' || url.protocol === 'http:')) return url.href;
    if (hasScheme) throw new Error('That web address is not valid.');
  }
  return searchUrl.replace('{query}', encodeURIComponent(t));
}

/** How Jarvis talks to Windows; replaced in tests so nothing really opens. */
export interface WindowsShell {
  startApps(): Promise<StartApp[]>;
  /** Full path of a browser's exe from the App Paths registry key, if installed. */
  browserPath(exe: string): Promise<string | undefined>;
  launchApp(appId: string): void;
  openUrl(url: string, browserExe?: string): void;
}

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );

/** Starts a program and lets it outlive Jarvis. No shell, so nothing is interpreted. */
function detach(file: string, args: string[]): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

export const realWindowsShell: WindowsShell = {
  async startApps() {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
    ]);
    const parsed = JSON.parse(out || '[]') as
      | { Name: string; AppID: string }
      | { Name: string; AppID: string }[];
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((a) => a?.Name && a.AppID)
      .map((a) => ({ name: a.Name, appId: a.AppID }));
  },
  async browserPath(exe) {
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const out = await run('reg.exe', [
          'query',
          `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
          '/ve',
        ]);
        const m = /REG_SZ\s+(.+)/.exec(out);
        if (m?.[1]) return m[1].trim().replace(/^"|"$/g, '');
      } catch {
        // not installed in this hive
      }
    }
    return undefined;
  },
  launchApp(appId) {
    // The Start menu's own launcher: works for desktop and Store apps alike.
    detach('explorer.exe', [`shell:AppsFolder\\${appId}`]);
  },
  openUrl(url, browserExe) {
    if (browserExe) detach(browserExe, [url]);
    else detach('explorer.exe', [url]); // the default browser
  },
};

export interface WindowsToolsOptions {
  shell?: WindowsShell;
  /** Browser to use when the user names none; empty means the Windows default. */
  browser?: string;
  /** Web search address with {query}. */
  searchUrl: string;
  /** Called after every action, for the log. */
  onAction?: (line: string) => void;
}

const APP_CACHE_MS = 10 * 60_000;

/**
 * Tier 1 actions (CLAUDE.md 9: low-risk, reversible, run without asking, and
 * Jarvis says what it did): open an app from the Start menu, open a web page or
 * a web search in a browser. Nothing is typed, clicked, or run in a shell.
 */
export function windowsTools(options: WindowsToolsOptions): LocalTool[] {
  const shell = options.shell ?? realWindowsShell;
  // Reading the Start menu takes about 2 s, so it is read once at startup and
  // refreshed in the background; a request never waits unless nothing is known yet.
  let known: { at: number; apps: StartApp[] } | undefined;
  let loading: Promise<StartApp[]> | undefined;
  const load = () => {
    loading ??= shell
      .startApps()
      .then((list) => {
        known = { at: Date.now(), apps: list };
        return list;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };
  const apps = async (fresh = false): Promise<StartApp[]> => {
    if (!known || fresh) return load();
    if (Date.now() - known.at > APP_CACHE_MS) load().catch(() => {});
    return known.apps;
  };
  load().catch(() => {});

  const openApp = async (spoken: string, strict = false): Promise<string | undefined> => {
    if (isBlockedApp(spoken))
      return strict ? undefined : `Jarvis is not allowed to open ${spoken}.`;
    // Not found in the list from earlier: maybe it was just installed, so read again.
    // A quick (no model) request never waits for that; the model path will.
    const app = strict
      ? matchApp(spoken, await apps(), { loose: false })
      : (matchApp(spoken, await apps()) ?? matchApp(spoken, await apps(true).catch(() => [])));
    if (!app)
      return strict
        ? undefined
        : `No app called ${spoken} was found on this PC. Nothing was opened.`;
    shell.launchApp(app.appId);
    options.onAction?.(`open_app ${app.name}`);
    return `Opened ${app.name}.`;
  };

  const openPage = async (target: string, browser: string): Promise<string> => {
    const url = pageFor(target, options.searchUrl);
    const named = browser.trim() || options.browser?.trim() || '';
    let exe: string | undefined;
    let label = 'your browser';
    if (named) {
      const exeName = browserExeName(named);
      exe = exeName ? await shell.browserPath(exeName) : undefined;
      if (exe) label = named;
      else if (browser.trim())
        return `${named} is not installed or not a browser I know. Nothing was opened.`;
    }
    shell.openUrl(url, exe);
    const host = new URL(url).hostname.replace(/^www\./, '');
    options.onAction?.(`open_url ${host} in ${label}`);
    const what = url.startsWith(options.searchUrl.split('{query}')[0] ?? '\0') ? 'a search' : host;
    return `Opened ${what} in ${label}.`;
  };

  return [
    {
      name: 'open_app',
      description:
        'Open an app installed on this Windows PC, by the name the user said (like Slack, Notepad, Spotify, Vivaldi). Use it whenever the user asks to open or launch an app.',
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', description: 'App name, like "Slack"' } },
        required: ['app'],
      },
      speaksResult: true,
      run: async (input) => (await openApp(String(input.app ?? '').trim())) ?? '',
      quick: async (text) => {
        const name = quickAppName(text);
        return name ? openApp(name, true) : undefined;
      },
    },
    {
      name: 'open_url',
      description:
        'Show something in the web browser: a web address, or a web search for anything else. Use it when the user says "show me", "open <website>", "look up ... in the browser" or "search for". Optionally a browser the user named (Vivaldi, Chrome, Edge, Firefox).',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'A web address, or words to search for' },
          browser: { type: 'string', description: 'Only if the user named a browser' },
        },
        required: ['target'],
      },
      speaksResult: true,
      run: (input) => openPage(String(input.target ?? ''), String(input.browser ?? '')),
      quick: async (text) => {
        const m = quickSite(text);
        return m ? openPage(m.site, m.browser) : undefined;
      },
    },
  ];
}

const POLITE = /^(?:(?:hey |hi |ok(?:ay)? )?jarvis[, ]+)?(?:(?:can|could|would) you |please )?/i;
const TRAILING = /(?:\s+(?:for me|please|now))*[\s.!?]*$/i;

/**
 * "Open Slack", "launch the Notepad app": the app name, when the whole request
 * is just that. Anything longer goes to the model ("open Slack and read my DMs").
 */
export function quickAppName(text: string): string | undefined {
  const t = text.trim().replace(POLITE, '').replace(TRAILING, '');
  const m = /^(?:open|launch)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+(?:app|application))?$/i.exec(
    t,
  );
  const name = m?.[1]?.trim();
  if (!name || name.split(/\s+/).length > 4) return undefined;
  if (
    /\b(and|then|in|on|to|with|tab|window|ticket|file|folder|page|site|website)\b|[./:]/i.test(name)
  )
    return undefined;
  return name;
}

/** "Open github.com", "go to youtube.com in Chrome": a site to open, when that is all. */
export function quickSite(text: string): { site: string; browser: string } | undefined {
  const t = text.trim().replace(POLITE, '').replace(TRAILING, '');
  const m =
    /^(?:open|go to|show me)\s+(\S+\.[a-z]{2,}(?:\/\S*)?)(?:\s+in\s+([a-z ]+?))?(?:\s+browser)?$/i.exec(
      t,
    );
  if (!m?.[1]) return undefined;
  if (m[2] && !browserExeName(m[2])) return undefined;
  return { site: m[1], browser: m[2] ?? '' };
}
