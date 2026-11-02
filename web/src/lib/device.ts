import { useEffect, useRef, useSyncExternalStore } from 'react';

// Phones (and the Android app): screens narrow enough that the app switches to its phone layout —
// windows as full-screen sheets, menus as bottom sheets, a bottom navigation bar.

const PHONE = '(max-width: 767px)';
const media = typeof window !== 'undefined' ? window.matchMedia(PHONE) : null;

export const isPhone = () => !!media?.matches;

export function usePhone() {
  return useSyncExternalStore(
    (cb) => {
      media?.addEventListener('change', cb);
      return () => media?.removeEventListener('change', cb);
    },
    isPhone,
    () => false,
  );
}

// ---------- the Android back button ----------
// What's open (a sheet, a menu, the sidebar, a file) registers how to close it. The Android app asks
// `window.__afBack()` first when back is pressed: it closes the newest thing and says so; with nothing
// open, the app goes back a page (or leaves).

const closers: { close: () => void }[] = [];

declare global {
  interface Window {
    __afBack?: () => boolean;
  }
}

if (typeof window !== 'undefined') {
  window.__afBack = () => {
    const top = closers[closers.length - 1];
    if (!top) return false;
    top.close();
    return true;
  };
}

interface TauriBack {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
  transformCallback(cb: (raw: unknown) => void, once?: boolean): number;
}
const tauri = (globalThis as { __TAURI_INTERNALS__?: TauriBack }).__TAURI_INTERNALS__;

// In the Android app, Tauri's own back handler runs first and would just go back a page. Listening for
// its "back-button" event makes it hand the press to us instead: close what's open, else go back a
// page, else leave the app.
if (tauri && /android/i.test(navigator.userAgent)) {
  const id = tauri.transformCallback(() => {
    if (window.__afBack?.()) return;
    if (history.length > 1 && history.state?.idx > 0) history.back();
    else (window as { AfAndroid?: { leave?: () => void } }).AfAndroid?.leave?.();
  });
  // Passed the way Tauri passes a channel (what @tauri-apps/api's Channel turns into).
  const handler = { toJSON: () => `__CHANNEL__:${id}` };
  // The name Tauri's permissions know, then the older spelling (as @tauri-apps/api does).
  const args = { event: 'back-button', handler };
  void tauri
    .invoke('plugin:app|register_listener', args)
    .catch(() => tauri.invoke('plugin:app|registerListener', args))
    .catch(() => {});
}

/** While `open`, the back button closes this (newest first). */
export function useBackClose(open: boolean, close: () => void) {
  // The latest close function, without re-registering (which would change the order).
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const entry = { close: () => latest.current() };
    closers.push(entry);
    return () => {
      const i = closers.indexOf(entry);
      if (i >= 0) closers.splice(i, 1);
    };
  }, [open]);
}
