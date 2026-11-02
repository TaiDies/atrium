-- Personal API tokens (for scripts and other apps; they act as the person who made them) and
-- webhooks (the server tells another address when things change in a workspace).
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null default '',
  token_hash text not null unique,
  -- The first characters, to tell tokens apart in the list (the token itself is shown only once).
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz
);
create index api_tokens_user_idx on api_tokens (user_id);

create table webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  url text not null,
  secret text not null,
  events text[] not null default '{}',
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_status integer,
  last_error text,
  last_sent_at timestamptz
);
create index webhooks_workspace_idx on webhooks (workspace_id);
