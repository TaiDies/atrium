import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { closeRoom, inRoom, pushPerms, pushTo, pushToRoom } from '../live.js';
import { mailEnabled, sendMail } from '../mail.js';
import { meetingAccess } from '../meetingAccess.js';
import { notify } from '../notify.js';
import { HttpError, idParams, parse } from '../util.js';
import { addTask, meetingPeople, meetingTaskRoutes, newTaskSchema, tasksFor } from '../meetingTasks.js';
import { postMessage } from './chat.js';

// Meetings: scheduled (or started now) with a link made straight away, invitations under the bell and
// by email (when the admin has set up mail), tasks prepared beforehand, per-person permissions set by
// the host, co-hosts or a workspace owner, and a chat of their own that's kept — read-only — after.

/** Where calls find each other: STUN/TURN servers from RTC_ICE_SERVERS (JSON), else a public STUN. */
const iceServers = (() => {
  try {
    if (process.env.RTC_ICE_SERVERS) return JSON.parse(process.env.RTC_ICE_SERVERS) as unknown[];
  } catch {
    // fall through to the default
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
})();

/** A short link code like "kq3-7hx-p2m". */
const newCode = () => {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = randomBytes(9);
  return [0, 3, 6].map((i) => [...b.subarray(i, i + 3)].map((x) => a[x % a.length]).join('')).join('-');
};

const origin = (req: FastifyRequest) => (req.headers.origin as string | undefined) ?? `${req.protocol}://${req.headers.host}`;

const perms = z.object({ talk: z.boolean(), camera: z.boolean(), screen: z.boolean(), chat: z.boolean() });

const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  /** ISO time; leave out to start now. */
  startsAt: z.string().datetime({ offset: true }).nullable().default(null),
  durationMin: z.number().int().min(5).max(24 * 60).default(30),
  inviteeIds: z.array(z.uuid()).max(300).default([]),
  /** Invite a whole team (its chat) — needs "may start meetings" there. */
  teamChatId: z.uuid().nullable().default(null),
  tasks: z.array(newTaskSchema).max(100).default([]),
  defaults: perms.partial().default({}),
  openToWorkspace: z.boolean().default(true),
});

async function invite(req: FastifyRequest, meeting: { id: string; code: string; title: string; workspace_id: string; starts_at: string | null; chat_id: string }, userIds: string[]) {
  const fresh: string[] = [];
  for (const u of userIds) {
    const r = await one('insert into meeting_members (meeting_id, user_id) values ($1, $2) on conflict do nothing returning user_id', [meeting.id, u]);
    await query('insert into chat_members (chat_id, user_id) values ($1, $2) on conflict do nothing', [meeting.chat_id, u]);
    if (r) fresh.push(u);
  }
  if (!fresh.length) return 0;
  const link = `/w/${meeting.workspace_id}/meet/${meeting.code}`;
  const when = meeting.starts_at ? new Date(meeting.starts_at).toUTCString().replace(':00 GMT', ' UTC') : 'now';
  const mail = await mailEnabled();
  const people = await query<{ id: string; email: string }>('select id, email from users where id = any($1)', [fresh]);
  for (const p of people) {
    await notify(p.id, { kind: 'meeting', title: `${req.user.name} invited you to “${meeting.title}”`, body: meeting.starts_at ? `Starts ${when}` : 'Happening now', link });
    if (mail) {
      const url = `${origin(req)}${link}`;
      await sendMail(
        p.email,
        `Invitation: ${meeting.title}`,
        `${req.user.name} invited you to a meeting in ${config.appName}: ${meeting.title}\nWhen: ${when}\nJoin: ${url}`,
        `<p>${req.user.name} invited you to a meeting in ${config.appName}:</p><p><b>${meeting.title.replace(/</g, '&lt;')}</b><br>When: ${when}</p><p><a href="${url}">Join the meeting</a></p>`,
      ).catch(() => {});
    }
  }
  pushTo(fresh, { t: 'meetings' });
  return fresh.length;
}

/** A meeting as the app shows it. */
async function meetingView(userId: string, code: string) {
  const a = await meetingAccess(userId, code);
  const m = a.meeting;
  const members = await query<{ userId: string; name: string; color: string; status: string; cohost: boolean }>(
    `select mm.user_id as "userId", u.name, u.color, mm.status, mm.cohost from meeting_members mm join users u on u.id = mm.user_id where mm.meeting_id = $1 order by u.name`,
    [m.id],
  );
  const host = m.host_id ? await one<{ name: string }>('select name from users where id = $1', [m.host_id]) : null;
  const tasks = await tasksFor(m.id, userId, a.canManage, await meetingPeople(m.id, m.host_id));
  return {
    meeting: {
      id: m.id,
      code: m.code,
      workspaceId: m.workspace_id,
      title: m.title,
      description: m.description,
      hostId: m.host_id,
      hostName: host?.name ?? null,
      chatId: m.chat_id,
      teamChatId: m.team_chat_id,
      startsAt: m.starts_at,
      durationMin: m.duration_min,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      defaults: m.defaults,
      openToWorkspace: m.open_to_workspace,
    },
    members,
    tasks,
    perms: a.perms,
    canManage: a.canManage,
    inRoom: inRoom(m.id),
    iceServers,
  };
}

export async function meetingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // Meetings I host, was invited to, or that were started for one of my teams.
  app.get('/workspaces/:id/meetings', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id, undefined, true);
    const meetings = await query(
      `select m.code, m.title, m.starts_at as "startsAt", m.duration_min as "durationMin", m.started_at as "startedAt", m.ended_at as "endedAt",
              u.name as "hostName", m.host_id = $2 as "isHost",
              (select status from meeting_members where meeting_id = m.id and user_id = $2) as status,
              (select count(*)::int from meeting_members where meeting_id = m.id) as people
         from meetings m left join users u on u.id = m.host_id
        where m.workspace_id = $1
          and (m.host_id = $2
               or exists (select 1 from meeting_members where meeting_id = m.id and user_id = $2)
               or exists (select 1 from chat_members where chat_id = m.team_chat_id and user_id = $2))
        order by coalesce(m.ended_at, m.starts_at, m.created_at) desc
        limit 200`,
      [id, req.user.id],
    );
    return { meetings };
  });

  app.post('/workspaces/:id/meetings', async (req) => {
    const { id } = parse(idParams, req.params);
    const role = await requireMember(req.user.id, id, undefined, true);
    if (role === 'guest') throw new HttpError(403, "Guests can't start meetings");
    const body = parse(createBody, req.body);
    let team: string[] = [];
    if (body.teamChatId) {
      const tm = await one<{ kind: string; can_meet: boolean; role: string }>(
        'select c.kind, m.can_meet, m.role from chats c join chat_members m on m.chat_id = c.id and m.user_id = $2 where c.id = $1 and c.workspace_id = $3',
        [body.teamChatId, req.user.id, id],
      );
      if (!tm) throw new HttpError(404, 'Chat not found');
      if (tm.kind === 'team' && tm.role === 'member' && !tm.can_meet) throw new HttpError(403, "You can't start meetings in this team");
      team = (await query<{ user_id: string }>('select user_id from chat_members where chat_id = $1', [body.teamChatId])).map((r) => r.user_id);
    }
    const valid = (await query<{ user_id: string }>('select user_id from workspace_members where workspace_id = $1 and user_id = any($2)', [id, [...body.inviteeIds, ...team]])).map((r) => r.user_id);
    const defaults = { talk: true, camera: true, screen: false, chat: true, ...body.defaults };
    const meeting = await tx(async (c) => {
      const chat = await one<{ id: string }>(`insert into chats (workspace_id, kind, name, created_by) values ($1, 'meeting', $2, $3) returning id`, [id, body.title, req.user.id], c);
      await query(`insert into chat_members (chat_id, user_id, role) values ($1, $2, 'owner')`, [chat!.id, req.user.id], c);
      const m = await one<{ id: string; code: string; title: string; workspace_id: string; starts_at: string | null; chat_id: string }>(
        `insert into meetings (workspace_id, code, title, description, host_id, chat_id, team_chat_id, starts_at, duration_min, defaults, open_to_workspace)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9, $10, $11)
         returning id, code, title, workspace_id, starts_at, chat_id`,
        [id, newCode(), body.title, body.description, req.user.id, chat!.id, body.teamChatId, body.startsAt, body.durationMin, JSON.stringify(defaults), body.openToWorkspace],
        c,
      );
      await query(`insert into meeting_members (meeting_id, user_id, status) values ($1, $2, 'accepted')`, [m!.id, req.user.id], c);
      return m!;
    });
    await invite(req, meeting, valid.filter((u) => u !== req.user.id));
    // Tasks prepared with the meeting (for people in it, or everyone).
    const people = new Set([req.user.id, ...valid]);
    for (const [i, t] of body.tasks.entries()) await addTask(meeting, req.user, { ...t, assigneeIds: t.assigneeIds.filter((u) => people.has(u)) }, i);
    // Started from a team: the team's chat gets the link.
    if (body.teamChatId) await postMessage(body.teamChatId, req.user.id, `${body.startsAt ? 'Scheduled' : 'Started'} a meeting: <meeting:${meeting.code}>`);
    return { code: meeting.code };
  });

  app.get('/meetings/:code', async (req) => {
    const { code } = parse(z.object({ code: z.string().min(4).max(40) }), req.params);
    return meetingView(req.user.id, code);
  });

  app.patch('/meetings/:code', async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.params);
    const a = await meetingAccess(req.user.id, code);
    if (!a.canManage) throw new HttpError(403, 'Only the host can change the meeting');
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4000).optional(),
        startsAt: z.string().datetime({ offset: true }).optional(),
        durationMin: z.number().int().min(5).max(1440).optional(),
        defaults: perms.optional(),
        openToWorkspace: z.boolean().optional(),
      }),
      req.body,
    );
    await query(
      `update meetings set title = coalesce($2, title), description = coalesce($3, description), starts_at = coalesce($4::timestamptz, starts_at),
              duration_min = coalesce($5, duration_min), defaults = coalesce($6::jsonb, defaults), open_to_workspace = coalesce($7, open_to_workspace)
        where id = $1`,
      [a.meeting.id, body.title ?? null, body.description ?? null, body.startsAt ?? null, body.durationMin ?? null, body.defaults ? JSON.stringify(body.defaults) : null, body.openToWorkspace ?? null],
    );
    if (body.title) await query('update chats set name = $2 where id = $1', [a.meeting.chat_id, body.title]);
    if (body.defaults) pushPerms(a.meeting.id, (await meetingAccess(req.user.id, code)).perms);
    pushToRoom(a.meeting.id, { t: 'meeting-updated' });
    return { ok: true };
  });

  app.post('/meetings/:code/invite', async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.params);
    const a = await meetingAccess(req.user.id, code);
    if (!a.canManage) throw new HttpError(403, 'Only the host can invite people');
    if (a.meeting.ended_at) throw new HttpError(410, 'This meeting has ended');
    const { userIds } = parse(z.object({ userIds: z.array(z.uuid()).min(1).max(300) }), req.body);
    const valid = (await query<{ user_id: string }>('select user_id from workspace_members where workspace_id = $1 and user_id = any($2)', [a.meeting.workspace_id, userIds])).map((r) => r.user_id);
    return { invited: await invite(req, a.meeting, valid) };
  });

  // Answering an invitation.
  app.post('/meetings/:code/answer', async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.params);
    const { answer } = parse(z.object({ answer: z.enum(['accepted', 'declined']) }), req.body);
    const a = await meetingAccess(req.user.id, code);
    await query(`update meeting_members set status = $3 where meeting_id = $1 and user_id = $2 and status <> 'joined'`, [a.meeting.id, req.user.id, answer]);
    return { ok: true };
  });

  // The host's controls for one person: co-host, and whether they may talk, use the camera, share the
  // screen and chat (null = the meeting's default).
  app.patch('/meetings/:code/members/:userId', async (req) => {
    const { code, userId } = parse(z.object({ code: z.string(), userId: z.uuid() }), req.params);
    const a = await meetingAccess(req.user.id, code);
    if (!a.canManage) throw new HttpError(403, 'Only the host can change what people may do');
    if (userId === a.meeting.host_id) throw new HttpError(400, 'The host can always do everything');
    const b = parse(
      z.object({ cohost: z.boolean().optional(), talk: z.boolean().nullable().optional(), camera: z.boolean().nullable().optional(), screen: z.boolean().nullable().optional(), chat: z.boolean().nullable().optional() }),
      req.body,
    );
    if (b.cohost !== undefined && req.user.id !== a.meeting.host_id && !(await one(`select 1 from workspace_members where workspace_id = $1 and user_id = $2 and role = 'owner'`, [a.meeting.workspace_id, req.user.id]))) {
      throw new HttpError(403, 'Only the host can make co-hosts');
    }
    await query(`insert into meeting_members (meeting_id, user_id, status) values ($1, $2, 'invited') on conflict do nothing`, [a.meeting.id, userId]);
    const sets: string[] = [];
    const vals: unknown[] = [a.meeting.id, userId];
    for (const [key, col] of [['cohost', 'cohost'], ['talk', 'can_talk'], ['camera', 'can_camera'], ['screen', 'can_screen'], ['chat', 'can_chat']] as const) {
      if (b[key] !== undefined) {
        vals.push(b[key]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (sets.length) await query(`update meeting_members set ${sets.join(', ')} where meeting_id = $1 and user_id = $2`, vals);
    pushPerms(a.meeting.id, (await meetingAccess(req.user.id, code)).perms);
    return { ok: true };
  });

  app.post('/meetings/:code/end', async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.params);
    const a = await meetingAccess(req.user.id, code);
    if (!a.canManage) throw new HttpError(403, 'Only the host can end the meeting');
    if (a.meeting.ended_at) return { ok: true };
    await postMessage(a.meeting.chat_id, null, `<@${req.user.id}> ended the meeting — this chat is now read-only`, 'system');
    await query('update meetings set ended_at = now(), started_at = coalesce(started_at, now()) where id = $1', [a.meeting.id]);
    closeRoom(a.meeting.id);
    pushTo(a.members.map((m) => m.user_id), { t: 'meetings' });
    return { ok: true };
  });

  await meetingTaskRoutes(app);
}
