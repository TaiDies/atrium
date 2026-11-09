-- API tokens stop working when their owner signs out everywhere or changes their password: each token
-- remembers the session version it was made under (see endSessions).
alter table api_tokens add column if not exists session_version integer;
update api_tokens t set session_version = u.session_version from users u where u.id = t.user_id and t.session_version is null;
