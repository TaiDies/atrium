// Running inside the Windows or Android app. There, this web app is served from inside the app, and
// requests to /api are passed on (by the app) to the server the person chose — so the rest of the code
// works exactly as on the web. Only the live-editing connection goes to the server directly, and the
// app tells us where that is and which session to use.

export interface NativeInfo {
  /** The chosen server, e.g. "http://192.168.1.20:3000"; null until one is picked. */
  server: string | null;
  /**
   * A ticket that only opens the live-editing connections (fetched from the server; the app keeps the
   * real session to itself and adds it to requests it passes on).
   */
  ticket?: string | null;
  platform: string;
  version: string;
}

let info: NativeInfo | null = null;

interface TauriInternals {
  invoke(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<unknown>;
}
const tauri = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

// Android's WebView drops the body of requests the app answers itself, so in the apps every request
// to /api or /__app that has a body goes to the app over IPC instead (it ends up in the same place).
if (tauri && typeof window !== 'undefined') {
  const plain = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const ours = url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__app/'));
    if (!ours || req.method === 'GET' || req.method === 'HEAD') return plain(input, init);
    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length) return plain(input, init);

    const headers: Record<string, string> = { 'x-method': req.method, 'x-path': url.pathname + url.search };
    const type = req.headers.get('content-type');
    if (type) headers['x-content-type'] = type;
    let reply: unknown;
    try {
      reply = await tauri.invoke('api', body, { headers });
    } catch {
      throw new TypeError('Failed to fetch');
    }
    // A 4-byte length, the JSON {status, headers}, then the body. Android delivers it as a number array.
    const raw = reply instanceof ArrayBuffer ? new Uint8Array(reply) : new Uint8Array(reply as number[]);
    const size = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
    const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + size))) as { status: number; headers: [string, string][] };
    const empty = meta.status === 204 || meta.status === 304;
    return new Response(empty ? null : raw.slice(4 + size), { status: meta.status, headers: meta.headers });
  };
}

/** Whether this is the installed app (it answers /__app/info); false on the web. */
export const isNativeApp = () => info !== null;
export const nativeInfo = () => info;

/** Asks the app for its server and session. Call on start-up and after signing in or out. */
export async function loadNative(): Promise<NativeInfo | null> {
  try {
    const res = await fetch('/__app/info', { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return (info = null);
    info = (await res.json()) as NativeInfo;
  } catch {
    info = null;
  }
  if (info?.server) {
    try {
      const t = await fetch('/api/auth/live-ticket', { cache: 'no-store', credentials: 'same-origin' });
      info.ticket = t.ok ? ((await t.json()) as { ticket: string }).ticket : null;
    } catch {
      info.ticket = null;
    }
  }
  return info;
}

/** Where live editing connects: this site's /collab on the web, the chosen server in the apps. */
export function collabUrl(path = '/collab'): string {
  if (info?.server) {
    const base = info.server.replace(/^http/, 'ws').replace(/\/$/, '');
    return `${base}${path}${info.ticket ? `?ticket=${encodeURIComponent(info.ticket)}` : ''}`;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

/** Picks (or changes) the server the app talks to. The app checks it first and reloads. */
export async function chooseServer(server: string): Promise<{ ok: boolean; error?: string; name?: string }> {
  const res = await fetch('/__app/server', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server }) });
  return res.json();
}

/** Forgets the chosen server and its session (back to the server picker). */
export async function forgetServer() {
  await fetch('/__app/server', { method: 'DELETE' });
}

/** Calls one of the app's own commands (only in the Windows and Android apps). */
export function nativeInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  if (!tauri) return Promise.reject(new Error('Not in the app'));
  return tauri.invoke(cmd, args) as Promise<T>;
}
