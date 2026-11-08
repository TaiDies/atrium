import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessMap, requireMember, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { one, query } from '../db.js';
import { checkMembers } from '../limits.js';
import { inviteEmail, mailEnabled, sendMail } from '../mail.js';
import { notify } from '../notify.js';
import { HttpError, idParams, parse } from '../util.js';
import { requirePermission } from '../roles.js';

// People around pages: guests invited to single pages, following pages (their edits show under the
// bell's Updates), who's online right now, and the daily email summary setting.

// ---------- who's online ----------

/** Open live connections: socket → (person, document). Kept in memory by the collaboration server. */
const online = new Map<string, { userId: string; name: string; color: string; pageId: string; since: number }>();
const PAGE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function trackConnection(socketId: string, documentName: string, user: { id: string; name: string; color: string } | undefined) {
  const pageId = PAGE_RE.exec(documentName)?.[1];
  if (!user || !pageId) return;
  online.set(`${socketId}:${documentName}`, { userId: user.id, name: user.name, color: user.color, pageId: pageId.toLowerCase(), since: Date.now() });
}

export function untrackConnection(socketId: string, documentName: string) {
  online.delete(`${socketId}:${documentName}`);
}

// ---------- following ----------

/** People following a page: those who chose to, plus its creator and editors unless they stopped. */
async function followersOf(pageId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `select f.user_id from page_follows f where f.page_id = $1 and f.following
     union
     select p.created_by from pages p where p.id = $1 and p.created_by is not null
       and not exists (select 1 from page_follows f where f.page_id = p.id and f.user_id = p.created_by and not f.following)`,
    [pageId],
  );
  return rows.map((r) => r.user_id);
}

/** Someone edited a page: they follow it from now on, and its followers hear about it (at most hourly). */
export async function noticeEdit(pageId: string, editor: string | null) {
  if (!editor) return;
  await query('insert into page_follows (user_id, page_id) values ($1, $2) on conflict do nothing', [editor, pageId]);
  const page = await one<{ workspace_id: string; title: string; deleted_at: Date | null }>('select workspace_id, title, deleted_at from pages where id = $1', [pageId]);
  if (!page || page.deleted_at) return;
  const followers = (await followersOf(pageId)).filter((id) => id !== editor);
  if (!followers.length) return;
  const by = (await one<{ name: string }>('select name from users where id = $1', [editor]))?.name ?? 'Someone';
  for (const userId of followers) {
    const fresh = await query(
      `insert into page_edit_notices (user_id, page_id, told_at) values ($1, $2, now())
       on conflict (user_id, page_id) do update set told_at = now() where page_edit_notices.told_at < now() - interval '1 hour'
       returning user_id`,
      [userId, pageId],
    );
    if (!fresh.length) continue;
    const access = await accessMap(userId, page.workspace_id).catch(() => null);
    if (!access || (access.get(pageId) ?? 'none') === 'none') continue;
    await notify(userId, { kind: 'page-edited', title: `${by} edited “${page.title || 'Untitled'}”`, body: 'A page you follow changed.', link: `/w/${page.workspace_id}/p/${pageId}` });
  }
}

export { followersOf };

export async function socialRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // ----- guests -----

  /** Guests and pending guest invitations for a page. */
  app.get('/pages/:id/guests', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'view');
    const guests = await query<{ email?: string }>(
      `select u.id, u.name, u.email, u.color, pp.level from page_permissions pp
         join users u on u.id = pp.user_id
         join workspace_members m on m.user_id = u.id and m.workspace_id = $2 and m.role = 'guest'
        where pp.page_id = $1 order by u.name`,
      [id, page.workspace_id],
    );
    const pending = await query<{ email: string; pages: { pageId: string; level: string }[] }>(
      `select email, pages from workspace_invites where workspace_id = $1 and role = 'guest' and pages @> $2::jsonb`,
      [page.workspace_id, JSON.stringify([{ pageId: id }])],
    );
    // A guest viewing the page sees the other guests by name only.
    if ((await requireMember(req.user.id, page.workspace_id, undefined, true)) === 'guest') {
      return { guests: guests.map(({ email: _, ...g }) => g), pending: [] };
    }
    return { guests, pending: pending.map((p) => ({ email: p.email, level: p.pages.find((x) => x.pageId === id)?.level ?? 'view' })) };
  });

  /** Shares a page with someone by email: a guest of the workspace who sees only this page (and those inside it). */
  app.post('/pages/:id/guests', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email().max(200), level: z.enum(['edit', 'view']).default('view') }), req.body);
    const page = await requirePage(req.user.id, id, 'manage');
    const user = await one<{ id: string }>('select id from users where email = $1', [body.email]);
    const member = user && (await one<{ role: string }>('select role from workspace_members where workspace_id = $1 and user_id = $2', [page.workspace_id, user.id]));
    if (member) {
      // Already in the workspace (as anyone): just give them this page.
      await query(
        `insert into page_permissions (page_id, user_id, level) values ($1, $2, $3) on conflict (page_id, user_id) do update set level = excluded.level`,
        [id, user!.id, body.level],
      );
      await notify(user!.id, { kind: 'page-shared', title: `${req.user.name} shared “${page.title || 'Untitled'}” with you`, body: `You can ${body.level} it.`, link: `/w/${page.workspace_id}/p/${id}` });
      return reply.code(201).send({ status: 'shared' });
    }
    // Bringing someone new into the workspace (as a guest) is inviting, so it needs that permission.
    await requirePermission(req.user.id, 'invite_people');
    const pending = await one<{ pages: { pageId: string; level: string }[] }>('select pages from workspace_invites where workspace_id = $1 and email = $2', [page.workspace_id, body.email]);
    if (!pending) await checkMembers(page.workspace_id);
    const pages = [...(pending?.pages ?? []).filter((p) => p.pageId !== id), { pageId: id, level: body.level }];
    await query(
      `insert into workspace_invites (workspace_id, email, role, invited_by, pages) values ($1, $2, 'guest', $3, $4)
       on conflict (workspace_id, email) do update set pages = excluded.pages`,
      [page.workspace_id, body.email, req.user.id, JSON.stringify(pages)],
    );
    if (!pending && (await mailEnabled())) {
      const m = inviteEmail(req.user.name, page.title || 'a page');
      sendMail(body.email, m.subject, m.text, m.html).catch((err) => req.log.warn({ err }, 'Could not send the invitation email'));
    }
    return reply.code(201).send({ status: 'invited', hasAccount: !!user });
  });

  /** Stops sharing a page with a guest (or withdraws a pending invitation for it). */
  app.delete('/pages/:id/guests', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ userId: z.uuid().optional(), email: z.string().email().optional() }), req.query);
    const page = await requirePage(req.user.id, id, 'manage');
    if (body.userId) await query('delete from page_permissions where page_id = $1 and user_id = $2', [id, body.userId]);
    if (body.email) {
      const inv = await one<{ pages: { pageId: string }[] }>('select pages from workspace_invites where workspace_id = $1 and email = $2 and role = $3', [page.workspace_id, body.email.toLowerCase(), 'guest']);
      if (inv) {
        const rest = inv.pages.filter((p) => p.pageId !== id);
        if (rest.length) await query('update workspace_invites set pages = $3 where workspace_id = $1 and email = $2', [page.workspace_id, body.email.toLowerCase(), JSON.stringify(rest)]);
        else await query('delete from workspace_invites where workspace_id = $1 and email = $2', [page.workspace_id, body.email.toLowerCase()]);
      }
    }
    return { ok: true };
  });

  // ----- following -----

  app.get('/pages/:id/follow', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id, 'view');
    return { following: (await followersOf(id)).includes(req.user.id) };
  });

  app.put('/pages/:id/follow', async (req) => {
    const { id } = parse(idParams, req.params);
    const { following } = parse(z.object({ following: z.boolean() }), req.body);
    await requirePage(req.user.id, id, 'view');
    await query(
      `insert into page_follows (user_id, page_id, following) values ($1, $2, $3) on conflict (user_id, page_id) do update set following = excluded.following`,
      [req.user.id, id, following],
    );
    return { following };
  });

  // ----- who's online -----

  /** People with a page of this workspace open right now (and which page), for Home. */
  app.get('/workspaces/:id/online', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const access = await accessMap(req.user.id, id);
    const pageIds = [...new Set([...online.values()].map((o) => o.pageId))];
    const pages = pageIds.length
      ? await query<{ id: string; title: string; icon: string; type: string }>('select id, title, icon, type from pages where workspace_id = $1 and id = any($2::uuid[]) and deleted_at is null', [id, pageIds])
      : [];
    const byPage = new Map(pages.map((p) => [p.id, p]));
    const people = new Map<string, { id: string; name: string; color: string; page: { id: string; title: string; icon: string; type: string } | null; since: number }>();
    for (const o of online.values()) {
      const page = byPage.get(o.pageId);
      if (!page) continue;
      const visible = (access.get(page.id) ?? 'none') !== 'none';
      const prev = people.get(o.userId);
      if (!prev || o.since > prev.since) people.set(o.userId, { id: o.userId, name: o.name, color: o.color, page: visible ? page : null, since: o.since });
    }
    return { people: [...people.values()].filter((p) => p.id !== req.user.id) };
  });

  // ----- daily email -----

  app.get('/auth/me/digest', async (req) => {
    const row = await one<{ digest: boolean; digest_hour: number }>('select digest, digest_hour from users where id = $1', [req.user.id]);
    return { digest: !!row?.digest, hour: row?.digest_hour ?? 7, mailEnabled: await mailEnabled() };
  });

  app.put('/auth/me/digest', async (req) => {
    const body = parse(z.object({ digest: z.boolean(), hour: z.number().int().min(0).max(23).default(7) }), req.body);
    if (body.digest && !(await mailEnabled())) throw new HttpError(400, 'Email isn’t set up on this server yet — ask the admin to add it in the admin panel');
    await query('update users set digest = $2, digest_hour = $3 where id = $1', [req.user.id, body.digest, body.hour]);
    return { ok: true };
  });
}
