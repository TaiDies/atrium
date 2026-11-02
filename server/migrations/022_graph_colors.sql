-- Colours in the graph: a page's own dot colour, and per workspace the colours of each kind of line
-- and colour groups ({ links: { link, child, relation }, groups: [{ match, color }] }).
alter table pages add column graph_color text;
alter table workspaces add column graph_style jsonb not null default '{}'::jsonb;
