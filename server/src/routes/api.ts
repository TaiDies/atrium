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
import { apiGuide } from '../apiGuide.js';
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
