-- Every sign-in carries the account's session version; raising it ends all of that person's sessions
-- (changing the password, "sign out everywhere", or an email proving someone else made the account).
alter table users add column session_version integer not null default 0;
