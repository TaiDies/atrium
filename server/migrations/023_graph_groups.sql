-- Graph colours carry meaning: a page belongs to a named group (by its id in the workspace's
-- graph_style.groups), and the group gives it its colour — instead of a bare colour per page.
alter table pages add column graph_group text;
alter table pages drop column if exists graph_color;
