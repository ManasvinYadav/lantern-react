/**
 * Accent-color runtime mechanism.
 *
 * Midnight is the app's only look (index.css has no other theme variant to
 * switch to) — this module only ever handles the accent color. Persistence
 * and DOM mutation logic only — no picker UI; SettingsDrawer renders the
 * swatches and calls applyAccent on click. Mirrors the inline bootstrap
 * script in index.html exactly (same localStorage key, same hex+alpha-suffix
 * trick for -glow/-bg) so a choice made here survives the next full page
 * load without a flash of the previous accent.
 */

export const ACCENT_PRESETS = [
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#06b6d4",
] as const;

export const DEFAULT_ACCENT = "#10b981";

const ACCENT_STORAGE_KEY = "lantern_accent";

/** Fired on `window` after applyAccent commits a change, so any mounted-once
 * consumer that can't re-read localStorage on every render (e.g. the
 * AppBackground's Aurora colorStops) can still stay in sync without lifting
 * accent into shared React state. */
export const THEME_CHANGE_EVENT = "lantern:theme-change";

/** Reads the persisted accent hex, falling back to the default when unset. */
export function getStoredAccent(): string {
  return window.localStorage.getItem(ACCENT_STORAGE_KEY) ?? DEFAULT_ACCENT;
}

/**
 * Applies an accent color to the document and persists it. Sets inline
 * styles on <html>, which win over the [data-theme="..."] stylesheet
 * overrides regardless of the active theme (inline style beats any
 * non-!important selector) — so a custom accent stays visible even in light
 * mode, where --color-up is otherwise a fixed hex independent of --color-accent.
 *
 * -glow/-bg are derived via hex alpha-channel suffixes ("40" ~= 25%, "20" ~=
 * 12.5%) rather than converting to rgba(), matching the legacy dashboard's
 * script byte-for-byte; `hex` must be a 6-digit "#rrggbb" string for the
 * suffix trick to produce valid CSS (an 8-digit input, e.g. from
 * <input type="color"> with alpha, would double up incorrectly).
 */
export function applyAccent(hex: string): void {
  const root = document.documentElement.style;
  root.setProperty("--color-accent", hex);
  root.setProperty("--color-accent-glow", `${hex}40`);
  root.setProperty("--color-accent-bg", `${hex}20`);
  root.setProperty("--color-up", hex);
  root.setProperty("--color-up-glow", `${hex}40`);
  root.setProperty("--color-up-bg", `${hex}20`);
  window.localStorage.setItem(ACCENT_STORAGE_KEY, hex);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/**
 * Derives Aurora's 3-stop colorStops array from a single accent hex, so the
 * animated background always reads as "the chosen accent's aurora" instead
 * of the accent picker only affecting flat UI chrome while the big animated
 * backdrop stays a fixed green/blue/violet regardless of what's picked.
 * Rotates the accent's hue by ±42° for the other two stops (an analogous
 * triad) rather than repeating the same hex three times, which would render
 * as a flat wash instead of a gradient sweep.
 */
export function auroraStopsForAccent(hex: string): [string, string, string] {
  const [h, s, l] = hexToHsl(hex);
  return [hslToHex(h, s, l), hslToHex((h + 42) % 360, s, l), hslToHex((h + 360 - 42) % 360, s, l)];
}

function hexToHsl(hex: string): [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  return [h * 60, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  const [r0, g0, b0] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r0)}${toHex(g0)}${toHex(b0)}`;
}
