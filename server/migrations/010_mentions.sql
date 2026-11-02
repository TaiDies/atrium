-- Mentions and comments that people have already been told about, so each one notifies once.
-- key is "mention:<userId>:<blockId>" or "comment:<commentId>".
create table doc_notices (
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null default '',
  key text not null,
  created_at timestamptz not null default now(),
  primary key (page_id, row_id, key)
);
