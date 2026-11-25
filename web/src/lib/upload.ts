// Sending big files in pieces. Proxies in front of a server often refuse requests over a certain size
// (Cloudflare: 100 MB), so a file bigger than one piece goes up as several requests to /api/uploads,
// and the request that would have carried it names the finished upload instead (?upload=<id>).
// See server/src/uploads.ts.

import { useSyncExternalStore } from 'react';
import { checkConnection, OfflineError, trackedFetch } from './offline';
import { APP_FETCH_HEADER } from './appFetch';

/** What a file is for: the server refuses one it won't accept before any of it is sent. */
export type UploadKind = 'file' | 'content' | 'import';

/** The piece size when the server doesn't say (it sends its own when an upload starts). */
const DEFAULT_PIECE_BYTES = 16 * 1024 * 1024;

type Chunking = { chunked: boolean; pieceBytes: number };
let chunking: { at: number; value: Promise<Chunking> } | null = null;

/**
 * Whether this server wants big files sent in pieces, and how big each piece is (admin panel → Limits;
 * off unless the admin turns it on). Asked once a minute at most; a failed check is asked again next time.
 */
function chunkingSettings(): Promise<Chunking> {
  if (chunking && Date.now() - chunking.at < 60_000) return chunking.value;
  // Uploads started at the same moment share this one check, so it never rejects: if it fails they all
  // send in one piece, and the next upload asks again.
  const value: Promise<Chunking> = fetch('/api/auth/options', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((o: { uploads?: { chunked?: boolean; chunkMb?: number } }) => ({
      chunked: !!o.uploads?.chunked,
      pieceBytes: (o.uploads?.chunkMb ?? 16) * 1024 * 1024,
    }))
    .catch(() => {
      if (chunking?.value === value) chunking = null;
      return { chunked: false, pieceBytes: DEFAULT_PIECE_BYTES };
    });
  chunking = { at: Date.now(), value };
  return value;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const errorOf = async (res: Response, fallback: string) => {
  const data = await res.json().catch(() => null);
  return new UploadError(res.status, data?.error ?? fallback);
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends `file` to the server in pieces and returns the upload's id, to pass as `?upload=` to the route
 * that wants the file. A piece that fails (dropped connection, proxy hiccup) is tried again, carrying
 * on from what the server already has.
 */
export async function sendInPieces(file: Blob, name: string, onProgress?: (sent: number, total: number) => void, kind?: UploadKind): Promise<string> {
  const start = await trackedFetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || 'file', type: file.type || 'application/octet-stream', size: file.size, ...(kind ? { kind } : {}) }),
    credentials: 'same-origin',
  });
  if (!start.ok) throw await errorOf(start, 'Upload failed');
  const { id, chunkBytes } = (await start.json()) as { id: string; chunkBytes: number };
  const piece = chunkBytes || DEFAULT_PIECE_BYTES;
  let offset = 0;
  let failures = 0;
  try {
    while (offset < file.size) {
      const end = Math.min(file.size, offset + piece);
      let res: Response | null = null;
      try {
        // Sent with XMLHttpRequest so the bar moves while each piece goes up, not only when it's done.
        const from = offset;
        res = await sendWithProgress(`/api/uploads/${id}?offset=${from}`, 'PUT', file.slice(from, end), { 'Content-Type': 'application/octet-stream' }, (loaded) =>
          onProgress?.(from + loaded, file.size),
        );
      } catch (err) {
        if (++failures > 4) {
          // The connection is gone: say so (and let the app show it's offline), as other requests do.
          if (err instanceof TypeError) {
            void checkConnection();
            throw new OfflineError();
          }
          throw err;
        }
      }
      if (res?.ok) {
        offset = ((await res.json()) as { received: number }).received;
        failures = 0;
        onProgress?.(offset, file.size);
        continue;
      }
      // Out of step with the server (a reply that got lost): ask where it is and carry on from there.
      if (res && res.status !== 409 && res.status < 500) throw await errorOf(res, 'Upload failed');
      if (res && ++failures > 4) throw await errorOf(res, 'Upload failed');
      await wait(1000 * failures);
      const status = await trackedFetch(`/api/uploads/${id}`, { credentials: 'same-origin' }).catch(() => null);
      if (status?.ok) offset = ((await status.json()) as { received: number }).received;
    }
  } catch (err) {
    void trackedFetch(`/api/uploads/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    throw err;
  }
  return id;
}

/** `url` with `?upload=<id>` added. */
export const withUpload = (url: string, id: string) => `${url}${url.includes('?') ? '&' : '?'}upload=${id}`;

// ---------- progress ----------
// Every upload goes through sendFile(), which reports how far it has got here; UploadProgress.tsx shows
// the list in the corner of the screen.

export interface UploadItem {
  id: number;
  name: string;
  sent: number;
  total: number;
  /** sending → processing (all bytes sent, the server is storing or converting the file) → done/failed */
  state: 'sending' | 'processing' | 'done' | 'failed';
  /** Why it failed, as the server put it (e.g. the size limit). */
  error?: string;
  started: number;
}

let items: UploadItem[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let nextId = 1;

function update(id: number, patch: Partial<UploadItem>) {
  items = items.map((it) => (it.id === id ? { ...it, ...patch } : it));
  emit();
}

function track(name: string, total: number) {
  const id = nextId++;
  items = [...items, { id, name: name || 'file', sent: 0, total, state: 'sending', started: Date.now() }];
  emit();
  const finish = (state: 'done' | 'failed', error?: string) => {
    update(id, { state, error, ...(state === 'done' ? { sent: total } : {}) });
    setTimeout(() => {
      items = items.filter((it) => it.id !== id);
      emit();
    }, state === 'done' ? 1500 : 8000);
  };
  return {
    progress: (sent: number) => update(id, { sent: Math.min(sent, total), state: sent >= total ? 'processing' : 'sending' }),
    processing: () => update(id, { sent: total, state: 'processing' }),
    done: () => finish('done'),
    failed: (error?: string) => finish('failed', error),
  };
}

/** The uploads in progress (and those that just finished), for the progress panel. */
export function useUploads() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => items,
  );
}

/** One request with upload progress (fetch() can't report it), answered as a normal Response. */
function sendWithProgress(url: string, method: string, body: Blob | FormData, headers: Record<string, string>, onProgress: (sent: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    xhr.responseType = 'blob';
    // The app's own request (see appFetch.ts): converted files come back as plain data download managers leave alone.
    if (url.startsWith('/api/')) xhr.setRequestHeader(APP_FETCH_HEADER, '1');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      const h = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
        const at = line.indexOf(':');
        if (at > 0) h.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      const status = xhr.status >= 200 && xhr.status <= 599 ? xhr.status : 502;
      resolve(new Response(status === 204 || status === 304 ? null : xhr.response, { status, statusText: xhr.statusText, headers: h }));
    };
    xhr.onerror = () => reject(new TypeError('Failed to fetch'));
    xhr.onabort = () => reject(new DOMException('The upload was stopped', 'AbortError'));
    xhr.send(body);
  });
}

/**
 * Sends a file to `url` with progress shown on screen: as one request when it's small (as a form field
 * named "file", or as the raw body), or in pieces first when the server has that turned on (admin
 * panel) and the file is bigger than a piece, so proxies
 * that cap request sizes don't refuse it. Returns the route's answer.
 */
export async function sendFile(opts: { url: string; file: Blob; name: string; kind: UploadKind; method?: 'POST' | 'PUT'; as?: 'form' | 'body'; onProgress?: (sent: number, total: number) => void }): Promise<Response> {
  const { url, file, name, kind, method = 'POST', as = 'form', onProgress } = opts;
  const tracked = track(name, file.size);
  const t = { ...tracked, progress: (sent: number) => (tracked.progress(sent), onProgress?.(sent, file.size)) };
  try {
    let res: Response;
    const { chunked, pieceBytes } = await chunkingSettings();
    if (chunked && file.size > pieceBytes) {
      const id = await sendInPieces(file, name, (sent) => t.progress(sent), kind);
      t.processing();
      res = await trackedFetch(withUpload(url, id), { method, credentials: 'same-origin' });
    } else if (as === 'form') {
      const form = new FormData();
      form.append('file', file, name || 'file');
      res = await sendWithProgress(url, method, form, {}, t.progress);
    } else {
      res = await sendWithProgress(url, method, file, { 'Content-Type': 'application/octet-stream' }, t.progress);
    }
    if (res.ok) t.done();
    else t.failed(((await res.clone().json().catch(() => null)) as { error?: string } | null)?.error);
    return res;
  } catch (err) {
    t.failed(err instanceof Error ? err.message : undefined);
    throw err;
  }
}
