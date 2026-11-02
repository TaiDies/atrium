// Talking to the admin panel's own server (/admin-api on the admin port).

export class AdminError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onSignedOut: () => void = () => {};

/** Called when a request finds the admin signed out. */
export function setSignedOutHandler(fn: () => void) {
  onSignedOut = fn;
}

export async function adminApi<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/admin-api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/login') onSignedOut();
  if (!res.ok) throw new AdminError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
