import { ar, arPatterns } from './ar';
import { es, esPatterns } from './es';
import { fr, frPatterns } from './fr';
import { prefsChanged } from '../lib/prefsSync';

// The app's language. English is what the code is written in; for another language a dictionary maps
// each piece of interface text to its translation, applied to the page as it's drawn (text, tooltips,
// placeholders). What people write — documents, titles being typed, cells — is never touched.
// Adding a language: a file like ar.ts (same keys) and an entry below.

export interface Language {
  code: string;
  name: string;
  dir: 'ltr' | 'rtl';
  /** For dates and times (Western digits keep numbers the same as typed ones). */
  locale: string;
}

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', dir: 'ltr', locale: 'en' },
  { code: 'es', name: 'Español', dir: 'ltr', locale: 'es' },
  { code: 'fr', name: 'Français', dir: 'ltr', locale: 'fr' },
  { code: 'ar', name: 'العربية', dir: 'rtl', locale: 'ar-u-nu-latn' },
];

const DICTIONARIES: Record<string, { words: Record<string, string>; patterns: [RegExp, string][] }> = {
  ar: { words: ar, patterns: arPatterns },
  es: { words: es, patterns: esPatterns },
  fr: { words: fr, patterns: frPatterns },
};

const KEY = 'atrium-lang';

function initial(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch {
    // Storage blocked: English.
  }
  // English until someone picks another language (Settings → Appearance → Language).
  return 'en';
}

const current = initial();
export const language = (): Language => LANGUAGES.find((l) => l.code === current) ?? LANGUAGES[0];

/** Switches language (the app reloads so everything, the editor included, picks it up). */
export function setLanguage(code: string) {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    // Can't remember it: still switch for now.
  }
  prefsChanged(true);
  location.reload();
}

/** Translates one piece of interface text (for code that builds text itself). */
export function t(text: string): string {
  const dict = DICTIONARIES[current];
  if (!dict) return text;
  const found = dict.words[text];
  if (found !== undefined) return found;
  for (const [re, out] of dict.patterns) if (re.test(text)) return text.replace(re, out);
  return text;
}

// ---------- applying it to the page ----------

const ATTRS = ['title', 'placeholder', 'aria-label'] as const;
/** What each text node held in English, and what it was turned into. */
const done = new WeakMap<Node, { tr: string }>();

/** Places whose text is people's own (being typed, or drawn by other tools) and is left as it is. */
function skip(el: Element | null): boolean {
  if (!el) return true;
  if (el.closest('script, style, textarea, input, select, code, pre, [data-no-translate], .excalidraw, .fortune-sheet-container, .slide-text, .ProseMirror, .bn-editor, .doc-paper')) return true;
  const editable = el.closest('[contenteditable]');
  return !!editable && editable.getAttribute('contenteditable') !== 'false';
}

function translateText(node: Text) {
  const value = node.nodeValue ?? '';
  const prev = done.get(node);
  if (prev && prev.tr === value) return;
  const trimmed = value.trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed) || skip(node.parentElement)) return;
  const tr = t(trimmed);
  if (tr === trimmed) return;
  const out = value.replace(trimmed, tr);
  done.set(node, { tr: out });
  node.nodeValue = out;
}

function translateAttrs(el: Element) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[A-Za-z]/.test(v)) continue;
    const tr = t(v);
    if (tr !== v) el.setAttribute(a, tr);
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root as Text);
  if (!(root instanceof Element) || skip(root)) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text);
    else translateAttrs(n as Element);
  }
}

/** Dates and times shown with the browser's defaults follow the app's language. */
function localizeDates(locale: string) {
  const pick = (l: unknown) => (l === undefined ? locale : l);
  const toDate = Date.prototype.toLocaleDateString;
  const toTime = Date.prototype.toLocaleTimeString;
  const toAll = Date.prototype.toLocaleString;
  Date.prototype.toLocaleDateString = function (l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) {
    return toDate.call(this, pick(l) as Intl.LocalesArgument, o);
  };
  Date.prototype.toLocaleTimeString = function (l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) {
    return toTime.call(this, pick(l) as Intl.LocalesArgument, o);
  };
  Date.prototype.toLocaleString = function (l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) {
    return toAll.call(this, pick(l) as Intl.LocalesArgument, o);
  };
  const Native = Intl.DateTimeFormat;
  const Patched = function (this: unknown, l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) {
    return new Native(pick(l) as Intl.LocalesArgument, o);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.defineProperty(Patched, 'prototype', { value: Native.prototype });
  Object.defineProperty(Patched, 'supportedLocalesOf', { value: Native.supportedLocalesOf });
  Intl.DateTimeFormat = Patched;
}

/** Sets the page's language and direction, and translates it as it changes. */
export function startTranslating() {
  const lang = language();
  document.documentElement.lang = lang.code;
  document.documentElement.dir = lang.dir;
  if (!DICTIONARIES[lang.code]) return;
  localizeDates(lang.locale);
  walk(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target as Text);
      else if (r.type === 'attributes') {
        if (r.target instanceof Element && !skip(r.target)) translateAttrs(r.target);
      } else r.addedNodes.forEach(walk);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
}
