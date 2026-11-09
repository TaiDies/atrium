import { one, query } from './db.js';
import { requireMember } from './access.js';
import { notify } from './notify.js';
import { HttpError } from './util.js';

// Who may join a meeting, who may run it, and what each person may do in it. The host, co-hosts and
// the workspace's owners run it and may do everything; everyone else gets their own setting, or the
// meeting's default where they have none.

export interface MeetingPerms {
  talk: boolean;
  camera: boolean;
  screen: boolean;
  chat: boolean;
}

export interface MeetingRow {
  id: string;
  workspace_id: string;
  code: string;
  title: string;
  description: string;
  host_id: string | null;
  chat_id: string;
  team_chat_id: string | null;
  starts_at: string | null;
  duration_min: number;
  started_at: string | null;
  ended_at: string | null;
  defaults: MeetingPerms;
  open_to_workspace: boolean;
}

interface MemberRow {
  user_id: string;
  status: string;
  cohost: boolean;
  can_talk: boolean | null;
  can_camera: boolean | null;
  can_screen: boolean | null;
  can_chat: boolean | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findMeeting(codeOrId: string): Promise<MeetingRow> {
  const m = await one<MeetingRow>(`select * from meetings where ${UUID.test(codeOrId) ? 'id' : 'code'} = $1`, [codeOrId]);
  if (!m) throw new HttpError(404, 'Meeting not found');
  return m;
}

/** Everyone's permissions, the members, and whether this person runs the meeting. */
export async function meetingAccess(userId: string, codeOrId: string, opts: { joining?: boolean } = {}) {
  // A switched-off account can't join or keep joining (its connections are closed too, see sockets.ts).
  if (!(await one('select 1 from users where id = $1 and disabled_at is null', [userId]))) throw new HttpError(403, 'This account is switched off');
  const meeting = await findMeeting(codeOrId);
  const role = await requireMember(userId, meeting.workspace_id, undefined, true);
  let members = await query<MemberRow>('select * from meeting_members where meeting_id = $1', [meeting.id]);
  const owners = new Set((await query<{ user_id: string }>(`select user_id from workspace_members where workspace_id = $1 and role = 'owner'`, [meeting.workspace_id])).map((r) => r.user_id));
  const runs = (id: string) => id === meeting.host_id || owners.has(id) || !!members.find((m) => m.user_id === id)?.cohost;

  let mine = members.find((m) => m.user_id === userId);
  const teamMember = meeting.team_chat_id ? !!(await one('select 1 from chat_members where chat_id = $1 and user_id = $2', [meeting.team_chat_id, userId])) : false;
  const mayJoin = !!mine || runs(userId) || teamMember || (meeting.open_to_workspace && role !== 'guest');
  if (!mayJoin) throw new HttpError(403, "You weren't invited to this meeting");

  if (opts.joining) {
    if (meeting.ended_at) throw new HttpError(410, 'This meeting has ended');
    // Joining makes them a member (so they can read its chat afterwards), and starts the meeting.
    await query(
      `insert into meeting_members (meeting_id, user_id, status) values ($1, $2, 'joined')
       on conflict (meeting_id, user_id) do update set status = 'joined'`,
      [meeting.id, userId],
    );
    await query(`insert into chat_members (chat_id, user_id) values ($1, $2) on conflict do nothing`, [meeting.chat_id, userId]);
    if (!meeting.started_at) {
      await query('update meetings set started_at = now() where id = $1', [meeting.id]);
      // Everyone invited hears that it has started.
      const who = await one<{ name: string }>('select name from users where id = $1', [userId]);
      for (const m of members.filter((x) => x.user_id !== userId && x.status !== 'declined')) {
        await notify(m.user_id, { kind: 'meeting', title: `“${meeting.title}” has started`, body: `${who?.name ?? 'Someone'} is in the meeting`, link: `/w/${meeting.workspace_id}/meet/${meeting.code}` });
      }
    }
    members = await query<MemberRow>('select * from meeting_members where meeting_id = $1', [meeting.id]);
    mine = members.find((m) => m.user_id === userId);
  }

  const d = meeting.defaults;
  const permsOf = (id: string): MeetingPerms => {
    if (runs(id)) return { talk: true, camera: true, screen: true, chat: true };
    const m = members.find((x) => x.user_id === id);
    return { talk: m?.can_talk ?? d.talk, camera: m?.can_camera ?? d.camera, screen: m?.can_screen ?? d.screen, chat: m?.can_chat ?? d.chat };
  };
  const ids = new Set([...members.map((m) => m.user_id), ...(meeting.host_id ? [meeting.host_id] : []), userId]);
  const perms: Record<string, MeetingPerms> = {};
  for (const id of ids) perms[id] = permsOf(id);
  return { meeting, members, perms, canManage: runs(userId), cohosts: members.filter((m) => m.cohost).map((m) => m.user_id) };
}
