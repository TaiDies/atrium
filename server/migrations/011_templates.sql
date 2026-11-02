-- Pages saved as templates: a page (and its sub-pages, cards and files) kept as an export, to make
-- new pages from. A template can also repeat: a new page made from it on each date of a pattern.
create table templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  name text not null,
  description text not null default '',
  icon text,
  page_type text not null default 'document',
  data bytea not null,
  -- Repeating: the rule (as for repeating cards), where the new pages go, and the next date due.
  repeat jsonb,
  repeat_parent uuid references pages(id) on delete set null,
  next_run date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index templates_workspace on templates (workspace_id);
create index templates_next_run on templates (next_run) where next_run is not null;
