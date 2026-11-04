import type { FilePosition } from '../lib/filePosition';
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { ApiError } from '../lib/api';
import type { CollabSession } from '../lib/collab';

// Shared by the document, spreadsheet and presentation editors. Each file's live content is a Yjs
// document ("file:<id>"), filled from the file once — by whoever opens it first — and then edited by
// everyone at once. The editors save back into the file itself, in its own format.

export type OfficeKind = 'document' | 'spreadsheet' | 'presentation';

export interface OfficeFile {
  id: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  /** Where this person stopped in it. */
  position?: { position: FilePosition } | null;
}

export const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
export const baseName = (name: string) => name.replace(/\.[a-z0-9]+$/i, '');

async function failed(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  return new ApiError(res.status, data?.error ?? fallback);
}

/** The stored file's bytes. */
export async function fileBytes(file: OfficeFile): Promise<ArrayBuffer> {
  const res = await fetch(file.url, { credentials: 'same-origin', cache: 'no-cache' });
  if (!res.ok) throw await failed(res, 'Could not open the file');
  return res.arrayBuffer();
}

/** The stored file converted by the server (LibreOffice), e.g. a .doc as HTML or a .xls as .xlsx. */
export async function convertStored(file: OfficeFile, to: string): Promise<ArrayBuffer> {
  const res = await fetch(`/api/files/${file.id}/convert?to=${to}`, { credentials: 'same-origin' });
  if (!res.ok) throw await failed(res, `Could not open this .${extOf(file.name)} file`);
  return res.arrayBuffer();
}

/** Bytes an editor produced, converted by the server to another format. */
export async function convertBytes(workspaceId: string, kind: OfficeKind, from: string, to: string, data: Blob | ArrayBuffer | Uint8Array, name: string): Promise<Blob> {
  const res = await fetch(`/api/workspaces/${workspaceId}/convert?kind=${kind}&from=${from}&to=${to}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data instanceof Blob ? data : new Blob([data as BlobPart]),
    credentials: 'same-origin',
  });
  if (!res.ok) throw await failed(res, `Could not make a .${to} file`);
  return res.blob();
}

/** Writes new contents into the stored file (optionally under a new name, e.g. .doc → .docx). */
export async function saveContent(fileId: string, data: Blob, name?: string) {
  const res = await fetch(`/api/files/${fileId}/content${name ? `?name=${encodeURIComponent(name)}` : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
    credentials: 'same-origin',
  });
  if (!res.ok) throw await failed(res, 'Could not save the file');
  return (await res.json()) as { name: string; size: number };
}

export function downloadBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export type LoadState = 'connecting' | 'waiting' | 'importing' | 'ready' | 'error';

/**
 * Makes sure the file's live content has been filled from the file: the first person to open it runs
 * `load` (which writes into the doc); everyone else waits until that's done.
 */
export function useLoadedDoc(session: CollabSession | null, synced: boolean, fileId: string, load: (doc: Y.Doc) => Promise<void>) {
  const [state, setState] = useState<LoadState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    if (!session || !synced) return;
    const meta = session.doc.getMap<unknown>('office');
    if (meta.get('ready')) return setState('ready');
    let stopped = false;
    const token = crypto.randomUUID();
    const onMeta = () => meta.get('ready') && !stopped && setState('ready');
    meta.observe(onMeta);

    const attempt = async () => {
      if (stopped || meta.get('ready')) return;
      try {
        const res = await fetch(`/api/files/${fileId}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'same-origin' });
        const { granted } = (await res.json()) as { granted: boolean };
        if (stopped || meta.get('ready')) return;
        if (!granted) {
          setState('waiting');
          setTimeout(attempt, 4000); // someone else is loading it; check again in case they left
          return;
        }
        setState('importing');
        await loader.current(session.doc);
        session.doc.transact(() => meta.set('ready', true));
        if (!stopped) setState('ready');
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : 'Could not open this file');
        setState('error');
      }
    };
    attempt();
    return () => {
      stopped = true;
      meta.unobserve(onMeta);
    };
  }, [session, synced, fileId]);

  return { state, error };
}

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

/**
 * Saves the file a few seconds after this person stops editing (and at least every 30 seconds while
 * they keep going), so the stored file always matches. Changes are noticed as soon as the file is open
 * (`ready`), but nothing is written until this person has actually interacted with it (`armed`), so
 * just opening a file never rewrites it. Only people who made changes save.
 */
export function useAutosave(session: CollabSession | null, ready: boolean, armed: boolean, save: () => Promise<void>) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const saver = useRef(save);
  saver.current = save;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const first = useRef(0);

  const run = async () => {
    if (!dirty.current || !armedRef.current) return;
    if (saving.current) return saving.current;
    dirty.current = false;
    setStatus('saving');
    saving.current = saver
      .current()
      .then(() => setStatus(dirty.current ? 'unsaved' : 'saved'))
      .catch(() => {
        dirty.current = true;
        setStatus('error');
      })
      .finally(() => (saving.current = null));
    return saving.current;
  };

  const schedule = () => {
    if (!armedRef.current || !dirty.current) return;
    first.current ||= Date.now();
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        first.current = 0;
        run();
      },
      Date.now() - first.current > 30_000 ? 0 : 4000,
    );
  };

  // Becoming armed with changes already made (e.g. the keystroke that armed it): save those too.
  useEffect(() => {
    if (armed) schedule();
  }, [armed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session || !ready) return;
    const onUpdate = (_: Uint8Array, origin: unknown) => {
      if (origin === session.provider) return; // someone else's change; they save it
      dirty.current = true;
      if (armedRef.current) setStatus('unsaved');
      schedule();
    };
    session.doc.on('update', onUpdate);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (armedRef.current && (dirty.current || saving.current)) {
        run();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearTimeout(timer.current);
      session.doc.off('update', onUpdate);
      window.removeEventListener('beforeunload', beforeUnload);
      if (dirty.current) run();
    };
  }, [session, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status,
    saveNow: () => {
      dirty.current = true;
      armedRef.current = true;
      return run();
    },
  };
}

/** What every editor offers the surrounding screen: saving and downloading in other formats. */
export interface EditorHandle {
  /** The file in its own format (or the nearest one this app can write), for saving. */
  exportOriginal: () => Promise<{ blob: Blob; name: string }>;
  /** Formats offered under "Download as". */
  formats: { ext: string; label: string }[];
  exportAs: (ext: string) => Promise<Blob>;
}
