import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { one, query, tx } from '../db.js';
import { pushTo } from '../live.js';
import { notify } from '../notify.js';
import { HttpError, idParams, parse } from '../util.js';
import { requirePermission } from '../roles.js';

// Chat: private chats (two people), groups (everyone equal; the owner can remove people), teams (the
// owner and admins set who may talk, use commands and start meetings), and each meeting's own chat
// (read-only once the meeting has ended). Messages carry commands as tokens the app draws as chips:
// <@user> mentions, <page:id> page links, <date:…> dates and times, <task:id> meeting tasks and
// <meeting:code> meeting links.

type Kind = 'direct' | 'group' | 'team' | 'meeting';
interface ChatRow {
  id: string;
  workspace_id: string;
  kind: Kind;
  name: string;
  created_by: string | null;
}
interface MemberRow {
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  can_talk: boolean;
  can_command: boolean;
  can_meet: boolean;
}

export const COMMAND = /<(@[0-9a-f-]{36}|page:[0-9a-f-]{36}|date:[^<>]{1,40}|task:[0-9a-f-]{36}|meeting:[\w-]{4,40})>/i;
const MENTION = /<@([0-9a-f-]{36})>/gi;

/** A chat and this person's membership in it (they must be in it). */
export async function chatFor(userId: string, chatId: string) {
  const chat = await one<ChatRow>('select id, workspace_id, kind, name, created_by from chats where id = $1', [chatId]);
  if (!chat) throw new HttpError(404, 'Chat not found');
  await requireMember(userId, chat.workspace_id, undefined, true);
  const me = await one<MemberRow>('select user_id, role, can_talk, can_command, can_meet from chat_members where chat_id = $1 and user_id = $2', [chatId, userId]);
  if (!me) throw new HttpError(403, "You're not in this chat");
  return { chat, me };
}

const memberIds = async (chatId: string) => (await query<{ user_id: string }>('select user_id from chat_members where chat_id = $1', [chatId])).map((r) => r.user_id);

/** Whether a meeting chat is closed (its meeting has ended). */
async function meetingClosed(chatId: string) {
  const m = await one<{ ended_at: string | null; id: string }>('select id, ended_at from meetings where chat_id = $1', [chatId]);
  return m;
}

/** Posts a message (people's or the app's own) and tells everyone in the chat. */
export async function postMessage(chatId: string, userId: string | null, body: string, kind: 'text' | 'system' = 'text') {
  const msg = await one<{ id: string; createdAt: string }>(
    `insert into chat_messages (chat_id, user_id, kind, body) values ($1, $2, $3, $4) returning id, created_at as "createdAt"`,
    [chatId, userId, kind, body],
  );
  await query('update chats set last_message_at = now() where id = $1', [chatId]);
  const message = { id: msg!.id, chatId, userId, kind, body, createdAt: msg!.createdAt, editedAt: null, deleted: false };
  pushTo(await memberIds(chatId), { t: 'message', chatId, message });
  return message;
}

const createBody = z.object({
  kind: z.enum(['direct', 'group', 'team']),
  name: z.string().trim().max(80).default(''),
  memberIds: z.array(z.uuid()).max(200).default([]),
});

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // My chats (meeting chats live with their meetings), newest first, with unread counts.
  app.get('/workspaces/:id/chats', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id, undefined, true);
    const chats = await query<{ id: string; kind: Kind; name: string; lastMessageAt: string; unread: number; role: string; other: string | null; last: string | null; lastUser: string | null }>(
      `select c.id, c.kind, c.name, c.last_message_at as "lastMessageAt", me.role,
              (select count(*)::int from chat_messages m where m.chat_id = c.id and m.created_at > me.last_read_at and m.user_id is distinct from $2 and m.deleted_at is null) as unread,
              (select u.name from chat_members o join users u on u.id = o.user_id where o.chat_id = c.id and o.user_id <> $2 limit 1) as other,
              (select m.body from chat_messages m where m.chat_id = c.id and m.deleted_at is null order by m.created_at desc limit 1) as last,
              (select m.user_id::text from chat_messages m where m.chat_id = c.id and m.deleted_at is null order by m.created_at desc limit 1) as "lastUser"
         from chats c join chat_members me on me.chat_id = c.id and me.user_id = $2
        where c.workspace_id = $1 and c.kind <> 'meeting'
        order by c.last_message_at desc`,
      [id, req.user.id],
    );
    return { chats: chats.map((c) => ({ ...c, name: c.kind === 'direct' ? (c.other ?? 'Just you') : c.name })) };
  });

  app.post('/workspaces/:id/chats', async (req) => {
    const { id } = parse(idParams, req.params);
    const role = await requireMember(req.user.id, id, undefined, true);
    const body = parse(createBody, req.body);
    const others = [...new Set(body.memberIds.filter((m) => m !== req.user.id))];
    // Only people in this workspace.
    const valid = new Set((await query<{ user_id: string }>('select user_id from workspace_members where workspace_id = $1 and user_id = any($2)', [id, others])).map((r) => r.user_id));
    const people = others.filter((o) => valid.has(o));
    if (body.kind === 'direct') {
      if (people.length !== 1) throw new HttpError(400, 'A private chat is with one other person');
      const existing = await one<{ id: string }>(
        `select c.id from chats c
          where c.workspace_id = $1 and c.kind = 'direct'
            and exists (select 1 from chat_members where chat_id = c.id and user_id = $2)
            and exists (select 1 from chat_members where chat_id = c.id and user_id = $3)`,
        [id, req.user.id, people[0]],
      );
      if (existing) return { id: existing.id };
    } else {
      if (!body.name) throw new HttpError(400, `Give the ${body.kind} a name`);
      if (role === 'guest') throw new HttpError(403, "Guests can't make groups or teams");
      await requirePermission(req.user.id, 'create_chats');
    }
    const chatId = await tx(async (c) => {
      const chat = await one<{ id: string }>('insert into chats (workspace_id, kind, name, created_by) values ($1, $2, $3, $4) returning id', [id, body.kind, body.kind === 'direct' ? '' : body.name, req.user.id], c);
      await query(`insert into chat_members (chat_id, user_id, role) values ($1, $2, $3)`, [chat!.id, req.user.id, body.kind === 'direct' ? 'member' : 'owner'], c);
      for (const p of people) await query('insert into chat_members (chat_id, user_id) values ($1, $2) on conflict do nothing', [chat!.id, p], c);
      return chat!.id;
    });
    if (body.kind !== 'direct') await postMessage(chatId, null, `<@${req.user.id}> made this ${body.kind}`, 'system');
    pushTo([req.user.id, ...people], { t: 'chats' });
    return { id: chatId };
  });

  app.get('/chats/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { chat, me } = await chatFor(req.user.id, id);
    const members = await query<{ userId: string; name: string; color: string; role: string; canTalk: boolean; canCommand: boolean; canMeet: boolean }>(
      `select m.user_id as "userId", u.name, u.color, m.role, m.can_talk as "canTalk", m.can_command as "canCommand", m.can_meet as "canMeet"
         from chat_members m join users u on u.id = m.user_id where m.chat_id = $1 order by m.role = 'owner' desc, m.role = 'admin' desc, u.name`,
      [id],
    );
    const meeting = chat.kind === 'meeting' ? await one<{ code: string; title: string; ended: boolean }>('select code, title, ended_at is not null as ended from meetings where chat_id = $1', [id]) : null;
    const other = chat.kind === 'direct' ? members.find((m) => m.userId !== req.user.id) : null;
    return {
      chat: { id: chat.id, kind: chat.kind, name: chat.kind === 'direct' ? (other?.name ?? 'Just you') : chat.name, workspaceId: chat.workspace_id },
      me: { role: me.role, canTalk: me.can_talk, canCommand: me.can_command, canMeet: me.can_meet },
      members,
      meeting,
      readOnly: !!meeting?.ended,
    };
  });

  app.patch('/chats/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { chat, me } = await chatFor(req.user.id, id);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    if (chat.kind === 'direct' || chat.kind === 'meeting') throw new HttpError(400, "This chat's name can't be changed");
    if (chat.kind === 'team' ? me.role === 'member' : false) throw new HttpError(403, 'Only the team owner or an admin can rename it');
    await query('update chats set name = $2 where id = $1', [id, name]);
    pushTo(await memberIds(id), { t: 'chats' });
    return { ok: true };
  });

  // Adding people: anyone in a group; the owner or an admin in a team.
  app.post('/chats/:id/members', async (req) => {
    const { id } = parse(idParams, req.params);
    const { chat, me } = await chatFor(req.user.id, id);
    const { userIds } = parse(z.object({ userIds: z.array(z.uuid()).min(1).max(200) }), req.body);
    if (chat.kind === 'direct' || chat.kind === 'meeting') throw new HttpError(400, "People can't be added to this chat");
    if (chat.kind === 'team' && me.role === 'member') throw new HttpError(403, 'Only the team owner or an admin can add people');
    const valid = (await query<{ user_id: string }>('select user_id from workspace_members where workspace_id = $1 and user_id = any($2)', [chat.workspace_id, userIds])).map((r) => r.user_id);
    const before = new Set(await memberIds(id));
    for (const u of valid) await query('insert into chat_members (chat_id, user_id) values ($1, $2) on conflict do nothing', [id, u]);
    const added = valid.filter((u) => !before.has(u));
    if (added.length) await postMessage(id, null, `<@${req.user.id}> added ${added.map((u) => `<@${u}>`).join(', ')}`, 'system');
    pushTo([...before, ...added], { t: 'chats' });
    return { added: added.length };
  });

  // Removing: yourself (leaving); in a group, the owner removes people; in a team, the owner or an admin
  // (admins can't remove the owner or other admins).
  app.delete('/chats/:id/members/:userId', async (req) => {
    const { id, userId } = parse(z.object({ id: z.uuid(), userId: z.uuid() }), req.params);
    const { chat, me } = await chatFor(req.user.id, id);
    const target = await one<MemberRow>('select user_id, role, can_talk, can_command, can_meet from chat_members where chat_id = $1 and user_id = $2', [id, userId]);
    if (!target) throw new HttpError(404, "They're not in this chat");
    const self = userId === req.user.id;
    if (!self) {
      if (chat.kind === 'direct' || chat.kind === 'meeting') throw new HttpError(400, "People can't be removed from this chat");
      const allowed = chat.kind === 'group' ? me.role === 'owner' : me.role === 'owner' || (me.role === 'admin' && target.role === 'member');
      if (!allowed) throw new HttpError(403, chat.kind === 'group' ? 'Only the group owner can remove people' : 'Only the team owner or an admin can remove people');
    }
    const everyone = await memberIds(id);
    await query('delete from chat_members where chat_id = $1 and user_id = $2', [id, userId]);
    // The owner leaving hands the chat to the longest-standing member.
    if (self && target.role === 'owner') {
      await query(
        `update chat_members set role = 'owner' where chat_id = $1 and user_id = (select user_id from chat_members where chat_id = $1 order by role = 'admin' desc, joined_at limit 1)`,
        [id],
      );
    }
    if (chat.kind !== 'direct') await postMessage(id, null, self ? `<@${userId}> left` : `<@${req.user.id}> removed <@${userId}>`, 'system');
    pushTo(everyone, { t: 'chats' });
    return { ok: true };
  });

  // A team's rules for one member: role, and whether they may talk, use commands and start meetings.
  app.patch('/chats/:id/members/:userId', async (req) => {
    const { id, userId } = parse(z.object({ id: z.uuid(), userId: z.uuid() }), req.params);
    const { chat, me } = await chatFor(req.user.id, id);
    const body = parse(
      z.object({ role: z.enum(['admin', 'member']).optional(), canTalk: z.boolean().optional(), canCommand: z.boolean().optional(), canMeet: z.boolean().optional() }),
      req.body,
    );
    if (chat.kind !== 'team') throw new HttpError(400, 'Only teams have per-person rules');
    if (me.role === 'member') throw new HttpError(403, 'Only the team owner or an admin can change this');
    const target = await one<MemberRow>('select user_id, role, can_talk, can_command, can_meet from chat_members where chat_id = $1 and user_id = $2', [id, userId]);
    if (!target) throw new HttpError(404, "They're not in this team");
    if (target.role === 'owner') throw new HttpError(400, 'The owner can always do everything');
    if (body.role && me.role !== 'owner') throw new HttpError(403, 'Only the owner can make admins');
    if (me.role === 'admin' && target.role === 'admin') throw new HttpError(403, "Admins can't change other admins");
    await query(
      `update chat_members set role = coalesce($3, role), can_talk = coalesce($4, can_talk), can_command = coalesce($5, can_command), can_meet = coalesce($6, can_meet)
        where chat_id = $1 and user_id = $2`,
      [id, userId, body.role ?? null, body.canTalk ?? null, body.canCommand ?? null, body.canMeet ?? null],
    );
    pushTo(await memberIds(id), { t: 'chat-updated', chatId: id });
    return { ok: true };
  });

  app.get('/chats/:id/messages', async (req) => {
    const { id } = parse(idParams, req.params);
    await chatFor(req.user.id, id);
    const { before } = parse(z.object({ before: z.string().optional() }), req.query);
    const rows = await query<{ id: string; userId: string | null; kind: string; body: string; createdAt: string; editedAt: string | null; deleted: boolean }>(
      `select id, user_id as "userId", kind, case when deleted_at is null then body else '' end as body, created_at as "createdAt", edited_at as "editedAt", deleted_at is not null as deleted
         from chat_messages where chat_id = $1 and ($2::timestamptz is null or created_at < $2) order by created_at desc limit 60`,
      [id, before ?? null],
    );
    return { messages: rows.reverse().map((m) => ({ ...m, chatId: id })), more: rows.length === 60 };
  });

  app.post('/chats/:id/messages', async (req) => {
    const { id } = parse(idParams, req.params);
    const { chat, me } = await chatFor(req.user.id, id);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(8000) }), req.body);
    if (chat.kind === 'team' && !me.can_talk) throw new HttpError(403, "You can't send messages in this team");
    if (chat.kind === 'team' && !me.can_command && COMMAND.test(body)) throw new HttpError(403, "You can't use commands in this team");
    if (chat.kind === 'meeting') {
      const m = await meetingClosed(id);
      if (m?.ended_at) throw new HttpError(403, 'This meeting has ended — its chat is read-only');
      const perm = await one<{ can_chat: boolean | null; cohost: boolean }>('select can_chat, cohost from meeting_members where meeting_id = $1 and user_id = $2', [m!.id, req.user.id]);
      const meeting = await one<{ host_id: string; defaults: { chat: boolean } }>('select host_id, defaults from meetings where id = $1', [m!.id]);
      const owner = await one('select 1 from workspace_members where workspace_id = $1 and user_id = $2 and role = $3', [chat.workspace_id, req.user.id, 'owner']);
      const runs = meeting?.host_id === req.user.id || perm?.cohost || !!owner;
      if (!runs && !(perm?.can_chat ?? meeting?.defaults.chat ?? true)) throw new HttpError(403, "The host hasn't let you chat in this meeting");
    }
    const message = await postMessage(id, req.user.id, body);
    await query('update chat_members set last_read_at = now() where chat_id = $1 and user_id = $2', [id, req.user.id]);
    // Mentions reach people under the bell.
    const members = new Set(await memberIds(id));
    const mentioned = [...new Set([...body.matchAll(MENTION)].map((m) => m[1]))].filter((u) => u !== req.user.id && members.has(u));
    const where = chat.kind === 'direct' ? 'a private chat' : chat.kind === 'meeting' ? 'a meeting chat' : `“${chat.name}”`;
    const plain = body.replace(/<[^>]+>/g, '…').slice(0, 200);
    for (const u of mentioned) await notify(u, { kind: 'mention', title: `${req.user.name} mentioned you in ${where}`, body: plain, link: `/w/${chat.workspace_id}/chat/${id}` });
    return { message };
  });

  app.patch('/chat-messages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(8000) }), req.body);
    const msg = await one<{ chat_id: string; user_id: string }>('select chat_id, user_id from chat_messages where id = $1 and deleted_at is null', [id]);
    if (!msg || msg.user_id !== req.user.id) throw new HttpError(404, 'Message not found');
    const { chat, me } = await chatFor(req.user.id, msg.chat_id);
    if (chat.kind === 'meeting' && (await meetingClosed(msg.chat_id))?.ended_at) throw new HttpError(403, 'This meeting has ended — its chat is read-only');
    if (chat.kind === 'team' && !me.can_command && COMMAND.test(body)) throw new HttpError(403, "You can't use commands in this team");
    await query('update chat_messages set body = $2, edited_at = now() where id = $1', [id, body]);
    pushTo(await memberIds(msg.chat_id), { t: 'message-changed', chatId: msg.chat_id, id, body, deleted: false });
    return { ok: true };
  });

  app.delete('/chat-messages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const msg = await one<{ chat_id: string; user_id: string }>('select chat_id, user_id from chat_messages where id = $1 and deleted_at is null', [id]);
    if (!msg) throw new HttpError(404, 'Message not found');
    const { chat, me } = await chatFor(req.user.id, msg.chat_id);
    if (chat.kind === 'meeting' && (await meetingClosed(msg.chat_id))?.ended_at) throw new HttpError(403, 'This meeting has ended — its chat is read-only');
    // Your own messages; in a team, the owner and admins may remove anyone's.
    if (msg.user_id !== req.user.id && !(chat.kind === 'team' && me.role !== 'member')) throw new HttpError(403, "You can't delete this message");
    await query('update chat_messages set deleted_at = now() where id = $1', [id]);
    pushTo(await memberIds(msg.chat_id), { t: 'message-changed', chatId: msg.chat_id, id, body: '', deleted: true });
    return { ok: true };
  });

  app.post('/chats/:id/read', async (req) => {
    const { id } = parse(idParams, req.params);
    await chatFor(req.user.id, id);
    await query('update chat_members set last_read_at = now() where chat_id = $1 and user_id = $2', [id, req.user.id]);
    return { ok: true };
  });
}
