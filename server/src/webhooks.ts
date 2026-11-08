import { createHmac } from 'node:crypto';
import { query } from './db.js';
import { checkOutboundUrl } from './netGuard.js';

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

/** Sends one delivery and notes how it went. */
export async function deliver(hook: { id: string; url: string; secret: string }, event: string, workspaceId: string, data: unknown) {
  const body = JSON.stringify({ event, workspaceId, at: new Date().toISOString(), data });
  let status: number | null = null;
  let error: string | null = null;
  try {
    await checkOutboundUrl(hook.url, { private: 'allow', what: 'Webhook' });
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'workspace-webhooks/1', 'x-event': event, 'x-signature': signature(hook.secret, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    status = res.status;
    if (!res.ok) error = `The address answered ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
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
