-- Appearance and language, kept with the account so every device looks the same.
alter table users add column prefs jsonb not null default '{}'::jsonb;
