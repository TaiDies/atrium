-- Indexes for the lookups that grow with a workspace: a workspace's files, an account's uploads (storage
-- limits), and searching page, card and file text with "contains" (ilike '%…%'), which trigram indexes speed up.
create index if not exists files_workspace on files (workspace_id);
create index if not exists files_uploaded_by on files (uploaded_by);

-- pg_trgm comes with PostgreSQL but making it needs rights the app's database user may not have on every
-- setup; without it, search still works, just without these indexes.
do $$
begin
  create extension if not exists pg_trgm;
exception when others then
  raise notice 'pg_trgm is not available; search text is not indexed';
end
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    create index if not exists pages_title_trgm on pages using gin (title gin_trgm_ops);
    create index if not exists page_content_text_trgm on page_content using gin (text_content gin_trgm_ops);
    create index if not exists row_documents_text_trgm on row_documents using gin (text_content gin_trgm_ops);
    create index if not exists files_filename_trgm on files using gin (filename gin_trgm_ops);
    create index if not exists files_text_trgm on files using gin (text_content gin_trgm_ops);
  end if;
end
$$;
