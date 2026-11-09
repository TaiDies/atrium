import { config } from './config.js';
import { HELD_TIMEOUT_MS } from './aiJobs.js';
import { WEBHOOK_EVENTS } from './webhooks.js';

// The API guide served at /api/docs: how tokens work, every endpoint with who may use it, AI requests
// that run in the background, webhooks and MCP. Kept next to the routes it describes.

type Row = [method: string, path: string, what: string, who?: string];

const S: Record<string, Row[]> = {
  'About the server': [
    ['GET', '/api/health', 'Whether the server is up: {"status": "ok"}. No sign-in.', 'anyone'],
    ['GET', '/api/server/info', '{"app", "name", "version", "api"}. No sign-in.', 'anyone'],
    ['GET', '/api/docs', 'This guide. No sign-in.', 'anyone'],
    ['GET', '/api/openapi.json', 'Every route as OpenAPI 3.1, generated from the server itself, with the descriptions from this guide. No sign-in.', 'anyone'],
    ['GET', '/api/guide?topic=…', 'How the app works, in Markdown (the built-in assistant’s knowledge); topic picks the best-matching sections. No sign-in.', 'anyone'],
    ['GET / POST', '/api/mcp', 'The MCP server for AI assistants (see below): POST with an API token; GET answers 405.'],
  ],
  'Account and workspaces': [
    ['GET', '/api/auth/me', 'Who the token belongs to: {"user": {id, email, name, color}}.'],
    ['GET', '/api/auth/me/permissions', 'What your account’s roles allow ({"permissions": [...]}).'],
    ['GET', '/api/workspaces', 'Your workspaces (a workspace-limited token sees only its own).'],
    ['POST', '/api/workspaces', 'New workspace: {"name", "icon"}. Not with a workspace-limited token.', 'role: create workspaces'],
    ['PATCH', '/api/workspaces/{workspaceId}', 'Rename: {"name", "icon"}.', 'owner'],
    ['GET', '/api/workspaces/{workspaceId}/members', 'Members (guests see names only, without emails) and pending invitations.'],
    ['POST', '/api/workspaces/{workspaceId}/members', 'Invite: {"email", "role": "member" | "owner"}.', 'owner (and role: invite people)'],
    ['DELETE', '/api/workspaces/{workspaceId}/invites/{email}', 'Withdraw an invitation that hasn’t been answered.', 'owner'],
  ],
  Pages: [
    ['GET', '/api/workspaces/{workspaceId}/pages', 'Every page you can see: id, title, type, parentId, icon, access, locked…'],
    ['POST', '/api/workspaces/{workspaceId}/pages', 'New page: {"title", "type": "document" | "grid" | "board" | "calendar" | "timeline" | "chart" | "form" | "list" | "gallery" | "feed", "parentId"} → 201 {"page"}.', 'owner'],
    ['GET', '/api/pages/{pageId}', 'One page’s details and your access ("view" | "edit" | "manage").'],
    ['PATCH', '/api/pages/{pageId}', 'Change {"title", "icon", "cover", "locked", "archived", "layout"}; moving it ({"parentId"}, {"teamspaceId"}) changes who sees it and needs manage.', 'edit'],
    ['GET', '/api/pages/{pageId}/markdown', 'JSON {"id", "title", "type", "format": "markdown" | "csv", "content"} — a document as Markdown, a database as CSV.', 'view'],
    ['POST', '/api/pages/{pageId}/markdown', 'Add to a document: {"markdown", "mode": "append" | "replace"} → {"ok", "blocks"}. [[Title]] links are only turned into links through MCP.', 'edit, not locked'],
    ['POST', '/api/pages/{pageId}/trash', 'Move to the trash (with the pages inside it). {"deleteEvents": true, "deleteFiles": true} also deletes the events and files used only there.', 'edit'],
    ['GET', '/api/workspaces/{workspaceId}/trash', 'What’s in the trash.'],
    ['POST', '/api/pages/{pageId}/restore', 'Bring back from the trash.', 'edit'],
    ['DELETE', '/api/workspaces/{workspaceId}/trash', 'Empty the trash: deletes for good the pages in it that you can edit.'],
    ['DELETE', '/api/pages/{pageId}', 'Delete for good (only once it’s in the trash).', 'edit'],
    ['POST', '/api/pages/{pageId}/duplicate', 'Copy a page (and what’s inside it).', 'edit, and a workspace owner'],
    ['GET', '/api/pages/{pageId}/versions', 'Page history (snapshots).', 'view'],
    ['GET', '/api/pages/{pageId}/versions/{versionId}', 'One snapshot, as a binary Yjs update (application/octet-stream).', 'view'],
    ['POST', '/api/pages/{pageId}/versions/{versionId}/restore', 'Go back to a snapshot.', 'edit'],
    ['GET', '/api/pages/{pageId}/permissions', 'Who can see and edit it.', 'manage'],
    ['PUT', '/api/pages/{pageId}/permissions', '{"defaultAccess": "edit" | "view" | "none", "members": [{"userId", "level"}]}.', 'manage'],
    ['GET / POST / DELETE', '/api/pages/{pageId}/guests', 'People outside the workspace with access to this page; add {"email", "level": "view" | "edit"}; remove with ?userId= or ?email=.', 'view to list, manage to add or remove'],
    ['GET / PUT', '/api/pages/{pageId}/publish', 'Publish to the web: {"published", "subpages", "allowIndex"} → a public link.', 'view to read; manage to change (and role: publish pages to publish)'],
    ['GET', '/api/workspaces/{workspaceId}/search?q=…', 'Search pages, cards and files; also kind=all|pages|databases|files, edited=any|1|7|30|365 (days), mine=1.'],
    ['GET', '/api/pages/{pageId}/backlinks', 'Pages linking to this one.', 'view'],
    ['GET', '/api/workspaces/{workspaceId}/recent', 'Recently changed pages you can see, with who changed them.'],
    ['PUT / DELETE', '/api/pages/{pageId}/favorite', 'Add to or remove from your favourites.', 'view'],
    ['GET / PUT', '/api/pages/{pageId}/follow', 'Whether you get notified about changes: {"following": true | false}.', 'view'],
    ['GET', '/api/workspaces/{workspaceId}/graph', 'The graph: pages (with their group), connections and the groups.'],
  ],
  'Databases (cards and properties)': [
    ['GET', '/api/pages/{databaseId}/rows?format=named&limit=200&cursor=0', 'Properties and cards. format=named gives values by property name (option names instead of ids); nextCursor pages through. view={viewIdOrName} applies that view’s filters and sorting; filters=[{"property", "op", "value"}] (JSON; ops: contains, not_contains, is, is_not, is_empty, is_not_empty, gt, lt; dates also take "@today", "@this_week", "@next_7"…; people "@me"), filterMode=and|or and sort=[{"property", "dir": "asc" | "desc"}] add your own. Filters and sorts on formula and rollup properties (in a view or in the request) are skipped, because their values are worked out in the app and the server doesn’t have them.', 'view'],
    ['POST', '/api/pages/{databaseId}/rows', 'New card → 201 {"row"}: {"cells": {"Title": "…", "Status": "Done", "Due": "2026-12-01"}, "afterRowId", "templateId", "markdown"}. Properties by name or id; select/status by option name or id; dates YYYY-MM-DD, "today" or "tomorrow"; people by member ids; relations by card ids. Computed properties are refused.', 'edit, not locked'],
    ['POST', '/api/pages/{databaseId}/rows/batch', 'Up to 200 cards: {"rows": [ … as above … ]} → 201 {"rows"}.', 'edit, not locked'],
    ['GET', '/api/pages/{databaseId}/rows/{rowId}', 'One card (stored values, by property id).', 'view'],
    ['PATCH', '/api/pages/{databaseId}/rows/{rowId}', 'Change values: {"cells": {…}} (null clears one) → {"row"}. Unknown properties or wrong values: 400 naming the property.', 'edit, not locked'],
    ['PATCH', '/api/pages/{databaseId}/rows/{rowId}/cells', 'The same, as used by the app (returns {"ok", "row"}).', 'edit, not locked'],
    ['DELETE', '/api/pages/{databaseId}/rows/{rowId}', 'Delete a card.', 'edit, not locked'],
    ['GET / PUT', '/api/pages/{databaseId}/rows/{rowId}/markdown', 'A card’s own page as Markdown; PUT {"markdown", "mode": "replace" | "append"}.', 'view / edit'],
    ['GET', '/api/pages/{databaseId}/fields', 'The properties.', 'view'],
    ['POST', '/api/pages/{databaseId}/fields', 'New property → 201 {"field"}: {"name", "type", "options"}. Types: text, number, select, multi_select, status, date, checkbox, url, email, phone, person, media, checklist, unique_id, button, ai, formula (with "formula"), relation, rollup, created_time, last_edited, created_by, edited_by. Status options each need "group": "todo" | "doing" | "done".', 'edit, properties not locked'],
    ['PATCH', '/api/pages/{databaseId}/fields/{fieldIdOrName}', 'Rename, or change {"options", "formula", "aiPrompt", "prefix"}.', 'edit, properties not locked'],
    ['DELETE', '/api/pages/{databaseId}/fields/{fieldIdOrName}', 'Delete a property (not the first one) and its values.', 'edit, properties not locked'],
    ['POST', '/api/pages/{databaseId}/fields/order', '{"fields": ["Due", "Title"]}: these first, in this order.', 'edit, properties not locked'],
    ['GET', '/api/pages/{databaseId}/views', 'The views (tabs), with their filters and sorting (property names next to the ids).', 'view'],
    ['POST', '/api/pages/{databaseId}/views', 'New view → 201 {"view"}: {"name", "type": "grid" | "board" | "calendar" | "timeline" | "chart" | "form" | "list" | "gallery" | "feed", "groupBy", "subGroupBy", "dateField", "endField", "coverField", "filters": [{"property", "op", "value"}], "filterMode", "sorts": [{"property", "dir"}], "hidden": [properties]}. Properties and options by name or id. A board without groupBy groups by the first select or status property; a calendar or timeline needs a date property.', 'edit, views not locked'],
    ['PATCH', '/api/pages/{databaseId}/views/{viewIdOrName}', 'Change any of the settings above → {"view"}.', 'edit, views not locked'],
    ['DELETE', '/api/pages/{databaseId}/views/{viewIdOrName}', 'Delete a view (not the last one).', 'edit, views not locked'],
  ],
  'Calendar and tasks': [
    ['GET', '/api/workspaces/{workspaceId}/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD', 'Events, tasks, dated cards and dated to-dos (not ones on pages hidden from you).'],
    ['POST', '/api/workspaces/{workspaceId}/events', 'New event or task → 201: {"title", "startDate", "startTime", "endDate", "endTime", "status": "todo" (makes it a task), "color", "description", "repeat", "reminder"}.', 'member'],
    ['GET / PATCH', '/api/events/{eventId}', 'One event, or change any of the fields above (e.g. {"status": "done"}).', 'member'],
    ['DELETE', '/api/events/{eventId}', 'Delete an event.', 'its creator or an owner'],
    ['GET', '/api/workspaces/{workspaceId}/tasks?date=YYYY-MM-DD', 'The day’s tasks (as on Today).'],
    ['GET', '/api/workspaces/{workspaceId}/my-tasks', 'Cards assigned to you in databases you can see.', 'member'],
    ['POST', '/api/workspaces/{workspaceId}/tasks/done', 'Tick or untick a task: {"key" (from GET …/tasks or …/my-tasks), "done"}.', 'member who can edit its page'],
    ['GET', '/api/workspaces/{workspaceId}/calendar/feed', 'The private .ics subscription address.'],
    ['POST', '/api/workspaces/{workspaceId}/events/import', 'Import an .ics file (text in {"ics"}).', 'member'],
  ],
  'Files and whiteboards': [
    ['POST', '/api/workspaces/{workspaceId}/files', 'Upload (multipart/form-data, field "file") → {"url"}.', 'role: upload files'],
    ['GET', '/api/workspaces/{workspaceId}/files', 'Files you can see.'],
    ['GET', '/api/files/{fileId}', 'Download (?download=1 to save rather than show). Guests: only files used on pages shared with them.'],
    ['PATCH', '/api/files/{fileId}', 'Rename: {"name"}.', 'uploader, an owner, or an editor of a page it’s on'],
    ['DELETE', '/api/files/{fileId}', 'Delete a file.', 'uploader or an owner'],
    ['GET / POST', '/api/workspaces/{workspaceId}/whiteboards', 'Whiteboards; new one: {"title", "place": {"pageId"}}.'],
    ['GET', '/api/whiteboards/{whiteboardId}', 'One whiteboard and the pages it’s on.', 'member'],
    ['PATCH', '/api/whiteboards/{whiteboardId}', 'Rename: {"title"}.', 'member'],
    ['DELETE', '/api/whiteboards/{whiteboardId}', 'Delete a whiteboard (and its blocks on pages).', 'its creator or an owner'],
  ],
  'Templates, teamspaces, study': [
    ['GET', '/api/workspaces/{workspaceId}/templates', 'Saved templates.'],
    ['POST', '/api/templates/{templateId}/use', 'Make a page from a template: {"parentId", "title"} → 201 {"page"}.', 'owner (and edit on the parent)'],
    ['PATCH / DELETE', '/api/templates/{templateId}', 'Change {"name", "description", "icon", "repeat"}, or delete a template.', 'its creator or an owner'],
    ['GET / POST', '/api/workspaces/{workspaceId}/teamspaces', 'Teamspaces (owners see all, members the ones they’re in, guests none); new one: {"name", "icon", "memberIds"}.', 'owner to create'],
    ['PATCH / DELETE', '/api/teamspaces/{teamspaceId}', 'Change {"name", "icon", "memberIds"}, or delete it (its pages go back to the whole workspace).', 'owner'],
    ['GET / POST', '/api/pages/{pageId}/flashcards', 'Flashcards of a page; add {"cards": [{"front", "back"}]} (up to 200).', 'view / edit'],
    ['PATCH / DELETE', '/api/flashcards/{cardId}', 'Change {"front", "back"}, or delete a flashcard.', 'edit'],
    ['POST', '/api/flashcards/{cardId}/review', 'Record how a review went: {"grade": 0 to 3} (0 again, 3 easy); schedules the next one.', 'view'],
    ['GET', '/api/workspaces/{workspaceId}/flashcards/due', 'Flashcards due today (?today=YYYY-MM-DD).'],
  ],
  'Export and import': [
    ['GET', '/api/workspaces/{workspaceId}/export', 'The whole workspace as a .zip.', 'owner'],
    ['GET', '/api/pages/{pageId}/export', 'One page (and what’s inside) as a .zip.', 'view'],
    ['POST', '/api/workspaces/{workspaceId}/import-export', 'Import an Atrium export .zip (multipart, field "file"). One import per person at a time.', 'owner'],
  ],
  'Chat and meetings': [
    ['GET / POST', '/api/workspaces/{workspaceId}/chats', 'Your chats; start one: {"kind": "direct" | "group" | "team", "name", "memberIds"}.'],
    ['GET / POST', '/api/chats/{chatId}/messages', 'Messages (?before=ISO time); send {"body"} — <@userId>, <page:id>, <date:ISO> show as chips.'],
    ['GET / POST', '/api/workspaces/{workspaceId}/meetings', 'Meetings; schedule {"title", "startsAt", "durationMin", "inviteeIds", "tasks", "defaults"}.', 'member; scheduling: not guests, role: start meetings'],
    ['GET', '/api/meetings/{code}', 'A meeting: details, people, permissions and the tasks you can see.'],
  ],
  'Webhooks (workspace owners)': [
    ['GET / POST', '/api/workspaces/{workspaceId}/webhooks', 'Webhooks; add {"url", "events": [...], "active"} → {"id", "secret"} (the secret is shown once).', 'owner'],
    ['PATCH / DELETE', '/api/webhooks/{webhookId}', 'Change or remove one.', 'owner'],
    ['POST', '/api/webhooks/{webhookId}/rotate-secret', 'A new secret (the old one stops at once) → {"secret"}.', 'owner'],
    ['POST', '/api/webhooks/{webhookId}/test', 'Send a "ping" now.', 'owner'],
  ],
  AI: [
    ['POST', '/api/workspaces/{workspaceId}/ai/transform', 'Rewrite text: {"text", "instruction", "context"} → {"text", "events"}. Can run in the background.', 'role: use AI'],
    ['POST', '/api/workspaces/{workspaceId}/ai/transcribe', 'A recording you can see as text: {"fileId"} → {"text"}. Can run in the background.', 'role: use AI'],
    ['POST', '/api/pages/{pageId}/flashcards/generate', 'Suggested flashcards from a page → {"cards"}. Can run in the background.', 'edit (and role: use AI)'],
    ['POST', '/api/pages/{pageId}/quiz', 'A multiple-choice quiz → {"questions"}. Can run in the background.', 'view (and role: use AI)'],
    ['POST', '/api/pages/{databaseId}/fields/{fieldId}/ai-fill', 'Fill an AI property: {"rowIds", "overwrite"} → {"filled", "remaining"}. Can run in the background.', 'edit (and role: use AI)'],
    ['POST', '/api/workspaces/{workspaceId}/ai/ask', 'Ask the assistant: {"message", "today", "attachments": [{"name", "text"}]} → the chat; the answer is saved to it when ready (poll GET /api/ai/chats/{chatId}).', 'role: use AI'],
    ['GET / DELETE', '/api/ai/jobs/{jobId}', 'How a background request is doing ({"done": false} or {"done": true, "result"}; an error comes back with its status), or stop it.', 'the person who started it'],
  ],
};

const SESSION_ONLY = [
  'changing your password, name or email (POST /api/auth/password, PATCH /api/auth/me)',
  'your preferences and daily email (PUT /api/auth/me/prefs, PUT /api/auth/me/digest)',
  'signing out (POST /api/auth/logout) and live-editing tickets (GET /api/auth/live-ticket)',
  'your AI connection and model list (PUT/DELETE /api/ai/connection, POST /api/ai/models)',
  'notifications and invitations (GET /api/notifications, /api/invitations, accepting or declining)',
  'deleting a workspace and changing or removing members (DELETE /api/workspaces/{id}, PATCH/DELETE …/members/{userId})',
  'making and deleting API tokens',
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The guide's endpoints, one entry per path with its methods (for openapi.json and its check). */
export function guideRows() {
  return Object.values(S).flatMap((rows) => rows.map(([m, path, what, who]) => ({ methods: m.split('/').map((x) => x.trim()), path, what, who: who ?? 'anyone who can see it' })));
}

export function apiGuide() {
  const events = WEBHOOK_EVENTS.map((e) => `<code>${e}</code>`).join(', ');
  const sections = Object.entries(S)
    .map(
      ([title, rows]) => `<h3>${title}</h3>
<table><tr><th>Method</th><th>Path</th><th>What it does</th><th>Who</th></tr>
${rows.map(([m, p, d, who]) => `<tr><td>${m}</td><td><code>${esc(p)}</code></td><td>${esc(d)}</td><td>${esc(who ?? 'anyone who can see it')}</td></tr>`).join('\n')}
</table>`,
    )
    .join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.appName} API</title>
<style>
body{font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#16181d}code,pre{background:#262a33!important}td,th{border-color:#333!important}}
h1{font-size:28px}h2{margin-top:36px}h3{margin-top:24px}code,pre{background:#f3f4f6;border-radius:5px;padding:1px 5px;font-size:13px}pre{padding:12px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}td:first-child{font-weight:600;white-space:nowrap}
</style></head><body>
<h1>${config.appName} API</h1>
<p>Everything the app does goes through this JSON API. Scripts and other apps use it with a <b>personal API token</b> and act as the person who made it, seeing and changing only what they can.</p>

<h2>Tokens</h2>
<ul>
<li>Make one in the app: <b>Settings → API & webhooks → New token</b> (needs the <b>API tokens</b> permission). Send it as <code>Authorization: Bearer atr_…</code> (tokens from before 1.9.0 start with <code>af_</code>).</li>
<li>A token can be <b>limited to one workspace</b>: everything else then answers 404, as if it didn't exist. It can have an <b>expiry</b> (days). Each person can have up to <b>50</b>.</li>
<li>A token stops working when it expires or is deleted, and when its owner signs out everywhere, changes their password (or an admin resets it), is switched off, or loses the API tokens permission.</li>
<li>These are only possible in the app, never with a token (403): ${SESSION_ONLY.map(esc).join('; ')}.</li>
<li>No CORS: browsers on other sites can't call the API; use it from servers and scripts.</li>
<li>50 invalid tokens from one address in 15 minutes block that address for a while (other <code>Authorization</code> headers, such as a proxy's Basic login, are ignored).</li>
</ul>
<pre>curl -H "Authorization: Bearer atr_…" ${'$'}SERVER/api/workspaces</pre>

<h2>Requests and errors</h2>
<p>Send JSON with <code>Content-Type: application/json</code>. Errors come back as <code>{"error": "message"}</code> with a 4xx/5xx status; a wrong field also names it (<code>"field": "cells.Due"</code>). <b>423</b> means the page (or its database properties) is locked against edits. Making something answers <b>201</b>. Pages are only made by workspace <b>owners</b>; <b>guests</b> only see the pages shared with them and the files and boards on those pages.</p>

<h2>AI requests that take a while</h2>
<p>An AI call that a request waits for stops after ${Math.round(HELD_TIMEOUT_MS / 1000)} seconds (<code>AI_TIMEOUT_MS</code>) with 424 and a message. Requests marked "can run in the background" below take <code>Prefer: respond-async</code>: they answer <b>202 {"job": "…"}</b> at once, and <code>GET /api/ai/jobs/{job}</code> says how it's going. Jobs are kept in memory for 10 minutes after they finish (a server restart forgets them); each person can run up to 4 at a time; <code>DELETE /api/ai/jobs/{job}</code> stops one. Problems with the AI service answer <b>424</b>, a rate-limited key <b>429</b>.</p>

<h2>Endpoints</h2>
${sections}
<p>The full list of the app's own routes is in <code>server/src/routes/</code>; the app guide (how everything works, in Markdown) is at <code>GET /api/guide</code> (<code>?topic=meetings</code> for one subject).</p>

<h2>Webhooks</h2>
<p>When something happens, the server sends a <code>POST</code> with JSON to each matching webhook:</p>
<pre>{"event": "row.created", "workspaceId": "…", "at": "2026-11-01T12:00:00.000Z", "actor": {"id": "…", "name": "…"}, "data": { … }}</pre>
<p>Events: ${events} (and <code>ping</code> from the Test button). <code>actor</code> is null for things the server does by itself. Headers: <code>X-Event</code>, <code>X-Delivery-Id</code> (unique per delivery), <code>X-Timestamp</code> (Unix seconds), <code>X-Signature</code> (HMAC-SHA256 of the raw body) and <code>X-Signature-V2</code> (HMAC-SHA256 of <code>timestamp + "." + body</code>; check it and reject old timestamps to stop replays):</p>
<pre>const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');</pre>

<h2>MCP (for AI assistants)</h2>
<p><code>POST /api/mcp</code> is an MCP server (Streamable HTTP) that lets an assistant like Claude use a workspace as its memory. Tools: <code>search_notes</code>, <code>read_note</code>, <code>list_notes</code>, <code>recent_notes</code>, <code>related_notes</code>, <code>app_guide</code>, <code>graph_groups</code> (read); <code>create_note</code> (owners), <code>update_note</code>, <code>set_note_group</code>, <code>delete_note</code>; <code>read_database</code>, <code>add_card</code>, <code>update_card</code>, <code>delete_card</code>, <code>create_task</code>, <code>list_members</code>; <code>read_calendar</code> (read), <code>move_note</code> (owner of the note or a workspace owner), <code>list_trash</code> (read), <code>restore_note</code>. <code>[[Title]]</code> links in note text become links. Writing (update, delete, cards) needs the exact title or the id; reading accepts part of a title. Arguments are checked against each tool's schema. Use a token limited to one workspace (or add <code>?workspace=&lt;id&gt;</code>):</p>
<pre>claude mcp add --transport http workspace-brain ${'$'}SERVER/api/mcp --header "Authorization: Bearer atr_…"</pre>
</body></html>`;
}
