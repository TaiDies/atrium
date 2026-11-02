-- Pages published to the web: anyone with the link (/share/<token>) can read them.
alter table pages
  add column publish_token text unique,
  add column publish_subpages boolean not null default false,
  add column publish_index boolean not null default false,
  add column published_at timestamptz;
