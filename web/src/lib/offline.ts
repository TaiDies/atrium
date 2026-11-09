import { onlineManager } from '@tanstack/react-query';
import { createStore, del, get, set } from 'idb-keyval';
import { useSyncExternalStore } from 'react';
import { healthOk, isNetworkFailure, isUnreachable, outboxVerdict } from './reachability';

// Working without a connection. Live documents (pages, cards, whiteboards, files) keep a copy on the
// device and merge with everyone else's edits when the connection returns (see collab.ts). Changes
// that go through the API instead — making, renaming, moving or deleting pages — wait here, in order,
// and are sent as soon as the server can be reached.

// The database keeps its name from before 1.9.0 ("af-"): renaming it would lose changes still waiting to be sent.
const store = createStore('af-offline', 'kv');

/** Each server (and the web app on each address) keeps its own local data. */
export const scope = () => location.host;

// ---------- reachability ----------

let online = typeof navigator === 'undefined' ? true : navigator.onLine;
let pending = 0;
let syncing = false;
const listeners = new Set<() => void>();
let snapshot = { online, pending, syncing };
const emit = () => {
  snapshot = { online, pending, syncing };
  listeners.forEach((l) => l());
};

// Lists and pages wait (keeping what's cached) instead of failing while the server can't be reached.
onlineManager.setEventListener((setOnline) => {
  const update = () => setOnline(online);
  listeners.add(update);
  update();
  return () => listeners.delete(update);
});

let probe: ReturnType<typeof setTimeout> | undefined;

export function markOnline() {
  clearTimeout(probe);
  if (online) return;
  online = true;
  emit();
  void flush();
}

export function markOffline() {
  if (!online) return;
  online = false;
  emit();
  scheduleProbe();
}

/** While offline, check every 10 seconds whether the server is back. */
function scheduleProbe() {
  clearTimeout(probe);
  probe = setTimeout(async () => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok && !res.headers.get('x-offline')) return markOnline();
    } catch {
      // still unreachable
    }
    scheduleProbe();
  }, 10_000);
}

/** Checks now whether the server can be reached (e.g. after a live connection dropped). */
export async function checkConnection() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok && !res.headers.get('x-offline')) return markOnline();
  } catch {
    // unreachable
  }
  markOffline();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => scheduleProbe());
  window.addEventListener('offline', () => markOffline());
}

/** A request that failed because the server couldn't be reached (not because it said no). */
export class OfflineError extends Error {
  constructor() {
    super('You’re offline — this needs a connection to the server');
  }
}

/** fetch() that keeps track of whether the server is reachable. */
export async function trackedFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // Only a network failure (TypeError) means offline: a cancelled request or the app's own error doesn't.
    if (!isNetworkFailure(err)) throw err;
    markOffline();
    throw new OfflineError();
  }
  // The desktop and phone apps' x-offline header, or a proxy answering for a server that's down
  // (confirmed with the health check: a proxy also rewrites errors and cuts slow requests).
  if (await isUnreachable(res, () => healthOk())) {
    markOffline();
    throw new OfflineError();
  }
  markOnline();
  return res;
}

// ---------- the outbox ----------

export interface QueuedChange {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  /** What it was, for the "couldn't apply" message. */
  label: string;
  user: string;
  at: number;
}

const OUTBOX = () => `outbox:${scope()}`;
let currentUser = '';

export function setOfflineUser(userId: string | null) {
  currentUser = userId ?? '';
  void countPending().then(() => flush());
}

async function readOutbox(): Promise<QueuedChange[]> {
  return ((await get(OUTBOX(), store)) as QueuedChange[] | undefined) ?? [];
}

async function writeOutbox(items: QueuedChange[]) {
  if (items.length) await set(OUTBOX(), items, store);
  else await del(OUTBOX(), store);
  pending = items.filter((i) => i.user === currentUser).length;
  emit();
}

async function countPending() {
  pending = (await readOutbox()).filter((i) => i.user === currentUser).length;
  emit();
}

/**
 * Runs `fn` with the outbox to itself: one change at a time in this tab (a promise chain) and across
 * tabs (a Web Lock, where the browser has them), so a change queued during a send is never lost to a
 * write made from an older copy.
 */
let chain: Promise<unknown> = Promise.resolve();
function withOutbox<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  const run = () => (locks ? (locks.request(`atrium-outbox:${scope()}`, fn) as Promise<T>) : fn());
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

export async function enqueue(change: Omit<QueuedChange, 'id' | 'user' | 'at'>) {
  await withOutbox(async () => {
    const items = await readOutbox();
    items.push({ ...change, id: crypto.randomUUID(), user: currentUser, at: Date.now() });
    await writeOutbox(items);
  });
}

/** Takes a sent change off the outbox (reading it fresh, so changes queued meanwhile stay). */
const removeQueued = (id: string) => withOutbox(async () => writeOutbox((await readOutbox()).filter((i) => i.id !== id)));

type Applied = (changes: QueuedChange[], failed: { change: QueuedChange; error: string }[]) => void;
const appliedListeners = new Set<Applied>();
/** Called after queued changes have been sent (to refresh lists and report anything refused). */
export function onApplied(fn: Applied) {
  appliedListeners.add(fn);
  return () => {
    appliedListeners.delete(fn);
  };
}

let flushing: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;

/** The server is busy or limiting us: try again in a while. */
function retryLater(ms = 30_000) {
  clearTimeout(retry);
  retry = setTimeout(() => void flush(), ms);
}

/**
 * Sends queued changes in the order they were made, until none are left. Stops (keeping the rest) when
 * the server can't be reached, isn't signed in (401: they wait for the next sign-in), or asks us to
 * slow down or is having trouble (408, 425, 429, 5xx: tried again later). A change the server refuses
 * for good (e.g. the page was deleted) is dropped and reported.
 */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const done: QueuedChange[] = [];
    const failed: { change: QueuedChange; error: string }[] = [];
    let started = false;
    for (;;) {
      if (!online || !currentUser) break;
      const change = (await readOutbox()).find((i) => i.user === currentUser);
      if (!change) break;
      if (!started) {
        started = true;
        syncing = true;
        emit();
      }
      let res: Response;
      try {
        res = await trackedFetch(change.path, {
          method: change.method,
          headers: change.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: change.body !== undefined ? JSON.stringify(change.body) : undefined,
          credentials: 'same-origin',
        });
      } catch {
        break; // offline again; the rest wait
      }
      const verdict = outboxVerdict(res.status);
      if (verdict === 'wait-for-sign-in') break; // kept for the next sign-in (setOfflineUser sends them)
      if (verdict === 'retry-later') {
        retryLater();
        break;
      }
      if (verdict === 'refused') {
        const data = await res.json().catch(() => null);
        failed.push({ change, error: data?.error ?? `Request failed (${res.status})` });
      }
      done.push(change);
      await removeQueued(change.id);
    }
    if (started) {
      syncing = false;
      emit();
    }
    if (done.length) appliedListeners.forEach((fn) => fn(done, failed));
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/**
 * Sends a change now, or — when offline, or while earlier offline changes are still waiting — queues
 * it to be sent in order later. Returns the server's reply, or null when queued.
 */
export async function sendOrQueue<T>(method: string, path: string, body: unknown, label: string): Promise<T | null> {
  if (online && pending === 0) {
    try {
      const res = await trackedFetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const { ApiError } = await import('./api');
        throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
      }
      return data as T;
    } catch (err) {
      if (!(err instanceof OfflineError)) throw err;
    }
  }
  await enqueue({ method, path, body, label });
  void flush();
  return null;
}

/** Calls `cb` whenever the connection state changes; returns a function that stops it. */
export function onConnectionChange(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const subscribe = onConnectionChange;

/** Whether the server can be reached, how many changes are waiting, and whether they're being sent. */
export function useConnection() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export const isOnline = () => online;

// ---------- the local cache of lists (page tree, workspaces…) ----------

/** Storage for the saved query cache, so lists show while offline and right away on start-up. */
export const cacheStorage = {
  getItem: async (key: string) => ((await get(`${scope()}:${key}`, store)) as string | undefined) ?? null,
  setItem: (key: string, value: string) => set(`${scope()}:${key}`, value, store),
  removeItem: (key: string) => del(`${scope()}:${key}`, store),
};

const offlineKey = (userId: string) => `atrium-keep-offline:${scope()}:${userId}`;

/** Pages (with the pages inside them) kept downloaded on this device. */
export function offlinePages(userId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(offlineKey(userId)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function setKeptOffline(userId: string, pageId: string, keep: boolean) {
  const list = offlinePages(userId).filter((id) => id !== pageId);
  try {
    localStorage.setItem(offlineKey(userId), JSON.stringify(keep ? [...list, pageId] : list));
  } catch {}
}

/**
 * Signing out on this device: everything kept here for that person goes — their copies of pages
 * (y-indexeddb), waiting changes, the pages kept for offline use and the saved lists.
 */
export async function clearLocalData(userId: string | null | undefined) {
  if (userId) {
    try {
      localStorage.removeItem(offlineKey(userId));
    } catch {}
    const prefix = `af:${scope()}:${userId}:`;
    const dbs = await (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases?.().catch(() => []) ?? [];
    await Promise.all(
      dbs
        .map((d) => d.name ?? '')
        .filter((name) => name.startsWith(prefix))
        .map(
          (name) =>
            new Promise<void>((done) => {
              // A copy still open (a page closing) blocks the delete until it closes: wait a little for that.
              const r = indexedDB.deleteDatabase(name);
              r.onsuccess = r.onerror = () => done();
              setTimeout(done, 5000);
            }),
        ),
    );
    await withOutbox(async () => writeOutbox((await readOutbox()).filter((i) => i.user !== userId))).catch(() => {});
  }
  await del(`${scope()}:query-cache`, store).catch(() => {});
  pending = 0;
  emit();
}
