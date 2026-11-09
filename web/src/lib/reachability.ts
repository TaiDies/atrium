// Telling "the server can't be reached" apart from "the server (or something behind it) had a
// problem". Kept free of browser storage so it can be tested on its own (see offline.ts).

/** Statuses a reverse proxy answers with when it can't get a reply from the server (Cloudflare adds 520–524). */
const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

/** Asks the server's health check, giving up quickly. */
export async function healthOk(fetchFn: typeof fetch = fetch, ms = 4000): Promise<boolean> {
  try {
    const res = await fetchFn('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(ms) });
    return res.ok && !res.headers.get('x-offline');
  } catch {
    return false;
  }
}

/**
 * Whether a reply means the server can't be reached. The desktop and phone apps say so with an
 * x-offline header. A gateway status without the server's own JSON error might be a proxy answering
 * for a server that's down, or a proxy replacing an error the server sent (Cloudflare does this to
 * 502s) or cutting a slow request (524): the health check decides.
 */
export async function isUnreachable(res: Response, healthy: () => Promise<boolean>): Promise<boolean> {
  if (res.headers.get('x-offline')) return true;
  if (!GATEWAY.has(res.status)) return false;
  const body = await res
    .clone()
    .json()
    .catch(() => null);
  if (body && typeof body.error === 'string') return false;
  return !(await healthy());
}

/** What to say for a failed reply that carries no message of its own. */
export function fallbackMessage(status: number) {
  if (status === 504 || status === 524) return 'The server took too long to answer. Try again.';
  if (GATEWAY.has(status)) return 'Something between you and the server had a problem. Try again.';
  return `Request failed (${status})`;
}

/** Whether a failed fetch means the network (TypeError), not a cancelled request or the app's own error. */
export const isNetworkFailure = (err: unknown) => err instanceof TypeError;

/**
 * What to do with a queued offline change after the server answered: sent (or refused for good and
 * reported), kept until the next sign-in (401), or kept and tried again later (busy or limiting us).
 */
export function outboxVerdict(status: number): 'done' | 'refused' | 'wait-for-sign-in' | 'retry-later' {
  if (status === 401) return 'wait-for-sign-in';
  if (status >= 500 || status === 408 || status === 425 || status === 429) return 'retry-later';
  return status >= 200 && status < 400 ? 'done' : 'refused';
}
