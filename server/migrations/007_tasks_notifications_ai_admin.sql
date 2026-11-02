-- Daily tasks, notifications, invitations that wait for an answer, the AI assistant and the admin panel.

-- Whether a dated card counts as done (its status says so, or its repeat rule does).
alter table row_dates add column done boolean;

-- Event reminders: minutes before the start (0 = at the start); null = no reminder.
alter table events add column reminder integer check (reminder between 0 and 40320);

-- Tasks finished, by day, for "what you finished today". The key names the task:
--   event:<eventId>   card:<pageId>:<rowId>   block:<pageId>:<rowId>:<blockId>
create table task_completions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  title text not null default '',
  user_id uuid references users(id) on delete set null,
  completed_on date not null,
  completed_at timestamptz not null default now(),
  primary key (workspace_id, key, completed_on)
);
create index task_completions_day_idx on task_completions (workspace_id, completed_on);

-- Messages for one person (an invitation was accepted, an AI plan is ready, …).
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on notifications (user_id, created_at desc);

-- Notifications worked out on the fly (reminders, tasks due) that the person has already seen.
create table notification_reads (
  user_id uuid not null references users(id) on delete cascade,
  key text not null,
  read_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Invitations now wait until the person accepts them, whether or not they have an account yet.
alter table workspace_invites add column id uuid not null default gen_random_uuid();
create unique index workspace_invites_id_idx on workspace_invites (id);

-- Accounts the admin has switched off, and when people were last active.
alter table users add column disabled_at timestamptz;
alter table users add column last_seen_at timestamptz;

-- Server-wide settings changed from the admin panel (admin password, the shared AI connection…).
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Each person's own AI connection (the key is encrypted).
create table ai_connections (
  user_id uuid primary key references users(id) on delete cascade,
  provider text not null,
  model text not null,
  base_url text,
  key_enc text,
  use_own boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Conversations with the assistant.
create table ai_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null default '',
  messages jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_chats_user_idx on ai_chats (user_id, workspace_id, updated_at desc);
