-- Notes: handwriting on PDFs, blank notes, and where each file is used.

alter table files add column is_note boolean not null default false;
alter table files add column updated_at timestamptz not null default now();

-- Pen/highlighter strokes and extra pages for a file, as a Yjs document ("file:<id>").
create table file_annotations (
  file_id uuid primary key references files(id) on delete cascade,
  state bytea not null,
  stroke_count integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Which page documents and card (row) documents reference each file. Kept up to date whenever a
-- document is saved; row_id is '' for the page's own document.
create table file_refs (
  file_id uuid not null references files(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null default '',
  primary key (file_id, page_id, row_id)
);
create index file_refs_page_idx on file_refs (page_id, row_id);
