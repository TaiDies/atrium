import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, requireOwner } from '../access.js';
import { requireUser } from '../auth.js';
import { one, query } from '../db.js';
import { HttpError, idParams, parse } from '../util.js';

// Teamspaces (groups of top-level pages for some members of a workspace) and each person's own
// order of the sidebar.

const body = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().max(16).nullable().optional(),
  memberIds: z.array(z.uuid()).max(500).optional(),
});

async function setMembers(teamspaceId: string, workspaceId: string, memberIds: string[]) {
  await query('delete from teamspace_members where teamspace_id = $1', [teamspaceId]);
  await query(
    `insert into teamspace_members (teamspace_id, user_id)
     select $1, m.user_id from workspace_members m where m.workspace_id = $2 and m.user_id = any($3::uuid[]) on conflict do nothing`,
    [teamspaceId, workspaceId, memberIds],
  );
}

export async function teamspaceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** Teamspaces this person can see (all of them for owners), with their members. */
  app.get('/workspaces/:id/teamspaces', async (req) => {
    const { id } = parse(idParams, req.params);
    const role = await requireMember(req.user.id, id, undefined, true);
    if (role === 'guest') return { teamspaces: [] };
    const rows = await query<{ id: string; name: string; icon: string | null; memberIds: string[] }>(
      `select t.id, t.name, t.icon, coalesce(array_agg(m.user_id) filter (where m.user_id is not null), '{}') as "memberIds"
         from teamspaces t left join teamspace_members m on m.teamspace_id = t.id
        where t.workspace_id = $1 group by t.id order by t.position, t.created_at`,
      [id],
    );
    return { teamspaces: rows.filter((t) => role === 'owner' || t.memberIds.includes(req.user.id)) };
  });

  app.post('/workspaces/:id/teamspaces', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireOwner(req.user.id, id);
    const b = parse(body.required({ name: true }), req.body);
    const t = await one<{ id: string }>(
      `insert into teamspaces (workspace_id, name, icon, created_by, position)
       values ($1, $2, $3, $4, coalesce((select max(position) + 1 from teamspaces where workspace_id = $1), 0)) returning id`,
      [id, b.name, b.icon ?? null, req.user.id],
    );
    await setMembers(t!.id, id, [...new Set([...(b.memberIds ?? []), req.user.id])]);
    return reply.code(201).send({ teamspace: { id: t!.id } });
  });

  app.patch('/teamspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const t = await one<{ workspace_id: string }>('select workspace_id from teamspaces where id = $1', [id]);
    if (!t) throw new HttpError(404, 'Teamspace not found');
    await requireOwner(req.user.id, t.workspace_id);
    const b = parse(body, req.body);
    if (b.name !== undefined) await query('update teamspaces set name = $2 where id = $1', [id, b.name]);
    if (b.icon !== undefined) await query('update teamspaces set icon = $2 where id = $1', [id, b.icon]);
    if (b.memberIds) await setMembers(id, t.workspace_id, b.memberIds);
    return { ok: true };
  });

  /** Deleting a teamspace keeps its pages: they go back to the whole workspace. */
  app.delete('/teamspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const t = await one<{ workspace_id: string }>('select workspace_id from teamspaces where id = $1', [id]);
    if (!t) throw new HttpError(404, 'Teamspace not found');
    await requireOwner(req.user.id, t.workspace_id);
    await query('delete from teamspaces where id = $1', [id]);
    return { ok: true };
  });

  app.get('/workspaces/:id/sidebar-order', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id, undefined, true);
    const row = await one<{ page_ids: string[] }>('select page_ids from sidebar_orders where user_id = $1 and workspace_id = $2', [req.user.id, id]);
    return { pageIds: row?.page_ids ?? null };
  });

  /** A person's own order (null goes back to the shared one). */
  app.put('/workspaces/:id/sidebar-order', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id, undefined, true);
    const { pageIds } = parse(z.object({ pageIds: z.array(z.uuid()).max(5000).nullable() }), req.body);
    if (pageIds === null) await query('delete from sidebar_orders where user_id = $1 and workspace_id = $2', [req.user.id, id]);
    else
      await query(
        `insert into sidebar_orders (user_id, workspace_id, page_ids) values ($1, $2, $3)
         on conflict (user_id, workspace_id) do update set page_ids = excluded.page_ids`,
        [req.user.id, id, pageIds],
      );
    return { ok: true };
  });
}
