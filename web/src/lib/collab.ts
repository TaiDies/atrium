import { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useRef, useState } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import type { User } from './api';
import { collabUrl } from './native';
import { checkConnection, isOnline, onConnectionChange, scope } from './offline';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
}

export interface CollabSession {
  doc: Y.Doc;
  provider: HocuspocusProvider;
}

type Status = 'connecting' | 'connected' | 'disconnected';

/** How long to wait for the server before opening a document from the copy on this device. */
const LOCAL_FALLBACK_MS = 2500;

/**
 * Opens a real-time Yjs session for a page; everything typed is synced and saved by the server. Each
 * document also keeps a copy on this device, so it opens (and can be edited) without a connection; the
 * edits made offline merge with everyone else's when the connection returns — nothing is overwritten.
 */
export function useCollab(pageId: string, user: User, onPageUpdated: () => void) {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [synced, setSynced] = useState(false);
  const [status, setStatus] = useState<Status>('connecting');
  const [denied, setDenied] = useState(false);
  const callback = useRef(onPageUpdated);
  callback.current = onPageUpdated;

  useEffect(() => {
    const doc = new Y.Doc();
    let ready = false;
    const markReady = () => {
      if (!ready) {
        ready = true;
        setSynced(true);
      }
    };
    // The copy on this device (kept per server and per account).
    // Named "af:" since before 1.9.0; kept, so copies with unsent edits aren't left behind.
    const local = new IndexeddbPersistence(`af:${scope()}:${user.id}:${pageId}`, doc);
    let fallback: ReturnType<typeof setTimeout> | undefined;
    local.on('synced', () => {
      // Offline, or the server is slow: open what's on the device (if anything was saved before).
      const hasLocal = Y.encodeStateVector(doc).length > 1;
      if (!isOnline()) markReady();
      else if (hasLocal) fallback = setTimeout(markReady, LOCAL_FALLBACK_MS);
    });
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: pageId,
      document: doc,
      token: 'session-cookie',
      onSynced: markReady,
      onStatus: ({ status }) => {
        setStatus(status as Status);
        // The live connection dropped: find out whether the server is gone, so the app shows it's
        // offline and reconnects as soon as the server is back.
        if (status === 'disconnected' && isOnline()) void checkConnection();
      },
      onAuthenticationFailed: () => setDenied(true),
      onStateless: ({ payload }) => {
        try {
          if (JSON.parse(payload).type === 'page-updated') callback.current();
        } catch {}
      },
    });
    provider.awareness?.setLocalStateField('user', { name: user.name, color: user.color });
    // When the server is reachable again, reconnect now rather than waiting out the retry back-off.
    let wasOnline = isOnline();
    const stopWatching = onConnectionChange(() => {
      if (isOnline() && !wasOnline) void provider.connect();
      wasOnline = isOnline();
    });
    setSynced(false);
    setDenied(false);
    setStatus('connecting');
    setSession({ doc, provider });
    return () => {
      clearTimeout(fallback);
      stopWatching();
      provider.destroy();
      void local.destroy();
      doc.destroy();
    };
  }, [pageId, user.id, user.name, user.color]);

  return { session, synced, status, denied };
}

/** Other people currently viewing the same page (one entry per person). */
export function usePeers(provider: HocuspocusProvider | undefined): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) return;
    const update = () => {
      const seen = new Set<string>();
      const list: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const u = state.user as { name?: string; color?: string } | undefined;
        if (clientId === awareness.clientID || !u?.name) return;
        const key = `${u.name}|${u.color}`;
        if (seen.has(key)) return;
        seen.add(key);
        list.push({ clientId, name: u.name, color: u.color ?? '#888' });
      });
      setPeers(list);
    };
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [provider]);
  return peers;
}

/**
 * Brings pages' copies on this device up to date without opening them, so they're there offline
 * ("Keep offline" pages). One at a time, giving each a few seconds to sync.
 */
export async function downloadForOffline(pageIds: string[], user: User) {
  for (const pageId of pageIds) {
    if (!isOnline()) return;
    const doc = new Y.Doc();
    const local = new IndexeddbPersistence(`af:${scope()}:${user.id}:${pageId}`, doc);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      const provider = new HocuspocusProvider({
        url: collabUrl(),
        name: pageId,
        document: doc,
        token: 'session-cookie',
        onSynced: () => {
          clearTimeout(timer);
          // Give the device copy a moment to write what just arrived.
          setTimeout(() => {
            provider.destroy();
            resolve();
          }, 300);
        },
        onAuthenticationFailed: () => {
          clearTimeout(timer);
          provider.destroy();
          resolve();
        },
      });
    });
    await local.destroy();
    doc.destroy();
  }
}
