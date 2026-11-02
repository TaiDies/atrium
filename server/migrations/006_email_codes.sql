-- Signing in and up with a code sent by email, and confirming email addresses.

alter table users alter column password_hash drop not null; -- accounts made with an email code have no password
alter table users add column email_verified_at timestamptz;

create table email_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  purpose text not null check (purpose in ('login', 'signup', 'verify')),
  name text,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_codes_email_idx on email_codes (email, created_at desc);
