-- Who each card is assigned to (its person properties), for "My tasks" and assignment notifications.
create table row_people (
  page_id uuid not null references pages(id) on delete cascade,
  row_id text not null,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default '',
  status text,
  status_color text,
  done boolean,
  due date,
  primary key (page_id, row_id, user_id)
);
create index row_people_user on row_people (user_id);
