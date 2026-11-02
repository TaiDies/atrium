-- Calendar: standalone events (which can also be attached to blocks), plus indexes of every dated
-- card and dated block so they all show on the calendar. Whiteboards: shared, endless canvases.

create table events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null default '',
  description text not null default '',
  start_date date not null,
  start_time text,            -- 'HH:MM', or null for an all-day event
  end_date date,
  end_time text,
  color text not null default 'blue',
  status text check (status in ('todo', 'doing', 'done')), -- null: an event, not a task
  repeat jsonb,               -- see web/src/calendar/repeat.ts
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_workspace_idx on events (workspace_id, start_date);

-- Event blocks inside page and card documents (row_id '' = the page's own document).
create table event_refs (
  event_id uuid not null references events(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null default '',
  primary key (event_id, page_id, row_id)
);

-- Dates typed into documents (date mentions), one row per block and date.
create table block_dates (
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null default '',
  block_id text not null,
  date date not null,
  text text not null default '',
  done boolean,               -- set for to-do blocks
  primary key (page_id, row_id, block_id, date)
);
create index block_dates_date_idx on block_dates (date);

-- Every date cell of every database row.
create table row_dates (
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null,
  field_id text not null,
  field_name text not null default '',
  date date not null,
  end_date date,
  title text not null default '',
  status text,
  status_color text,
  primary key (page_id, row_id, field_id)
);
create index row_dates_date_idx on row_dates (date);

-- Repeating cards: the rule (kept on the row in the document) and when it next resets.
create table row_repeats (
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null,
  rule jsonb not null,
  next_reset date,
  primary key (page_id, row_id)
);
create index row_repeats_next_idx on row_repeats (next_reset);

create table whiteboards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null default '',
  state bytea,
  element_count integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index whiteboards_workspace_idx on whiteboards (workspace_id, updated_at desc);

create table board_refs (
  board_id uuid not null references whiteboards(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null default '',
  primary key (board_id, page_id, row_id)
);
