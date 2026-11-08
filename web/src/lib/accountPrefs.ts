import { reloadAppearance } from './theme';
import { setPrefsHandler } from './prefsSync';

// Appearance and language follow the account: theme, colour theme, custom colours, accent, font, text
// size, page width, density and language are saved with it, and a device that signs in takes them.
// (They're still kept on the device too, so the first paint is right before anything loads.)

/** The settings that travel with the account (the same keys the device keeps them under). */
const KEYS = ['atrium-theme', 'atrium-color-theme', 'atrium-font', 'atrium-text-size', 'atrium-page-width', 'atrium-density', 'atrium-accent', 'atrium-custom-colors', 'atrium-lang'];
const LANG = 'atrium-lang';

function onDevice(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of KEYS) {
    try {
      out[k] = localStorage.getItem(k);
    } catch {
      out[k] = null;
    }
  }
  return out;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let ready = false;

function save() {
  // keepalive: still sent if the page reloads (switching language does).
  void fetch('/api/auth/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs: onDevice() }),
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {});
}

/** Called once signed in: takes the account's settings, or gives it this device's if it has none yet. */
export async function syncAccountPrefs() {
  setPrefsHandler((now) => {
    if (!ready) return;
    clearTimeout(timer);
    if (now) save();
    else timer = setTimeout(save, 600);
  });
  let stored: Record<string, string>;
  try {
    const res = await fetch('/api/auth/me/prefs', { credentials: 'same-origin' });
    if (!res.ok) return;
    stored = (await res.json()).prefs ?? {};
  } catch {
    return;
  }
  ready = true;
  if (!Object.keys(stored).length) {
    // A new account (or one from before this): this device's settings become the account's.
    save();
    return;
  }
  const here = onDevice();
  let changed = false;
  for (const k of KEYS) {
    const want = stored[k] ?? null;
    if (want === here[k]) continue;
    changed = true;
    try {
      if (want === null) localStorage.removeItem(k);
      else localStorage.setItem(k, want);
    } catch {
      // Can't keep it on this device: it still applies until the app closes.
    }
  }
  if (!changed) return;
  // A different language needs a fresh start (the editor reads it when it loads); the rest applies now.
  if ((stored[LANG] ?? null) !== here[LANG]) location.reload();
  else reloadAppearance();
}
