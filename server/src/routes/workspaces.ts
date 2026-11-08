import { tokenWorkspace } from '../scope.js';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, requireOwner } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { checkMembers, checkWorkspaces } from '../limits.js';
import { inviteEmail, mailEnabled, sendMail } from '../mail.js';
import { email, HttpError, idParams, parse } from '../util.js';
import { requirePermission } from '../roles.js';

const role = z.enum(['owner', 'member']);
const wsName = z.string().trim().min(1, 'Name is required').max(80);
const icon = z.string().max(16);

export async function workspaceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/workspaces', async (req) => {
    const workspaces = await query(
      `select w.id, w.name, w.icon, m.role,
              (select count(*)::int from workspace_members x where x.workspace_id = w.id) as "memberCount"
         from workspaces w
         join workspace_members m on m.workspace_id = w.id and m.user_id = $1
        where ($2::uuid is null or w.id = $2)
        order by m.joined_at`,
      [req.user.id, tokenWorkspace()],
    );
    return { workspaces };
  });

  app.post('/workspaces', async (req, reply) => {
    if (tokenWorkspace()) throw new HttpError(403, 'This token is limited to one workspace');
    const body = parse(z.object({ name: wsName, icon: icon.optional() }), req.body);
    await requirePermission(req.user.id, 'create_workspaces');
    await checkWorkspaces(req.user.id);
    const workspace = await tx(async (c) => {
      const ws = (await one(
        `insert into workspaces (name, icon, created_by) values ($1, $2, $3) returning id, name, icon`,
        [body.name, body.icon ?? '', req.user.id],
        c,
      ))!;
      await query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws.id, req.user.id], c);
      return { ...ws, role: 'owner', memberCount: 1 };
    });
    return reply.code(201).send({ workspace });
  });

  app.patch('/workspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireOwner(req.user.id, id);
    const body = parse(z.object({ name: wsName.optional(), icon: icon.optional() }), req.body);
    const workspace = await one(
      `update workspaces set name = coalesce($2, name), icon = coalesce($3, icon) where id = $1 returning id, name, icon`,
      [id, body.name ?? null, body.icon ?? null],
    );
    return { workspace };
  });

  app.delete('/workspaces/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireOwner(req.user.id, id);
    const files = await query<{ id: string }>('select id from files where workspace_id = $1', [id]);
    await query('delete from workspaces where id = $1', [id]);
    await Promise.allSettled(files.map((f) => unlink(path.join(config.uploadDir, f.id))));
    return { ok: true };
  });

  app.get('/workspaces/:id/members', async (req) => {
    const { id } = parse(idParams, req.params);
    const role = await requireMember(req.user.id, id, undefined, true);
    const members = await query<{ email?: string }>(
      `select u.id, u.name, u.email, u.color, m.role, m.joined_at as "joinedAt"
         from workspace_members m join users u on u.id = m.user_id
        where m.workspace_id = $1
        order by m.joined_at`,
      [id],
    );
    const invites = await query(
      `select id, email, role, created_at as "createdAt" from workspace_invites where workspace_id = $1 order by created_at`,
      [id],
    );
    // Guests see who's in the workspace by name only: no email addresses, no pending invitations.
    if (role === 'guest') return { members: members.map(({ email: _, ...m }) => m), invites: [] };
    return { members, invites };
  });

  // Invites someone; they join once they accept (from the bell), whether or not they have an account yet.
  app.post('/workspaces/:id/members', async (req, reply) => {
    await requirePermission(req.user.id, 'invite_people');
    const { id } = parse(idParams, req.params);
    await requireOwner(req.user.id, id);
    const body = parse(z.object({ email, role: role.default('member') }), req.body);

    const member = await one(
      'select 1 from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 and u.email = $2',
      [id, body.email],
    );
    if (member) throw new HttpError(409, 'That person is already a member');
    const pending = await one('select 1 from workspace_invites where workspace_id = $1 and email = $2', [id, body.email]);
    if (!pending) await checkMembers(id);
    const fresh = await one<{ inserted: boolean }>(
      `insert into workspace_invites (workspace_id, email, role, invited_by) values ($1, $2, $3, $4)
       on conflict (workspace_id, email) do update set role = excluded.role
       returning (xmax = 0) as inserted`,
      [id, body.email, body.role, req.user.id],
    );
    const hasAccount = !!(await one('select 1 from users where email = $1', [body.email]));
    if (fresh?.inserted && (await mailEnabled())) {
      const ws = await one<{ name: string }>('select name from workspaces where id = $1', [id]);
      const m = inviteEmail(req.user.name, ws?.name ?? 'a workspace');
      sendMail(body.email, m.subject, m.text, m.html).catch((err) => req.log.warn({ err }, 'Could not send the invitation email'));
    }
    return reply.code(201).send({ status: 'invited', hasAccount });
  });

  app.patch('/workspaces/:id/members/:userId', async (req) => {
    const { id, userId } = parse(z.object({ id: z.uuid(), userId: z.uuid() }), req.params);
    await requireOwner(req.user.id, id);
    const body = parse(z.object({ role }), req.body);
    await tx(async (c) => {
      await query('update workspace_members set role = $3 where workspace_id = $1 and user_id = $2', [id, userId, body.role], c);
      await assertHasOwner(id, c);
    });
    return { ok: true };
  });

  app.delete('/workspaces/:id/members/:userId', async (req) => {
    const { id, userId } = parse(z.object({ id: z.uuid(), userId: z.uuid() }), req.params);
    if (userId === req.user.id) await requireMember(req.user.id, id);
    else await requireOwner(req.user.id, id);
    await tx(async (c) => {
      await query('delete from workspace_members where workspace_id = $1 and user_id = $2', [id, userId], c);
      await assertHasOwner(id, c);
    });
    return { ok: true };
  });

  app.delete('/workspaces/:id/invites/:email', async (req) => {
    const params = parse(z.object({ id: z.uuid(), email }), req.params);
    await requireOwner(req.user.id, params.id);
    await query('delete from workspace_invites where workspace_id = $1 and email = $2', [params.id, params.email]);
    return { ok: true };
  });
}

async function assertHasOwner(workspaceId: string, c: Parameters<typeof query>[2]) {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from workspace_members where workspace_id = $1 and role = 'owner'`,
    [workspaceId],
    c,
  );
  if (!row || row.n === 0) throw new HttpError(400, 'A workspace needs at least one owner');
}
