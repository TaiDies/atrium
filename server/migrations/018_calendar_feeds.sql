-- Calendar subscription links (.ics): a secret address per person and workspace that other calendar
-- apps (Google, Outlook, Apple) can follow. Resetting the link makes a new token.
create table calendar_feeds (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, workspace_id)
);
