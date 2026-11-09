import { isIP } from 'node:net';
// Simple sliding-window limits kept in memory (this server is one process): how many times a key (an
// IP address, an account) may do something in a window. Old keys are swept out every few minutes.

export interface Limiter {
  /** Whether the key has used up its tries (doesn't count one). */
  blocked(key: string): boolean;
  /** Counts one try for the key. */
  hit(key: string): void;
  /** Counts one try and says whether it was still allowed. */
  take(key: string): boolean;
  /** How many tries the key made in the window. */
  count(key: string): number;
  /** Forgets the key (e.g. after a successful sign-in). */
  clear(key: string): void;
}

/** How long to hold a sign-in for an account with this many recent wrong passwords: nothing for the first 5, then up to 5 s. */
export const loginDelayMs = (failures: number) => (failures <= 5 ? 0 : Math.min(5000, (failures - 5) * 500));

const all: { hits: Map<string, number[]>; windowMs: number }[] = [];

/**
 * The key a limit is counted under: an IPv6 address counts as its /64 (one home or server usually has
 * a whole /64, so each address in it isn't a new visitor); anything else as it is.
 */
export function limitKey(key: string): string {
  let v = key.trim().toLowerCase();
  if (v.startsWith('::ffff:') && isIP(v.slice(7)) === 4) return v.slice(7);
  if (isIP(v) !== 6) return key;
  v = v.replace(/%.*$/, '');
  const [head, rest] = v.includes('::') ? v.split('::') : [v, null];
  const h = head ? head.split(':') : [];
  const r = rest === null ? [] : rest ? rest.split(':') : [];
  const groups = [...h, ...new Array(Math.max(0, 8 - h.length - r.length)).fill('0'), ...r];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

export function limiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  all.push({ hits, windowMs });
  const recent = (raw: string) => {
    const key = limitKey(raw);
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };
  return {
    blocked: (key) => recent(key).length >= max,
    count: (key) => recent(key).length,
    hit: (key) => {
      const list = recent(key);
      list.push(Date.now());
      hits.set(limitKey(key), list);
    },
    take(key) {
      if (this.blocked(key)) return false;
      this.hit(key);
      return true;
    },
    clear: (key) => void hits.delete(limitKey(key)),
  };
}

setInterval(() => {
  const now = Date.now();
  for (const { hits, windowMs } of all) {
    for (const [key, list] of hits) if (!list.some((t) => now - t < windowMs)) hits.delete(key);
  }
}, 5 * 60_000).unref();
