// A hook the appearance and language settings call when they change, so they can be saved to the
// account (see accountPrefs.ts). Kept separate so theme.ts and i18n don't depend on the API code.

let handler: ((now: boolean) => void) | null = null;

/** Settings changed (`now`: save straight away, e.g. before the page reloads). */
export const prefsChanged = (now = false) => handler?.(now);

export const setPrefsHandler = (h: (now: boolean) => void) => {
  handler = h;
};
