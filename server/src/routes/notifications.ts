import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hiddenEvents } from '../access.js';
import { requireSession, requireUser } from '../auth.js';
import { one, query, tx } from '../db.js';
import { mailEnabled } from '../mail.js';
import { notify } from '../notify.js';
import { addDays } from '../repeat.js';
import { HttpError, idParams, parse } from '../util.js';
import { tasksFor } from './tasks.js';

// The bell: invitations waiting for an answer, event reminders, the day's tasks, and messages left
// for the person (an invitation was accepted, a page was shared with them…). Reminders and tasks are
// worked out when asked for, using the person's own clock, so they need no background job.

export interface Notification {
  key: string;
  kind: 'invitation' | 'reminder' | 'tasks' | 'message';
  /** For messages: what it's about (mention, comment, assigned, page-edited…). */
  type?: string;
  title: string;
  body: string;
  link: string | null;
  at: string;
  read: boolean;
  workspaceId?: string;
  inviteId?: string;
}

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM');

/** Wall-clock arithmetic on "YYYY-MM-DDTHH:MM" (no time zones involved). */
const minutesOf = (t: string) => Date.parse(`${t}:00Z`) / 60_000;

function describeLead(minutes: number) {
  if (minutes <= 0) return 'Starting now';
  if (minutes < 60) return `In ${minutes} min`;
  if (minutes < 1440) return `In ${Math.round(minutes / 60)} h`;
  return `In ${Math.round(minutes / 1440)} day${minutes >= 2880 ? 's' : ''}`;
}

/** Invitations waiting for this person's answer. */
async function invitationsFor(email: string) {
  return query<{ id: string; workspaceId: string; workspaceName: string; workspaceIcon: string; role: string; inviterName: string | null; createdAt: string }>(
    `select i.id, i.workspace_id as "workspaceId", w.name as "workspaceName", w.icon as "workspaceIcon", i.role, u.name as "inviterName", i.created_at as "createdAt"
       from workspace_invites i join workspaces w on w.id = i.workspace_id left join users u on u.id = i.invited_by
      where i.email = $1
      order by i.created_at desc`,
    [email],
  );
}

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** Everything under the bell. `now` is the person's local date and time. */
  app.get('/notifications', { preHandler: requireSession }, async (req) => {
    const { now } = parse(z.object({ now: localTime }), req.query);
    const today = now.slice(0, 10);
    const userId = req.user.id;
    const items: Notification[] = [];

    for (const i of await invitationsFor(req.user.email)) {
      items.push({
        key: `invite:${i.id}`,
        kind: 'invitation',
        title: `${i.inviterName ?? 'Someone'} invited you to ${i.workspaceIcon} ${i.workspaceName}`,
        body: i.role === 'owner' ? 'You would join as an owner.' : 'You would join as a member.',
        link: null,
        at: new Date(i.createdAt).toISOString(),
        read: false,
        inviteId: i.id,
        workspaceId: i.workspaceId,
      });
    }

    const workspaces = await query<{ id: string; name: string }>(
      'select w.id, w.name from workspaces w join workspace_members m on m.workspace_id = w.id and m.user_id = $1 order by w.created_at',
      [userId],
    );

    // Event reminders that are due, until a day after the event starts.
    const events = await query<{ id: string; workspaceId: string; title: string; start: string; time: string | null; reminder: number }>(
      `select e.id, e.workspace_id as "workspaceId", e.title, to_char(e.start_date, 'YYYY-MM-DD') as start, e.start_time as time, e.reminder
         from events e join workspace_members m on m.workspace_id = e.workspace_id and m.user_id = $1
        where e.reminder is not null and e.start_date between $2 and $3 and (e.status is null or e.status <> 'done')`,
      [userId, addDays(today, -1), addDays(today, 29)],
    );
    const nowMin = minutesOf(now);
    const hiddenIds = new Set<string>();
    for (const w of workspaces) for (const h of await hiddenEvents(userId, w.id, events.filter((e) => e.workspaceId === w.id).map((e) => e.id))) hiddenIds.add(h);
    for (const e of events.filter((x) => !hiddenIds.has(x.id))) {
      // All-day events remind relative to 9:00 that morning.
      const startMin = minutesOf(`${e.start}T${e.time ?? '09:00'}`);
      const remindAt = startMin - e.reminder;
      if (nowMin < remindAt || nowMin > startMin + 1440) continue;
      const lead = Math.round(startMin - nowMin);
      items.push({
        key: `reminder:${e.id}:${e.start}`,
        kind: 'reminder',
        title: e.title || 'Untitled event',
        body: lead > 0 ? `${describeLead(lead)} — ${e.time ?? 'all day'}` : e.time ? `Started at ${e.time}` : 'Today',
        link: `/w/${e.workspaceId}/calendar?date=${e.start}`,
        at: new Date(Math.min(remindAt, nowMin) * 60_000).toISOString(),
        read: false,
        workspaceId: e.workspaceId,
      });
    }

    // Reminders set on dates typed into pages, for whoever set them.
    const dated = await query<{ pageId: string; rowId: string; blockId: string; date: string; time: string | null; remind: number; text: string; done: boolean | null; workspaceId: string }>(
      `select d.page_id as "pageId", d.row_id as "rowId", d.block_id as "blockId", to_char(d.date, 'YYYY-MM-DD') as date, d.time, d.remind, d.text, d.done,
              p.workspace_id as "workspaceId"
         from block_dates d join pages p on p.id = d.page_id and p.deleted_at is null
        where d.remind_by = $1 and d.remind is not null and d.date between $2 and $3`,
      [userId, addDays(today, -1), addDays(today, 29)],
    );
    for (const d of dated) {
      if (d.done) continue;
      const startMin = minutesOf(`${d.date}T${d.time ?? '09:00'}`);
      const remindAt = startMin - d.remind;
      if (nowMin < remindAt || nowMin > startMin + 1440) continue;
      const lead = Math.round(startMin - nowMin);
      const where = d.rowId ? `?row=${d.pageId}:${d.rowId}` : '';
      items.push({
        key: `reminder:block:${d.pageId}:${d.rowId}:${d.blockId}:${d.date}`,
        kind: 'reminder',
        title: d.text || 'Reminder',
        body: lead > 0 ? `${describeLead(lead)} — ${d.time ?? 'all day'}` : d.time ? `Due at ${d.time}` : 'Today',
        link: `/w/${d.workspaceId}/p/${d.pageId}${where}#block-${d.blockId}`,
        at: new Date(Math.min(remindAt, nowMin) * 60_000).toISOString(),
        read: false,
        workspaceId: d.workspaceId,
      });
    }

    // One reminder a day per workspace about its tasks.
    for (const w of workspaces) {
      const tasks = await tasksFor(userId, w.id, today);
      const open = tasks.filter((t) => !t.done);
      if (!open.length) continue;
      const overdue = open.filter((t) => t.overdue).length;
      const dueToday = open.length - overdue;
      const parts = [dueToday && `${dueToday} due today`, overdue && `${overdue} overdue`].filter(Boolean);
      items.push({
        key: `tasks:${w.id}:${today}`,
        kind: 'tasks',
        title: `${open.length} task${open.length === 1 ? '' : 's'} to do${workspaces.length > 1 ? ` in ${w.name}` : ''}`,
        body: `${parts.join(', ')}: ${open
          .slice(0, 3)
          .map((t) => t.title)
          .join(', ')}${open.length > 3 ? '…' : ''}`,
        link: `/w/${w.id}/today`,
        at: `${today}T00:00:00.000Z`,
        read: false,
        workspaceId: w.id,
      });
    }

    // From mid-afternoon: a heads-up about what's due tomorrow.
    if (Number(now.slice(11, 13)) >= 15) {
      const tomorrow = addDays(today, 1);
      for (const w of workspaces) {
        const due = (await tasksFor(userId, w.id, tomorrow).catch(() => [])).filter((t) => !t.done && !t.overdue);
        if (!due.length) continue;
        items.push({
          key: `tasks:tomorrow:${w.id}:${tomorrow}`,
          kind: 'tasks',
          title: `${due.length} thing${due.length === 1 ? '' : 's'} due tomorrow${workspaces.length > 1 ? ` in ${w.name}` : ''}`,
          body: `${due
            .slice(0, 3)
            .map((t) => t.title)
            .join(', ')}${due.length > 3 ? '…' : ''}`,
          link: `/w/${w.id}/today?date=${tomorrow}`,
          at: `${today}T15:00:00.000Z`,
          read: false,
          workspaceId: w.id,
        });
      }
    }

    const keys = items.map((i) => i.key);
    if (keys.length) {
      const read = new Set(
        (await query<{ key: string }>('select key from notification_reads where user_id = $1 and key = any($2::text[])', [userId, keys])).map((r) => r.key),
      );
      for (const i of items) if (i.kind !== 'invitation') i.read = read.has(i.key);
    }

    const messages = await query<{ id: string; type: string; title: string; body: string; link: string | null; createdAt: Date; readAt: Date | null }>(
      `select id, kind as type, title, body, link, created_at as "createdAt", read_at as "readAt" from notifications
        where user_id = $1 and (read_at is null or created_at > now() - interval '30 days')
        order by created_at desc limit 50`,
      [userId],
    );
    for (const m of messages) {
      items.push({ key: `n:${m.id}`, kind: 'message', type: m.type, title: m.title, body: m.body, link: m.link, at: m.createdAt.toISOString(), read: !!m.readAt });
    }

    // Invitations first, then newest first.
    items.sort((a, b) => Number(b.kind === 'invitation') - Number(a.kind === 'invitation') || b.at.localeCompare(a.at));
    return { items, unread: items.filter((i) => !i.read).length };
  });

  /** Marks notifications as seen (invitations stay until they're answered). */
  app.post('/notifications/read', { preHandler: requireSession }, async (req) => {
    const { keys } = parse(z.object({ keys: z.array(z.string().max(200)).max(500) }), req.body);
    const ids = keys.filter((k) => k.startsWith('n:')).map((k) => k.slice(2)).filter((id) => z.uuid().safeParse(id).success);
    if (ids.length) await query('update notifications set read_at = now() where user_id = $1 and id = any($2::uuid[]) and read_at is null', [req.user.id, ids]);
    const computed = keys.filter((k) => k.startsWith('reminder:') || k.startsWith('tasks:'));
    for (const key of computed) await query('insert into notification_reads (user_id, key) values ($1, $2) on conflict do nothing', [req.user.id, key]);
    // Old read markers aren't needed once their day has passed.
    await query(`delete from notification_reads where user_id = $1 and read_at < now() - interval '45 days'`, [req.user.id]);
    return { ok: true };
  });

  app.get('/invitations', { preHandler: requireSession }, async (req) => ({ invitations: await invitationsFor(req.user.email) }));

  app.post('/invitations/:id/accept', { preHandler: requireSession }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    // Anyone can make an account with any address, so an invitation only goes to someone who has shown
    // the address is theirs (with an emailed code). Servers without email can't check, and don't ask.
    if (await mailEnabled()) {
      const verified = await one('select 1 from users where id = $1 and email_verified_at is not null', [req.user.id]);
      if (!verified) return reply.code(403).send({ error: 'Confirm your email first: we’ll send you a code.', verify: true, email: req.user.email });
    }
    const invite = await one<{ workspace_id: string; role: string; invited_by: string | null; name: string; pages: { pageId: string; level: string }[] }>(
      `select i.workspace_id, i.role, i.invited_by, w.name, i.pages from workspace_invites i join workspaces w on w.id = i.workspace_id where i.id = $1 and i.email = $2`,
      [id, req.user.email],
    );
    if (!invite) throw new HttpError(404, 'This invitation was withdrawn or already answered');
    // Without email nobody can prove an address is theirs, so becoming an owner needs the
    // administrator to have confirmed it (Admin panel → Accounts).
    if (invite.role === 'owner' && !(await mailEnabled())) {
      const verified = await one('select 1 from users where id = $1 and email_verified_at is not null', [req.user.id]);
      if (!verified) {
        throw new HttpError(403, 'This server can’t send email, so an invitation to join as an owner needs the administrator to confirm your email address first (Admin panel → Accounts → Email confirmed).');
      }
    }
    await tx(async (c) => {
      await query(
        `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3) on conflict do nothing`,
        [invite.workspace_id, req.user.id, invite.role],
        c,
      );
      for (const p of invite.pages ?? []) {
        await query(
          `insert into page_permissions (page_id, user_id, level) select $1, $2, $3 where exists (select 1 from pages where id = $1 and workspace_id = $4)
           on conflict (page_id, user_id) do update set level = excluded.level`,
          [p.pageId, req.user.id, p.level === 'edit' ? 'edit' : 'view', invite.workspace_id],
          c,
        );
      }
      await query('delete from workspace_invites where id = $1', [id], c);
      if (invite.invited_by && invite.invited_by !== req.user.id) {
        await notify(invite.invited_by, { kind: 'invite-accepted', title: `${req.user.name} joined ${invite.name}`, body: 'They accepted your invitation.', link: `/w/${invite.workspace_id}` }, c);
      }
    });
    return { workspaceId: invite.workspace_id };
  });

  app.post('/invitations/:id/decline', { preHandler: requireSession }, async (req) => {
    const { id } = parse(idParams, req.params);
    const invite = await one<{ workspace_id: string; invited_by: string | null; name: string }>(
      `select i.workspace_id, i.invited_by, w.name from workspace_invites i join workspaces w on w.id = i.workspace_id where i.id = $1 and i.email = $2`,
      [id, req.user.email],
    );
    if (!invite) throw new HttpError(404, 'This invitation was withdrawn or already answered');
    await query('delete from workspace_invites where id = $1', [id]);
    if (invite.invited_by && invite.invited_by !== req.user.id) {
      await notify(invite.invited_by, { kind: 'invite-declined', title: `${req.user.name} declined the invitation to ${invite.name}`, link: null });
    }
    return { ok: true };
  });
}
