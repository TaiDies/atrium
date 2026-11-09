import { createHmac } from 'node:crypto';
import { query } from './db.js';
import { outboundFetch } from './netGuard.js';
import { config } from './config.js';
import { HttpError } from './util.js';

// Webhooks: when something happens in a workspace, a JSON POST goes to each address set up for it,
// signed with the webhook's secret (header X-Signature: sha256=<hex HMAC of the body>).

export const WEBHOOK_EVENTS = [
  'page.created',
  'page.updated',
  'page.trashed',
  'event.created',
  'event.updated',
  'event.deleted',
  'task.completed',
  'file.uploaded',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const TIMEOUT_MS = 10_000;

export function signature(secret: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * What went wrong with a delivery, in words that don't echo what an internal host said: our own
 * messages (refused addresses), or a short description of the network error.
 */
export function deliveryError(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'No answer within 10 seconds';
  const code = e?.cause?.code ?? '';
  if (code === 'ECONNREFUSED') return 'The address refused the connection';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That address could not be found';
  if (code.startsWith('CERT_') || code.includes('TLS') || code.includes('SSL') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'The address has an invalid HTTPS certificate';
  return 'Could not connect to the address';
}

/** Sends one delivery and notes how it went. */
export async function deliver(hook: { id: string; url: string; secret: string }, event: string, workspaceId: string, data: unknown) {
  const body = JSON.stringify({ event, workspaceId, at: new Date().toISOString(), data });
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await outboundFetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `${config.appName}-webhooks/1`, 'x-event': event, 'x-signature': signature(hook.secret, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    }, { private: 'allow', what: 'Webhook' });
    status = res.status;
    if (!res.ok) error = `The address answered ${res.status}`;
  } catch (err) {
    error = deliveryError(err);
  }
  await query('update webhooks set last_status = $2, last_error = $3, last_sent_at = now() where id = $1', [hook.id, status, error]).catch(() => {});
  return { status, error };
}

/** Tells the workspace's webhooks about something that happened (never holds up the request). */
export function emit(workspaceId: string, event: WebhookEvent, data: unknown) {
  void (async () => {
    const hooks = await query<{ id: string; url: string; secret: string }>(
      `select id, url, secret from webhooks where workspace_id = $1 and active and (cardinality(events) = 0 or $2 = any(events))`,
      [workspaceId, event],
    );
    for (const hook of hooks) await deliver(hook, event, workspaceId, data);
  })().catch((err) => console.error('Webhook delivery failed', err));
}
