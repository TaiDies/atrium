-- Chat and meetings.
-- Chats: private (two people), groups (everyone equal; the owner can remove people), teams (the
-- owner and admins set who may talk, use commands and start meetings) and a meeting's own chat
-- (kept after the meeting, read-only once it has ended).
create table chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('direct', 'group', 'team', 'meeting')),
  name text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index chats_workspace on chats (workspace_id, last_message_at desc);

create table chat_members (
  chat_id uuid not null references chats(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  can_talk boolean not null default true,
  can_command boolean not null default true,
  can_meet boolean not null default true,
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index chat_members_user on chat_members (user_id);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null default 'text' check (kind in ('text', 'system')),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index chat_messages_chat on chat_messages (chat_id, created_at desc);

-- Meetings: a link (code) made when scheduled, invitations, per-person permissions set by the host
-- (or a workspace owner), tasks prepared beforehand, and their own chat.
create table meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  code text not null unique,
  title text not null default '',
  description text not null default '',
  host_id uuid references users(id) on delete set null,
  chat_id uuid not null references chats(id) on delete cascade,
  team_chat_id uuid references chats(id) on delete set null,
  starts_at timestamptz,
  duration_min integer not null default 30,
  started_at timestamptz,
  ended_at timestamptz,
  -- Defaults for people without their own setting: who may talk, use the camera, share the screen, chat.
  defaults jsonb not null default '{"talk": true, "camera": true, "screen": false, "chat": true}',
  -- Anyone in the workspace with the link may join (otherwise only those invited).
  open_to_workspace boolean not null default true,
  created_at timestamptz not null default now()
);
create index meetings_workspace on meetings (workspace_id, starts_at);

create table meeting_members (
  meeting_id uuid not null references meetings(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'accepted', 'declined', 'joined')),
  cohost boolean not null default false,
  can_talk boolean,
  can_camera boolean,
  can_screen boolean,
  can_chat boolean,
  primary key (meeting_id, user_id)
);
create index meeting_members_user on meeting_members (user_id);

create table meeting_tasks (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  title text not null,
  done boolean not null default false,
  assignee_id uuid references users(id) on delete set null,
  position double precision not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index meeting_tasks_meeting on meeting_tasks (meeting_id, position);
