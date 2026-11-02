-- Meeting tasks are for one person, several, or everyone in the meeting. Only those people (and whoever
-- made the task) see it, and only they can tick it — each their own part; the task is finished when
-- everyone it's for has. Each person can also put it in the calendar (from the meeting's start to the
-- task's due date). Plus notes, a due date and a priority.
alter table meeting_tasks add column notes text not null default '';
alter table meeting_tasks add column due_at timestamptz;
alter table meeting_tasks add column priority text not null default 'normal' check (priority in ('low', 'normal', 'high'));
alter table meeting_tasks add column for_everyone boolean not null default false;

-- For a task that's for named people, a row per person; for an everyone task, rows appear as people
-- tick it or add it to their calendar.
create table meeting_task_people (
  task_id uuid not null references meeting_tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  done_at timestamptz,
  event_id uuid references events(id) on delete set null,
  primary key (task_id, user_id)
);
create index meeting_task_people_user on meeting_task_people (user_id);

insert into meeting_task_people (task_id, user_id, done_at)
  select id, assignee_id, case when done then now() end from meeting_tasks where assignee_id is not null;
-- Tasks nobody was given were for everyone.
update meeting_tasks set for_everyone = true where assignee_id is null;
