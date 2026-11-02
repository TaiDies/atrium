import { useEffect, useState } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { CollabSession } from './collab';

// Reading a published page (or one of its cards) without an account: its saved state, loaded once,
// shown read-only.

export interface PublicPageInfo {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  icon: string;
  cover: string | null;
}

/** A page from a published link, loaded into a document the editor can show. */
export function usePublicDoc(token: string, pageId: string, rowId?: string) {
  const [state, setState] = useState<{ session: CollabSession | null; error: boolean }>({ session: null, error: false });
  useEffect(() => {
    let cancelled = false;
    const doc = new Y.Doc();
    setState({ session: null, error: false });
    fetch(`/api/public/pages/${token}/docs/${pageId}${rowId ? `?rowId=${encodeURIComponent(rowId)}` : ''}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length) Y.applyUpdate(doc, bytes);
        // The editor expects a provider with awareness; nobody else is there to see.
        if (!cancelled) setState({ session: { doc, provider: { awareness: new Awareness(doc) } } as unknown as CollabSession, error: false });
      })
      .catch(() => !cancelled && setState({ session: null, error: true }));
    return () => {
      cancelled = true;
      doc.destroy();
    };
  }, [token, pageId, rowId]);
  return state;
}

/** Where a published page's images and files come from. */
export const publicFileUrl = (token: string, url: string) => url.replace(/\/api\/files\/([0-9a-f-]{36})/i, `/api/public/pages/${token}/files/$1`);
