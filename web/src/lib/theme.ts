import { useEffect, useSyncExternalStore } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type ColorTheme =
  | 'default' | 'dandelion' | 'lavender' | 'lemonade' | 'ocean' | 'forest' | 'rose' | 'graphite'
  | 'sunset' | 'mint' | 'nord' | 'sepia' | 'midnight' | 'contrast';
export type FontPref = 'sans' | 'serif' | 'mono' | 'rounded';
export type TextSize = 'small' | 'default' | 'large';
export type PageWidth = 'default' | 'wide' | 'full';
export type Density = 'comfortable' | 'compact';

/** Swatches shown in Settings → Appearance (the actual colours live in styles.css). */
export const COLOR_THEMES: { id: ColorTheme; label: string; swatch: string; surface?: [string, string] }[] = [
  { id: 'default', label: 'Default', swatch: '#7c5cff' },
  { id: 'dandelion', label: 'Dandelion', swatch: '#f59e0b' },
  { id: 'lavender', label: 'Lavender', swatch: '#b06ad9' },
  { id: 'lemonade', label: 'Lemonade', swatch: '#84b81f' },
  { id: 'ocean', label: 'Ocean', swatch: '#2f80ed' },
  { id: 'forest', label: 'Forest', swatch: '#1f9d6b' },
  { id: 'rose', label: 'Rose', swatch: '#e5487a' },
  { id: 'graphite', label: 'Graphite', swatch: '#525866' },
  { id: 'sunset', label: 'Sunset', swatch: '#f0603a' },
  { id: 'mint', label: 'Mint', swatch: '#14b8a6' },
  // These also tint the page background, not just the accent.
  { id: 'nord', label: 'Nord', swatch: '#5e81ac', surface: ['#eceff4', '#2e3440'] },
  { id: 'sepia', label: 'Sepia', swatch: '#a0643a', surface: ['#f6f0e4', '#2a241d'] },
  { id: 'midnight', label: 'Midnight', swatch: '#6d8cff', surface: ['#eef1fb', '#0f1424'] },
  { id: 'contrast', label: 'High contrast', swatch: '#0050d0', surface: ['#ffffff', '#000000'] },
];

export const FONTS: { id: FontPref; label: string; sample: string }[] = [
  { id: 'sans', label: 'Sans', sample: 'Inter, system-ui, sans-serif' },
  { id: 'serif', label: 'Serif', sample: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', sample: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: 'rounded', label: 'Rounded', sample: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI Variable Display", system-ui, sans-serif' },
];

export const TEXT_SIZES: { id: TextSize; label: string }[] = [
  { id: 'small', label: 'Small' },
  { id: 'default', label: 'Default' },
  { id: 'large', label: 'Large' },
];

export const PAGE_WIDTHS: { id: PageWidth; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'wide', label: 'Wide' },
  { id: 'full', label: 'Full width' },
];

export const DENSITIES: { id: Density; label: string }[] = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
];

/** Preset accents offered next to the custom colour picker. */
export const ACCENT_PRESETS = ['#7c5cff', '#2f80ed', '#14b8a6', '#1f9d6b', '#84b81f', '#f59e0b', '#f0603a', '#e5487a', '#b06ad9', '#525866'];

/** Colours a person can set one by one (CSS variables), separately for light and dark mode. */
export const CUSTOM_COLORS: { key: string; label: string; hint: string }[] = [
  { key: 'bg', label: 'Page background', hint: 'Behind documents and databases' },
  { key: 'sidebar', label: 'Sidebar', hint: 'The sidebar and other side panels' },
  { key: 'surface', label: 'Menus and dialogs', hint: 'Pop-ups, menus, dialogs' },
  { key: 'card', label: 'Cards', hint: 'Board and gallery cards' },
  { key: 'column', label: 'Board columns', hint: 'Behind board columns' },
  { key: 'fg', label: 'Text', hint: 'Main text' },
  { key: 'muted', label: 'Secondary text', hint: 'Labels and details' },
  { key: 'faint', label: 'Hints', hint: 'Placeholders and faint text' },
  { key: 'line', label: 'Borders', hint: 'Lines and dividers' },
  { key: 'hover', label: 'Hover', hint: 'Things under the mouse' },
  { key: 'active', label: 'Selected', hint: 'Selected and pressed things' },
  { key: 'accent', label: 'Accent', hint: 'Buttons, links and highlights' },
  { key: 'danger', label: 'Warnings', hint: 'Overdue dates and delete buttons' },
];

export type CustomColors = { light: Record<string, string>; dark: Record<string, string> };
const COLORS_KEY = 'af-custom-colors';
const HEX = /^#[0-9a-f]{6}$/i;

function readColors(): CustomColors {
  try {
    const v = JSON.parse(localStorage.getItem(COLORS_KEY) ?? 'null');
    const clean = (o: unknown) => Object.fromEntries(Object.entries((o as Record<string, string>) ?? {}).filter(([k, c]) => CUSTOM_COLORS.some((x) => x.key === k) && HEX.test(c)));
    return { light: clean(v?.light), dark: clean(v?.dark) };
  } catch {
    return { light: {}, dark: {} };
  }
}

let customColors = readColors();

interface Prefs {
  mode: ThemePref;
  color: ColorTheme;
  font: FontPref;
  size: TextSize;
  width: PageWidth;
  density: Density;
  /** A custom accent (#rrggbb) that overrides the theme's; '' uses the theme's own. */
  accent: string;
}

// The index.html boot script reads the same keys so the first paint already has the right theme.
const KEYS: Record<keyof Prefs, string> = {
  mode: 'af-theme',
  color: 'af-color-theme',
  font: 'af-font',
  size: 'af-text-size',
  width: 'af-page-width',
  density: 'af-density',
  accent: 'af-accent',
};

const ALLOWED: { [K in keyof Prefs]: (v: string) => boolean } = {
  mode: (v) => ['light', 'dark', 'system'].includes(v),
  color: (v) => COLOR_THEMES.some((t) => t.id === v),
  font: (v) => FONTS.some((f) => f.id === v),
  size: (v) => TEXT_SIZES.some((s) => s.id === v),
  width: (v) => PAGE_WIDTHS.some((w) => w.id === v),
  density: (v) => DENSITIES.some((d) => d.id === v),
  accent: (v) => v === '' || /^#[0-9a-f]{6}$/i.test(v),
};

const DEFAULTS: Prefs = { mode: 'system', color: 'default', font: 'sans', size: 'default', width: 'default', density: 'comfortable', accent: '' };

const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function read<K extends keyof Prefs>(key: K): Prefs[K] {
  try {
    const v = localStorage.getItem(KEYS[key]);
    return (v !== null && ALLOWED[key](v) ? v : DEFAULTS[key]) as Prefs[K];
  } catch {
    return DEFAULTS[key];
  }
}

const prefs = Object.fromEntries((Object.keys(DEFAULTS) as (keyof Prefs)[]).map((k) => [k, read(k)])) as unknown as Prefs;
let snapshot = '';

function resolved(): 'light' | 'dark' {
  return prefs.mode === 'system' ? (media.matches ? 'dark' : 'light') : prefs.mode;
}

function apply() {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved() === 'dark');
  root.dataset.color = prefs.color;
  root.dataset.font = prefs.font;
  root.dataset.size = prefs.size;
  root.dataset.width = prefs.width;
  root.dataset.density = prefs.density;
  if (prefs.accent) root.style.setProperty('--custom-accent', prefs.accent);
  else root.style.removeProperty('--custom-accent');
  root.toggleAttribute('data-custom-accent', !!prefs.accent);
  // Colours set one by one win over the theme (for the mode in use).
  const own = customColors[resolved()];
  for (const { key } of CUSTOM_COLORS) {
    if (own[key]) root.style.setProperty(`--${key}`, own[key]);
    else root.style.removeProperty(`--${key}`);
  }
  if (own.accent) root.style.setProperty('--accent-soft', `${own.accent}2e`);
  else root.style.removeProperty('--accent-soft');
  snapshot = JSON.stringify({ ...prefs, resolved: resolved(), colors: customColors });
  listeners.forEach((l) => l());
  tintSystemBars();
}

/** In the Android app: the status and navigation bars take the page's background colour. */
function tintSystemBars() {
  const android = (window as unknown as { AfAndroid?: { setBars: (color: string, light: boolean) => void } }).AfAndroid;
  if (!android) return;
  // Read the colour once styles have applied.
  requestAnimationFrame(() => {
    if (!document.body) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--bg)';
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).backgroundColor.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
    probe.remove();
    const hex = `#${rgb.slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.6;
    try {
      android.setBars(hex, light);
    } catch {
      // An older app without this: nothing to do.
    }
  });
}

media.addEventListener('change', apply);
apply();

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  if (!ALLOWED[key](value)) return;
  prefs[key] = value;
  try {
    if (value === DEFAULTS[key]) localStorage.removeItem(KEYS[key]);
    else localStorage.setItem(KEYS[key], value);
  } catch {}
  apply();
}

/** Sets (or, with '', clears) one colour for light or dark mode. */
export function setCustomColor(mode: 'light' | 'dark', key: string, value: string) {
  if (value && !HEX.test(value)) return;
  const next = { ...customColors[mode] };
  if (value) next[key] = value.toLowerCase();
  else delete next[key];
  customColors = { ...customColors, [mode]: next };
  saveColors();
}

/** Replaces all custom colours (e.g. pasted from someone else's theme). */
export function setCustomColors(colors: CustomColors | null) {
  customColors = colors ? { light: { ...colors.light }, dark: { ...colors.dark } } : { light: {}, dark: {} };
  saveColors();
}

function saveColors() {
  try {
    if (!Object.keys(customColors.light).length && !Object.keys(customColors.dark).length) localStorage.removeItem(COLORS_KEY);
    else localStorage.setItem(COLORS_KEY, JSON.stringify(customColors));
  } catch {}
  apply();
}

export function resetAppearance() {
  (Object.keys(DEFAULTS) as (keyof Prefs)[]).forEach((k) => setPref(k, DEFAULTS[k]));
  setCustomColors(null);
}

export const setThemePref = (v: ThemePref) => setPref('mode', v);
export const setColorTheme = (v: ColorTheme) => setPref('color', v);
export const setFontPref = (v: FontPref) => setPref('font', v);

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme() {
  const current = JSON.parse(useSyncExternalStore(subscribe, () => snapshot)) as Prefs & { resolved: 'light' | 'dark'; colors: CustomColors };
  useEffect(apply, []);
  return {
    ...current,
    pref: current.mode,
    setPref: setThemePref,
    setColor: setColorTheme,
    setFont: setFontPref,
    set: setPref,
    reset: resetAppearance,
  };
}
