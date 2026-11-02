-- Dates typed into text can have a time and a reminder (minutes before; all-day dates count from 9:00),
-- sent to the person who set it.
alter table block_dates
  add column time text,
  add column remind integer,
  add column remind_by uuid references users(id) on delete set null;
create index block_dates_remind_idx on block_dates (remind_by, date) where remind is not null;
