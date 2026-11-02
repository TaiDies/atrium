-- Per-person limits set in the admin panel. A key that's missing means "use the server's default";
-- null means unlimited; a number is the limit. Keys: workspaces, storageMb, uploadMb, members, aiPerDay.
alter table users add column limits jsonb not null default '{}';

-- AI requests per person per day, for the daily AI limit.
create table ai_usage (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  requests integer not null default 0,
  primary key (user_id, day)
);
