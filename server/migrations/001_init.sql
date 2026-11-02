create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  color text not null,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on workspace_members(user_id);

-- Invites for people who don't have an account yet; claimed on sign-up.
create table workspace_invites (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'member')),
  invited_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, email)
);
create index workspace_invites_email_idx on workspace_invites(email);

create table pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  parent_id uuid references pages(id) on delete cascade,
  type text not null default 'document' check (type in ('document', 'board')),
  title text not null default '',
  icon text not null default '',
  cover text,
  position double precision not null default 0,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index pages_workspace_parent_idx on pages(workspace_id, parent_id);

create table page_content (
  page_id uuid primary key references pages(id) on delete cascade,
  state bytea not null,
  text_content text not null default '',
  updated_at timestamptz not null default now()
);

create table favorites (
  user_id uuid not null references users(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, page_id)
);

create table files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  uploaded_by uuid references users(id) on delete set null,
  filename text not null,
  mime_type text not null,
  size bigint not null,
  created_at timestamptz not null default now()
);
