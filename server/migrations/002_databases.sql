alter table pages drop constraint if exists pages_type_check;
alter table pages add constraint pages_type_check check (type in ('document', 'grid', 'board', 'calendar'));

-- The rich document attached to each database row (a card's page).
create table row_documents (
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null,
  state bytea not null,
  text_content text not null default '',
  updated_at timestamptz not null default now(),
  primary key (page_id, row_id)
);
