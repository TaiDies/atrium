// The app's own requests to this server are marked "X-Atrium-Fetch: 1". Download managers such as
// IDM watch the browser's traffic and take over anything that looks like a file download (a PDF, a
// Word file…), leaving the app an empty reply, so PDFs wouldn't open and download prompts popped up.
// For marked requests the server sends files as plain data with no file name, which they leave alone,
// and gives the real type in X-Atrium-Type (see server/src/index.ts). Links the person clicks are not
// marked, so they behave as before.

export const APP_FETCH_HEADER = 'X-Atrium-Fetch';

const ours = (url: string) => {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
};

/** Marks every fetch() the app makes to its own /api. Called once, before anything loads. */
export function markAppFetches() {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!ours(url)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(APP_FETCH_HEADER, '1');
    return original(input, { ...init, headers });
  };
}

/** A response's body as a Blob of its real type (the server sends app requests as plain data). */
export async function typedBlob(res: Response): Promise<Blob> {
  const blob = await res.blob();
  const type = res.headers.get('X-Atrium-Type');
  return type ? new Blob([blob], { type }) : blob;
}
