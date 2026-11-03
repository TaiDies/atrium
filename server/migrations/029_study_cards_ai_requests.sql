-- Flashcards can belong to a card (a database row) instead of the whole page ('' = the page).
alter table flashcards add column row_id text not null default '';
create index flashcards_page_row_idx on flashcards (page_id, row_id);
