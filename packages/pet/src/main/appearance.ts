/**
 * How the pet looks (Settings window). Pure functions, so the rules are tested
 * without Electron. Stored as pet-appearance.json in the pet's user data folder;
 * the logo itself is a separate PNG next to it.
 */

export const LOOKS = ['robot', 'orb', 'cat', 'bear', 'ghost', 'tv', 'logo'] as const;
export const THEMES = ['system', 'light', 'dark'] as const;

export interface Appearance {
  /** A built-in character (robot is the default), or logo = the user's own image. */
  look: (typeof LOOKS)[number];
  theme: (typeof THEMES)[number];
  /** #rrggbb, or null for the theme's own color. */
  accent: string | null;
  glow: string | null;
  /** Pet size in percent. */
  size: number;
  /** Show the logo in the tray too (when a logo is set). */
  logoInTray: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  look: 'robot',
  theme: 'system',
  accent: null,
  glow: null,
  size: 100,
  logoInTray: true,
};

export const SIZE_RANGE = { min: 80, max: 125 } as const;
/** Largest logo file accepted from the picker (as a data URL). */
export const MAX_LOGO_DATA_URL = 3_000_000;

const HEX = /^#[0-9a-f]{6}$/;

function color(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  return HEX.test(v) ? v : fallback;
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Reads stored or submitted appearance; anything unknown or invalid keeps `base`. */
export function parseAppearance(raw: unknown, base: Appearance = DEFAULT_APPEARANCE): Appearance {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const size = Number(p.size);
  return {
    look: oneOf(LOOKS, p.look, base.look),
    theme: oneOf(THEMES, p.theme, base.theme),
    accent: 'accent' in p ? color(p.accent, base.accent) : base.accent,
    glow: 'glow' in p ? color(p.glow, base.glow) : base.glow,
    size:
      Number.isFinite(size) && size >= SIZE_RANGE.min && size <= SIZE_RANGE.max
        ? Math.round(size)
        : base.size,
    logoInTray: typeof p.logoInTray === 'boolean' ? p.logoInTray : base.logoInTray,
  };
}

/** Black or white text, whichever reads better on the accent color. */
export function inkFor(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.4 ? '#0d1118' : '#ffffff';
}

/**
 * First check of a picked logo: only PNG or JPEG data URLs of a sane size.
 * The main process then decodes it and re-encodes it as a fresh PNG, so nothing
 * but pixels is kept.
 */
export function checkLogoDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_LOGO_DATA_URL) return undefined;
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : undefined;
}
