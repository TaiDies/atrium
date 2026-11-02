-- An API token can be limited to one workspace (e.g. a workspace kept as an AI assistant's memory):
-- with it, nothing outside that workspace can be seen or changed.
alter table api_tokens add column workspace_id uuid references workspaces(id) on delete cascade;
