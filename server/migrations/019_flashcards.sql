-- Flashcards: question/answer cards kept with a page (its "deck"), shared by everyone who can see the
-- page. Each person reviews them on their own schedule (spaced repetition).
create table flashcards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  front text not null,
  back text not null default '',
  position double precision not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index flashcards_page_idx on flashcards (page_id, position);

create table flashcard_reviews (
  card_id uuid not null references flashcards(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  due date not null,
  interval_days real not null default 0,
  ease real not null default 2.5,
  reps integer not null default 0,
  lapses integer not null default 0,
  reviewed_at timestamptz not null default now(),
  primary key (card_id, user_id)
);
create index flashcard_reviews_due_idx on flashcard_reviews (user_id, due);
