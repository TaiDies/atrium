import { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useRef, useState } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import type { User } from './api';
import { collabUrl, onTicketRenewed, renewTicket } from './native';
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
    // A connection closed before it opened is, in the apps, usually an expired ticket: get a fresh one
    // (reconnections then use it, see below).
    let opened = false;
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: pageId,
      document: doc,
      token: 'session-cookie',
      onOpen: () => {
        opened = true;
      },
      onClose: () => {
        if (!opened) void renewTicket('refused');
        opened = false;
      },
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
    // In the apps, reconnections use the latest live ticket.
    const stopRenewal = onTicketRenewed(() => {
      const socket = provider.configuration.websocketProvider as unknown as { configuration: { url: string } };
      socket.configuration.url = collabUrl();
    });
    return () => {
      clearTimeout(fallback);
      stopWatching();
      const close = () => {
        stopRenewal();
        provider.destroy();
        void local.destroy();
        doc.destroy();
      };
      // Files still uploading into this page (the person moved on before they finished): keep the
      // document connected until they're done, so their links land in the right blocks.
      const pending = holds.get(doc);
      if (pending?.size) void Promise.allSettled([...pending]).then(close);
      else close();
    };
  }, [pageId, user.id, user.name, user.color]);

  return { session, synced, status, denied };
}

const holds = new WeakMap<Y.Doc, Set<Promise<unknown>>>();

/** Keeps a page's document open until `work` is done, even if the page is closed meanwhile. */
export function holdDoc(doc: Y.Doc, work: Promise<unknown>) {
  let set = holds.get(doc);
  if (!set) holds.set(doc, (set = new Set()));
  set.add(work);
  const release = () => set.delete(work);
  work.then(release, release);
}

/**
 * Sets props of one block straight in the document (the editor's structure: blockGroup → blockContainer
 * with the block's id → its content element, whose attributes are the props). Used when an upload
 * finishes after its page was closed, since the editor that started it is gone. Props that already have
 * a value are left alone (someone set them since). Returns whether the block was found.
 */
export function fillBlockProps(doc: Y.Doc, blockId: string, props: Record<string, string>): boolean {
  if (doc.isDestroyed) return false;
  const find = (group: Y.XmlElement | Y.XmlFragment): Y.XmlElement | null => {
    for (const child of group.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'blockGroup') {
        const hit = find(child);
        if (hit) return hit;
      } else if (child.nodeName === 'blockContainer') {
        if (child.getAttribute('id') === blockId) return child;
        const nested = child.toArray().find((c) => c instanceof Y.XmlElement && c.nodeName === 'blockGroup') as Y.XmlElement | undefined;
        const hit = nested && find(nested);
        if (hit) return hit;
      }
    }
    return null;
  };
  const container = find(doc.getXmlFragment('document-store'));
  const content = container?.toArray().find((c) => c instanceof Y.XmlElement && c.nodeName !== 'blockGroup') as Y.XmlElement | undefined;
  if (!content) return false;
  doc.transact(() => {
    for (const [k, v] of Object.entries(props)) if (!content.getAttribute(k)) content.setAttribute(k, v);
  });
  return true;
}

// ---------- blocks being uploaded into ----------
// While a file is uploading into a block, the block is listed in the document's "uploads" map (shared
// with every device that has the page open), so nobody starts another upload into it meanwhile.

export interface BlockUpload {
  name: string;
  sent: number;
  total: number;
  /** When the uploading device last refreshed it (its own clock; not used for staleness). */
  at: number;
}
const UPLOAD_STALE_MS = 2 * 60 * 1000;

/**
 * When this device last saw each entry change, by its own clock: an entry that stops changing (the
 * upload died with its tab) goes stale. Comparing with the uploader's timestamps would depend on both
 * devices' clocks agreeing.
 */
const seenAt = new WeakMap<Y.Doc, Map<string, number>>();
function seen(doc: Y.Doc) {
  let map = seenAt.get(doc);
  if (!map) {
    const times = new Map<string, number>();
    seenAt.set(doc, (map = times));
    doc.getMap<BlockUpload>('uploads').observe((e) => e.keysChanged.forEach((k) => times.set(k, Date.now())));
  }
  return map;
}

/** The upload going into a block right now, if any. */
export function blockUpload(doc: Y.Doc, blockId: string): BlockUpload | null {
  const entry = doc.getMap<BlockUpload>('uploads').get(blockId);
  if (!entry) return null;
  const times = seen(doc);
  // Already there when this device opened the page: count from now.
  if (!times.has(blockId)) times.set(blockId, Date.now());
  return Date.now() - times.get(blockId)! < UPLOAD_STALE_MS ? entry : null;
}

/** Lists a block as being uploaded into until `finish` is called; `progress` keeps the entry fresh. */
export function markBlockUploading(doc: Y.Doc, blockId: string, name: string, total: number) {
  const map = doc.getMap<BlockUpload>('uploads');
  let sent = 0;
  let written = 0;
  const write = () => {
    if (doc.isDestroyed) return;
    written = Date.now();
    map.set(blockId, { name, sent, total, at: written });
  };
  write();
  // Still alive even when no progress is reported for a while (the server converting a big file).
  const beat = setInterval(write, 20_000);
  return {
    progress(n: number) {
      sent = n;
      if (Date.now() - written > 1000) write();
    },
    finish() {
      clearInterval(beat);
      if (!doc.isDestroyed) map.delete(blockId);
    },
  };
}

/** Re-renders when the document's uploads change. */
export function useBlockUpload(doc: Y.Doc, blockId: string) {
  const [entry, setEntry] = useState(() => blockUpload(doc, blockId));
  useEffect(() => {
    const map = doc.getMap<BlockUpload>('uploads');
    const update = () => setEntry(blockUpload(doc, blockId));
    update();
    map.observe(update);
    // An entry that stops changing goes stale with no event: look again now and then.
    const timer = setInterval(update, 15_000);
    return () => {
      map.unobserve(update);
      clearInterval(timer);
    };
  }, [doc, blockId]);
  return entry;
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
