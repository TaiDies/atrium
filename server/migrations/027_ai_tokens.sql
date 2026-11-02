-- AI limits count tokens (what the models actually charge), per day and per month, instead of requests.
alter table ai_usage add column tokens bigint not null default 0;
update users set limits = limits - 'aiPerDay' where limits ? 'aiPerDay';
update settings set value = value - 'aiPerDay' where key = 'defaultLimits' and jsonb_typeof(value) = 'object';
