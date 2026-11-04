-- Where each person stopped in each file (the page of a PDF, how far down a document, the slide, the
-- time in a video), so it opens there again on any device and the file says where they stopped.
create table file_positions (
  user_id uuid not null references users(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  position jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, file_id)
);
