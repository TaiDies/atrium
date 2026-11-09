import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, requireOwner, requirePage, requireUnlocked } from '../access.js';
import { requireSession, requireUser } from '../auth.js';
import { editDoc, readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { guideFor } from '../aiGuide.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { writeMarkdown } from '../markdownBlocks.js';
import { databaseToCsv, docToMarkdown } from '../readable.js';
import { HttpError, idParams, parse } from '../util.js';
import { deliver, WEBHOOK_EVENTS } from '../webhooks.js';
import { requirePermission } from '../roles.js';

// Personal API tokens, webhooks, reading and writing pages as Markdown, and the API's own guide page.

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const isDatabase = (type: string) => (DATABASE_TYPES as readonly string[]).includes(type);


export async function apiRoutes(app: FastifyInstance) {
  // The guide, readable without signing in.
  app.get('/docs', async (_req, reply) => reply.header('content-type', 'text/html; charset=utf-8').send(apiGuide()));
  // How the whole app works, in Markdown (the built-in assistant's knowledge), for other programs and
  // AI assistants; ?topic=meetings gives just the matching sections.
  app.get('/guide', async (req, reply) => {
    const { topic } = parse(z.object({ topic: z.string().max(200).optional() }), req.query);
    return reply.header('content-type', 'text/markdown; charset=utf-8').send(guideFor(topic));
  });

  app.register(async (auth) => {
    auth.addHook('preHandler', requireUser);

    // ----- tokens -----
    auth.get('/auth/tokens', async (req) => {
      await requireSession(req);
      const tokens = await query(
        `select t.id, t.name, t.prefix, t.created_at as "createdAt", t.last_used_at as "lastUsedAt", t.expires_at as "expiresAt",
                t.workspace_id as "workspaceId", w.name as "workspaceName"
           from api_tokens t left join workspaces w on w.id = t.workspace_id where t.user_id = $1 order by t.created_at desc`,
        [req.user.id],
      );
      return { tokens };
    });

    auth.post('/auth/tokens', async (req) => {
      await requirePermission(req.user.id, 'api_tokens');
      await requireSession(req);
      const body = parse(
        z.object({
          name: z.string().trim().min(1, 'Give it a name').max(80),
          days: z.number().int().min(1).max(3650).nullable().default(null),
          /** Limit it to one workspace (e.g. one kept as an AI's memory). */
          workspaceId: z.uuid().nullable().default(null),
        }),
        req.body,
      );
      if (body.workspaceId) await requireMember(req.user.id, body.workspaceId, undefined, true);
      const count = await one<{ n: number }>('select count(*)::int as n from api_tokens where user_id = $1', [req.user.id]);
      if ((count?.n ?? 0) >= 50) throw new HttpError(400, 'You have 50 tokens already: delete some first');
      const token = `atr_${randomBytes(24).toString('base64url')}`;
      const row = await one<{ id: string }>(
        `insert into api_tokens (user_id, name, token_hash, prefix, expires_at, workspace_id, session_version)
         values ($1, $2, $3, $4, $5, $6, (select session_version from users where id = $1)) returning id`,
        [req.user.id, body.name, hashToken(token), token.slice(0, 9), body.days ? new Date(Date.now() + body.days * 86_400_000) : null, body.workspaceId],
      );
      // The only time the token itself is shown.
      return { id: row!.id, token };
    });

    auth.delete('/auth/tokens/:id', async (req) => {
      await requireSession(req);
      const { id } = parse(idParams, req.params);
      await query('delete from api_tokens where id = $1 and user_id = $2', [id, req.user.id]);
      return { ok: true };
    });

    // ----- webhooks (workspace owners) -----
    const hookBody = z.object({
      url: z.url('Enter the full address, starting with https://').refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) address').max(2000),
      events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).default([]),
      active: z.boolean().default(true),
    });

    auth.get('/workspaces/:id/webhooks', async (req) => {
      const { id } = parse(idParams, req.params);
      await requireOwner(req.user.id, id);
      const webhooks = await query(
        `select id, url, secret, events, active, last_status as "lastStatus", last_error as "lastError", last_sent_at as "lastSentAt", created_at as "createdAt"
           from webhooks where workspace_id = $1 order by created_at`,
        [id],
      );
      return { webhooks, events: WEBHOOK_EVENTS };
    });

    auth.post('/workspaces/:id/webhooks', async (req) => {
      const { id } = parse(idParams, req.params);
      await requireOwner(req.user.id, id);
      const body = parse(hookBody, req.body);
      const n = await one<{ n: number }>('select count(*)::int as n from webhooks where workspace_id = $1', [id]);
      if ((n?.n ?? 0) >= 20) throw new HttpError(400, 'A workspace can have up to 20 webhooks');
      const secret = `whsec_${randomBytes(20).toString('base64url')}`;
      const row = await one<{ id: string }>(
        'insert into webhooks (workspace_id, url, secret, events, active, created_by) values ($1, $2, $3, $4, $5, $6) returning id',
        [id, body.url, secret, body.events, body.active, req.user.id],
      );
      return { id: row!.id, secret };
    });

    async function hookOr404(userId: string, hookId: string) {
      const hook = await one<{ id: string; workspace_id: string; url: string; secret: string }>('select id, workspace_id, url, secret from webhooks where id = $1', [hookId]);
      if (!hook) throw new HttpError(404, 'Webhook not found');
      await requireOwner(userId, hook.workspace_id);
      return hook;
    }

    auth.patch('/webhooks/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      await hookOr404(req.user.id, id);
      const body = parse(hookBody.partial(), req.body);
      await query(
        'update webhooks set url = coalesce($2, url), events = coalesce($3, events), active = coalesce($4, active) where id = $1',
        [id, body.url ?? null, body.events ?? null, body.active ?? null],
      );
      return { ok: true };
    });

    auth.delete('/webhooks/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      await hookOr404(req.user.id, id);
      await query('delete from webhooks where id = $1', [id]);
      return { ok: true };
    });

    // A new signing secret (the old one stops working at once); shown this once.
    auth.post('/webhooks/:id/rotate-secret', async (req) => {
      const { id } = parse(idParams, req.params);
      const hook = await hookOr404(req.user.id, id);
      const secret = `whsec_${randomBytes(20).toString('base64url')}`;
      await query('update webhooks set secret = $2 where id = $1', [hook.id, secret]);
      return { id: hook.id, secret };
    });

    // Sends a "ping" right away, to check the address works.
    auth.post('/webhooks/:id/test', async (req) => {
      const { id } = parse(idParams, req.params);
      const hook = await hookOr404(req.user.id, id);
      return deliver(hook, 'ping', hook.workspace_id, { message: 'Test delivery' });
    });

    // ----- pages as Markdown -----
    auth.get('/pages/:id/markdown', async (req) => {
      const { id } = parse(idParams, req.params);
      const page = await requirePage(req.user.id, id, 'view');
      const isDb = isDatabase(page.type);
      const content = await readDoc(id, null, (doc) =>
        isDb ? databaseToCsv(doc) : docToMarkdown(doc, page.title, { pageLink: (p) => ({ title: p, href: null }), fileLink: () => null, eventLabel: () => null, boardLabel: () => null }),
      );
      return { id, title: page.title, type: page.type, format: isDb ? 'csv' : 'markdown', content };
    });

    // Adds Markdown to the end of a document page (or replaces what's there).
    auth.post('/pages/:id/markdown', async (req) => {
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ markdown: z.string().max(1_000_000), mode: z.enum(['append', 'replace']).default('append') }), req.body);
      const page = await requirePage(req.user.id, id, 'edit');
      if (page.type !== 'document') throw new HttpError(400, 'Only document pages take Markdown');
      await requireUnlocked(id);
      const blocks = await editDoc(id, null, (doc) => writeMarkdown(doc, body.markdown, body.mode === 'replace'), { editor: req.user.id });
      return { ok: true, blocks };
    });
  });
}

/** The API guide: how to sign in with a token, and the main endpoints. */
function apiGuide() {
  const rows: [string, string, string][] = [
    ['GET', '/api/auth/me', 'Who the token belongs to.'],
    ['GET', '/api/workspaces', 'Your workspaces.'],
    ['GET', '/api/workspaces/{workspaceId}/pages', 'Every page you can see (id, title, type, parentId, icon…).'],
    ['POST', '/api/workspaces/{workspaceId}/pages', 'New page. Body: {"title": "…", "type": "document" | "grid" | "board" | "calendar" | "list" | "gallery" | "timeline", "parentId": "…"}.'],
    ['GET', '/api/pages/{pageId}', 'One page’s details.'],
    ['PATCH', '/api/pages/{pageId}', 'Rename or change: {"title": "…", "icon": "📚", "parentId": "…"}.'],
    ['GET', '/api/pages/{pageId}/markdown', 'A document as Markdown (a database as CSV).'],
    ['POST', '/api/pages/{pageId}/markdown', 'Add to a document: {"markdown": "# Notes\\n- [ ] Task", "mode": "append" | "replace"}.'],
    ['POST', '/api/pages/{pageId}/trash', 'Move a page to the trash.'],
    ['GET', '/api/workspaces/{workspaceId}/search?q=…', 'Search pages and files.'],
    ['GET', '/api/workspaces/{workspaceId}/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD', 'Events, tasks, dated cards and dated to-dos.'],
    ['POST', '/api/workspaces/{workspaceId}/events', 'New event or task: {"title": "…", "startDate": "2026-12-01", "startTime": "09:00", "endTime": "10:00", "status": "todo" (makes it a task), "color": "blue"}.'],
    ['PATCH', '/api/events/{eventId}', 'Change an event: any of the fields above (e.g. {"status": "done"}).'],
    ['DELETE', '/api/events/{eventId}', 'Delete an event.'],
    ['GET', '/api/workspaces/{workspaceId}/tasks?date=YYYY-MM-DD', 'The day’s tasks (as on Today).'],
    ['GET', '/api/pages/{databaseId}/rows/{rowId}', 'One card of a database (its cells).'],
    ['PATCH', '/api/pages/{databaseId}/rows/{rowId}/cells', 'Change a card’s cells: {"cells": {"<propertyId>": value}} (property ids from GET /api/pages/{databaseId}/fields).'],
    ['POST', '/api/workspaces/{workspaceId}/files', 'Upload a file (multipart/form-data, field "file").'],
    ['GET', '/api/guide', 'How the whole app works, in Markdown (no token needed); ?topic=meetings gives only the matching sections.'],
    ['GET', '/api/workspaces/{workspaceId}/chats', 'Your private chats, groups and teams, with unread counts.'],
    ['POST', '/api/workspaces/{workspaceId}/chats', 'Start a chat: {"kind": "direct" | "group" | "team", "name": "…", "memberIds": ["…"]}.'],
    ['GET', '/api/chats/{chatId}/messages', 'A chat’s latest messages (?before=ISO time for older ones).'],
    ['POST', '/api/chats/{chatId}/messages', 'Send a message: {"body": "…"} — <@userId>, <page:id>, <date:ISO> are drawn as chips.'],
    ['GET', '/api/workspaces/{workspaceId}/meetings', 'Meetings you host, were invited to, or that are for your teams.'],
    ['POST', '/api/workspaces/{workspaceId}/meetings', 'Schedule or start a meeting: {"title", "startsAt" (ISO, or null for now), "durationMin", "inviteeIds", "tasks": [{"title", "assigneeIds", "dueAt", "priority", "notes"}], "defaults": {"talk","camera","screen","chat"}}.'],
    ['GET', '/api/meetings/{code}', 'A meeting: details, people, permissions and the tasks you can see.'],
    ['POST', '/api/meetings/{code}/tasks', 'Add a meeting task (same fields as above).'],
    ['GET', '/api/workspaces/{workspaceId}/graph', 'The graph: pages (with their group), connections and the groups (colours with meaning).'],
  ];
  const events = WEBHOOK_EVENTS.map((e) => `<code>${e}</code>`).join(', ');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.appName} API</title>
<style>
body{font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#16181d}code,pre{background:#262a33!important}td,th{border-color:#333!important}}
h1{font-size:28px}h2{margin-top:32px}code,pre{background:#f3f4f6;border-radius:5px;padding:1px 5px;font-size:13px}pre{padding:12px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}td:first-child{font-weight:600;white-space:nowrap}
</style></head><body>
<h1>${config.appName} API</h1>
<p>Everything the app does goes through this JSON API. Scripts and other apps use it with a <b>personal API token</b>, and act as the person who made it — seeing and changing only what they can.</p>
<h2>Signing in</h2>
<p>Make a token in the app: <b>Settings → API & webhooks → New token</b>. Send it with every request:</p>
<pre>curl -H "Authorization: Bearer atr_…" ${'$'}SERVER/api/workspaces</pre>
<p>Send JSON bodies with <code>Content-Type: application/json</code>. Errors come back as <code>{"error": "message"}</code> with a 4xx/5xx status. Tokens can't make or delete other tokens.</p>
<h2>Endpoints</h2>
<table><tr><th>Method</th><th>Path</th><th>What it does</th></tr>
${rows.map(([m, p, d]) => `<tr><td>${m}</td><td><code>${p}</code></td><td>${d.replace(/</g, '&lt;')}</td></tr>`).join('\n')}
</table>
<h2>MCP (for AI assistants)</h2>
<p><code>POST /api/mcp</code> is an MCP server (Streamable HTTP) that lets an assistant like Claude use a workspace as its memory: tools <code>search_notes</code>, <code>read_note</code>, <code>list_notes</code>, <code>recent_notes</code>, <code>create_note</code>, <code>update_note</code>, <code>related_notes</code> and <code>delete_note</code>, <code>set_note_group</code>, <code>graph_groups</code> and <code>app_guide</code>, with <code>[[Title]]</code> links. Use a token limited to one workspace (or add <code>?workspace=&lt;id&gt;</code>):</p>
<pre>claude mcp add --transport http workspace-brain ${'$'}SERVER/api/mcp --header "Authorization: Bearer atr_…"</pre>
<h2>Webhooks</h2>
<p>Workspace owners add webhooks in <b>Settings → API & webhooks</b>. When something happens, the server sends a <code>POST</code> with JSON:</p>
<pre>{"event": "page.created", "workspaceId": "…", "at": "2026-11-01T12:00:00.000Z", "data": { … }}</pre>
<p>Events: ${events} (and <code>ping</code> from the Test button). Each request has an <code>X-Signature: sha256=…</code> header: the HMAC-SHA256 of the raw body with the webhook's secret, to check it came from this server:</p>
<pre>const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');</pre>
</body></html>`;
}
