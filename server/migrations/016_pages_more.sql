-- Page history: snapshots of each page (and card) taken as it's edited, at most every few minutes.
create table page_versions (
  id bigserial primary key,
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null default '',
  state bytea not null,
  editor uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index page_versions_doc on page_versions (page_id, row_id, created_at desc);

-- Teamspaces: groups of top-level pages that only their members (and workspace owners) see.
create table teamspaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  icon text,
  position double precision not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table teamspace_members (
  teamspace_id uuid not null references teamspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (teamspace_id, user_id)
);

-- Locking (no accidental edits), archiving (out of the sidebar, still searchable), verified pages,
-- per-page layout (full width, small text) and the teamspace a top-level page belongs to.
alter table pages
  add column locked boolean not null default false,
  add column archived_at timestamptz,
  add column verified_until timestamptz,
  add column verified_by uuid references users(id) on delete set null,
  add column layout jsonb not null default '{}',
  add column teamspace_id uuid references teamspaces(id) on delete set null;

-- Links between pages (mentions, links and sub-page blocks), for backlinks.
create table page_links (
  source_page uuid not null references pages(id) on delete cascade,
  source_row text not null default '',
  target_page uuid not null references pages(id) on delete cascade,
  primary key (source_page, source_row, target_page)
);
create index page_links_target on page_links (target_page);

-- A person's own order of the top-level pages in the sidebar.
create table sidebar_orders (
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  page_ids text[] not null default '{}',
  primary key (user_id, workspace_id)
);

-- Text inside uploaded files (PDFs, Word, Excel, PowerPoint…), for search.
alter table files add column text_content text;
