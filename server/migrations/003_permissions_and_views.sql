-- Database pages can now start with any of the database layouts.
alter table pages drop constraint if exists pages_type_check;
alter table pages add constraint pages_type_check check (
  type in ('document', 'grid', 'board', 'calendar', 'list', 'gallery', 'feed', 'timeline', 'chart', 'form')
);

-- Access for workspace members who have no explicit entry. NULL = inherit from the parent page
-- (top-level pages default to "edit").
alter table pages add column default_access text check (default_access in ('edit', 'view', 'none'));

-- Per-member access to a page and, unless overridden further down, its sub-pages.
create table page_permissions (
  page_id uuid not null references pages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  level text not null check (level in ('edit', 'view', 'none')),
  primary key (page_id, user_id)
);
create index page_permissions_user_idx on page_permissions(user_id);
