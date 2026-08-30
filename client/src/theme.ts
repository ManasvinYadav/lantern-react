/**
 * Theme + accent-color runtime mechanism.
 *
 * Persistence and DOM mutation logic only — no picker UI. A future Settings
 * component renders the swatches/buttons and calls these on click. Mirrors
 * the inline bootstrap script in index.html exactly (same localStorage keys,
 * same hex+alpha-suffix trick for -glow/-bg) so a choice made here survives
 * the next full page load without a flash of the old theme/accent.
 */

export type ThemeMode = "dark" | "midnight" | "light";

export const ACCENT_PRESETS = [
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#06b6d4",
] as const;

export const DEFAULT_THEME: ThemeMode = "dark";
export const DEFAULT_ACCENT = "#10b981";

const THEME_STORAGE_KEY = "lantern_theme";
const ACCENT_STORAGE_KEY = "lantern_accent";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "dark" || value === "midnight" || value === "light";
}

/** Reads the persisted theme, falling back to the default when unset or invalid. */
export function getStoredTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(stored) ? stored : DEFAULT_THEME;
}

/** Reads the persisted accent hex, falling back to the default when unset. */
export function getStoredAccent(): string {
  return window.localStorage.getItem(ACCENT_STORAGE_KEY) ?? DEFAULT_ACCENT;
}

/**
 * Applies a theme mode to the document and persists it.
 * `data-theme` is set unconditionally, including for "dark" (the CSS has no
 * rule keyed on `[data-theme="dark"]` — it's just the attribute-free
 * default) — kept explicit to match the legacy bootstrap script exactly, so
 * reading the attribute back always tells you the resolved theme.
 */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", mode);
  window.localStorage.setItem(THEME_STORAGE_KEY, mode);
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
}
