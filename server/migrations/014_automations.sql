-- The last values automations saw for each card of a database that has automations, so they can
-- tell when a card is added or a property changes. A row with row_id '' marks a database as set up.
create table automation_snapshots (
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null,
  cells jsonb not null default '{}',
  primary key (page_id, row_id)
);
