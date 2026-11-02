-- Roles: sets of permissions (and optional limits) the admin gives to people. Everyone has the built-in
-- "Everyone" role; other roles add to it. It starts with every permission, so nothing changes until the
-- admin takes some away.
create table roles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  permissions text[] not null default '{}',
  limits jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index roles_one_default on roles (is_default) where is_default;

create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  primary key (user_id, role_id)
);
create index user_roles_role on user_roles (role_id);

insert into roles (name, description, permissions, is_default, position) values (
  'Everyone',
  'Applies to every account.',
  array['use_ai', 'create_workspaces', 'invite_people', 'upload_files', 'start_meetings', 'create_chats', 'publish_pages', 'api_tokens'],
  true,
  0
);
