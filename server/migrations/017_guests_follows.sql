-- Guests: people who see only the pages shared with them (and the pages inside those).
alter table workspace_members drop constraint if exists workspace_members_role_check;
alter table workspace_members add constraint workspace_members_role_check check (role in ('owner', 'member', 'guest'));
alter table workspace_invites drop constraint if exists workspace_invites_role_check;
alter table workspace_invites add constraint workspace_invites_role_check check (role in ('owner', 'member', 'guest'));
-- The pages a guest invitation gives access to: [{ "pageId": "...", "level": "edit" | "view" }].
alter table workspace_invites add column pages jsonb not null default '[]';

-- Following a page: its changes and comments show under the bell's Updates. Creating, editing or
-- commenting on a page follows it; "following = false" remembers that someone stopped.
create table page_follows (
  user_id uuid not null references users(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  following boolean not null default true,
  primary key (user_id, page_id)
);
create index page_follows_page on page_follows (page_id) where following;

-- When each follower was last told a page changed (at most once an hour per page).
create table page_edit_notices (
  user_id uuid not null references users(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  told_at timestamptz not null default now(),
  primary key (user_id, page_id)
);

-- The daily email summary.
alter table users
  add column digest boolean not null default false,
  add column digest_hour integer not null default 7,
  add column digest_sent_on date;
