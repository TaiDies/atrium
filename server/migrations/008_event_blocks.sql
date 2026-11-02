-- Which block an event sits in, so lists like Today can jump straight to it (filled in when documents are indexed).
alter table event_refs add column block_id text;
