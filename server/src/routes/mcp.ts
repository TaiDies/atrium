import type { FastifyInstance, FastifyRequest } from 'fastify';
import { accessMap, requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { editDoc, readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { guideFor } from '../aiGuide.js';
import { GRAPH_COLORS, graphStyle, setGraphStyle, setPageGroup } from '../graphStyle.js';
import { linkedTitles, type PageLinks, writeMarkdown } from '../markdownBlocks.js';
import { databaseToCsv, docToMarkdown } from '../readable.js';
import { tokenWorkspace } from '../scope.js';
import { HttpError } from '../util.js';

// An MCP server (Model Context Protocol, the way AI assistants like Claude connect to tools), so an
// assistant can use a workspace as its long-term memory — a "second brain" like an Obsidian vault:
// searching and reading notes, writing new ones, and linking them with [[Title]] so they connect in
// the graph. It acts as the person whose API token it's given, so it sees and changes only what they
// can; a token limited to one workspace keeps it there.
//
// Streamable HTTP, without streaming: each POST is one JSON-RPC message and gets one JSON answer.

const PROTOCOL = '2025-06-18';
const isDatabase = (type: string) => (DATABASE_TYPES as readonly string[]).includes(type);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTRUCTIONS = `This connects you to a workspace in ${config.appName} that you can use as your own long-term memory — a second brain made of linked notes, like an Obsidian vault.

How to use it well:
- Before answering anything that might build on earlier work, search it (search_notes) and read what you find (read_note). Follow [[links]] and backlinks to related notes.
- Keep notes small and focused: one idea, person, project or decision per note, with a clear title. Prefer updating an existing note (update_note) to making a near-duplicate.
- Link generously with [[Note title]] (or [[Note title|text to show]]). A link to a title that doesn't exist yet creates an empty note for it, which you can fill in later. Links connect notes in the workspace's graph and show as backlinks.
- Hub notes ("maps of content") that link to the notes on one topic make the brain easy to navigate. list_notes shows how notes nest; related_notes shows a note's neighbours in the graph.
- Write in Markdown: headings, lists, "- [ ] tasks", **bold**, quotes and code blocks all work.
- Give the graph meaning with groups: each group (graph_groups) is a colour that stands for a kind of note — e.g. people, projects, decisions — and set_note_group puts a note in one. Then the colours alone show what's what.
- The person can read and edit everything you write in the app, and sees it change live.`;

interface Ctx {
  userId: string;
  workspaceId: string;
  auth: string;
  inject: FastifyInstance['inject'];
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: Ctx, args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// ---------- helpers ----------

async function visiblePages(ctx: Ctx) {
  const access = await accessMap(ctx.userId, ctx.workspaceId);
  const rows = await query<{ id: string; title: string; type: string; parentId: string | null; updatedAt: string }>(
    `select id, title, type, parent_id as "parentId", to_char(updated_at, 'YYYY-MM-DD HH24:MI') as "updatedAt"
       from pages where workspace_id = $1 and deleted_at is null and archived_at is null order by position, created_at`,
    [ctx.workspaceId],
  );
  return rows.filter((p) => (access.get(p.id) ?? 'none') !== 'none').map((p) => ({ ...p, title: p.title || 'Untitled', canEdit: access.get(p.id) !== 'view' }));
}

/** A note by its id, or by its title (exact first, then a close match). */
async function findNote(ctx: Ctx, args: Record<string, unknown>) {
  const pages = await visiblePages(ctx);
  const id = str(args.id).trim();
  const title = str(args.title).trim().toLowerCase();
  const found = (id && UUID.test(id) && pages.find((p) => p.id === id)) || (title && (pages.find((p) => p.title.toLowerCase() === title) ?? pages.find((p) => p.title.toLowerCase().includes(title))));
  if (!found) throw new Error(`No note found for ${id ? `id ${id}` : `"${str(args.title)}"`}. Use search_notes or list_notes to find it.`);
  return { note: found, pages };
}

const pageHref = (ctx: Ctx, id: string) => `/w/${ctx.workspaceId}/p/${id}`;

/** A note's text, with links to other notes written back as [[Title]]. */
async function noteMarkdown(ctx: Ctx, page: { id: string; title: string; type: string }, titles: Map<string, string>) {
  const text = await readDoc(page.id, null, (doc) =>
    isDatabase(page.type)
      ? databaseToCsv(doc)
      : docToMarkdown(doc, page.title, { pageLink: (id) => ({ title: `\u0001${id}\u0001`, href: null }), fileLink: () => null, eventLabel: () => null, boardLabel: () => null }),
  );
  return text
    .replace(/@?\\?\u0001([0-9a-f-]{36})\\?\u0001/gi, (_, id: string) => `[[${titles.get(id.toLowerCase()) ?? 'a note you cannot see'}]]`)
    .replace(/\[([^\]]+)\]\(\/w\/[^/)]+\/p\/([0-9a-f-]{36})\)/gi, (_, shown: string, id: string) => {
      const t = titles.get(id.toLowerCase());
      return t ? (t === shown ? `[[${t}]]` : `[[${t}|${shown}]]`) : shown;
    });
}

/** Makes a note through the app's own route (same checks, positions, notifications and webhooks). */
async function createPage(ctx: Ctx, title: string, parentId: string | null) {
  const res = await ctx.inject({
    method: 'POST',
    url: `/api/workspaces/${ctx.workspaceId}/pages`,
    headers: { authorization: ctx.auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ title: title.slice(0, 300), type: 'document', parentId }),
  });
  const body = res.json() as { page?: { id: string }; error?: string };
  if (res.statusCode >= 300 || !body.page) throw new Error(body.error ?? `Could not create the note (${res.statusCode})`);
  return body.page.id;
}

/** Where each [[Title]] in some Markdown points; titles without a note get an empty one. */
async function resolveLinks(ctx: Ctx, markdown: string, pages: { id: string; title: string }[]): Promise<{ links: PageLinks; created: string[] }> {
  const links: PageLinks = new Map();
  const created: string[] = [];
  for (const title of linkedTitles(markdown)) {
    const key = title.toLowerCase();
    let page = pages.find((p) => p.title.toLowerCase() === key);
    if (!page) {
      const id = await createPage(ctx, title, null);
      page = { id, title };
      pages.push(page);
      created.push(title);
    }
    links.set(key, pageHref(ctx, page.id));
  }
  return { links, created };
}

async function write(ctx: Ctx, pageId: string, markdown: string, replace: boolean, pages: { id: string; title: string }[]) {
  const { links, created } = await resolveLinks(ctx, markdown, pages);
  await editDoc(pageId, null, (doc) => writeMarkdown(doc, markdown, replace, links), { editor: ctx.userId });
  return created;
}

async function neighbours(ctx: Ctx, id: string) {
  const out = await query<{ id: string }>(`select distinct target_page as id from page_links where source_page = $1`, [id]);
  const back = await query<{ id: string }>(`select distinct source_page as id from page_links where target_page = $1`, [id]);
  return { out: out.map((r) => r.id), back: back.map((r) => r.id) };
}

// ---------- the tools ----------

const TOOLS: Tool[] = [
  {
    name: 'search_notes',
    description: 'Search the notes by words in their titles and text. Returns the best matches with a short excerpt. Search before writing, to build on what is already there.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' }, limit: { type: 'number', description: 'Most results (default 10)' } }, required: ['query'] },
    async run(ctx, args) {
      const words = [...new Set(str(args.query).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 12);
      if (!words.length) return 'Give some words to search for.';
      const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`);
      const access = await accessMap(ctx.userId, ctx.workspaceId);
      const rows = await query<{ id: string; title: string; text: string; score: number }>(
        `select p.id, p.title, coalesce(c.text_content, '') as text,
                (select count(*) from unnest($2::text[]) k where p.title ilike k) * 3
              + (select count(*) from unnest($2::text[]) k where c.text_content ilike k) as score
           from pages p left join page_content c on c.page_id = p.id
          where p.workspace_id = $1 and p.deleted_at is null and p.archived_at is null
          order by score desc, p.updated_at desc limit 60`,
        [ctx.workspaceId, patterns],
      );
      const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
      const hits = rows.filter((r) => r.score > 0 && (access.get(r.id) ?? 'none') !== 'none').slice(0, limit);
      if (!hits.length) return `No notes match "${str(args.query)}".`;
      return hits
        .map((h) => {
          const at = h.text.toLowerCase().indexOf(words[0]);
          const excerpt = h.text.slice(Math.max(0, at - 80), Math.max(0, at - 80) + 240).replace(/\s+/g, ' ').trim();
          return `- [[${h.title || 'Untitled'}]] (id ${h.id})${excerpt ? `\n  …${excerpt}…` : ''}`;
        })
        .join('\n');
    },
  },
  {
    name: 'read_note',
    description: 'Read a note in full (as Markdown, with [[links]]), plus the notes it links to, the notes that link to it (backlinks), and the notes inside it. Give its id or its title.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
    async run(ctx, args) {
      const { note, pages } = await findNote(ctx, args);
      const titles = new Map(pages.map((p) => [p.id.toLowerCase(), p.title]));
      const body = await noteMarkdown(ctx, note, titles);
      const { out, back } = await neighbours(ctx, note.id);
      const names = (ids: string[]) => ids.map((id) => titles.get(id.toLowerCase())).filter(Boolean).map((t) => `[[${t}]]`).join(', ') || 'none';
      const children = pages.filter((p) => p.parentId === note.id).map((p) => `[[${p.title}]]`).join(', ') || 'none';
      const parent = note.parentId ? titles.get(note.parentId.toLowerCase()) : null;
      return `# ${note.title}\n(id ${note.id} · ${note.type} · last edited ${note.updatedAt}${note.canEdit ? '' : ' · read-only'}${parent ? ` · inside [[${parent}]]` : ''})\n\n${body.replace(/^# .*\n+/, '')}\n\n---\nLinks to: ${names(out)}\nLinked from (backlinks): ${names(back)}\nNotes inside: ${children}`;
    },
  },
  {
    name: 'list_notes',
    description: 'List every note as an outline (notes nested inside other notes are indented), with ids. Optionally only what is inside one note.',
    inputSchema: { type: 'object', properties: { inside: { type: 'string', description: 'Id or title of a note to list the inside of' } } },
    async run(ctx, args) {
      const pages = await visiblePages(ctx);
      let root: string | null = null;
      if (str(args.inside)) root = (await findNote(ctx, { id: args.inside, title: args.inside })).note.id;
      const lines: string[] = [];
      const walk = (parent: string | null, depth: number) => {
        for (const p of pages.filter((x) => x.parentId === parent)) {
          if (lines.length >= 600) return;
          lines.push(`${'  '.repeat(depth)}- ${p.title}${p.type === 'document' ? '' : ` (${p.type} database)`} · id ${p.id}`);
          walk(p.id, depth + 1);
        }
      };
      walk(root, 0);
      return lines.length ? lines.join('\n') + (lines.length >= 600 ? '\n…(more not shown)' : '') : 'No notes yet.';
    },
  },
  {
    name: 'recent_notes',
    description: 'The notes changed most recently.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many (default 15)' } } },
    async run(ctx, args) {
      const pages = await visiblePages(ctx);
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 15));
      return [...pages]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map((p) => `- [[${p.title}]] · ${p.updatedAt} · id ${p.id}`)
        .join('\n') || 'No notes yet.';
    },
  },
  {
    name: 'create_note',
    description: 'Write a new note. Content is Markdown; link other notes with [[Title]] (missing ones are created empty). Optionally put it inside another note.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown' },
        inside: { type: 'string', description: 'Id or title of the note to put it inside (optional)' },
      },
      required: ['title'],
    },
    async run(ctx, args) {
      const title = str(args.title).trim();
      if (!title) throw new Error('Give the note a title.');
      const pages = await visiblePages(ctx);
      if (pages.some((p) => p.title.toLowerCase() === title.toLowerCase())) {
        throw new Error(`A note called "${title}" already exists — use update_note to add to it, or choose another title.`);
      }
      const parentId = str(args.inside) ? (await findNote(ctx, { id: args.inside, title: args.inside })).note.id : null;
      const id = await createPage(ctx, title, parentId);
      pages.push({ id, title, type: 'document', parentId, updatedAt: '', canEdit: true });
      const created = str(args.content) ? await write(ctx, id, str(args.content), true, pages) : [];
      return `Created [[${title}]] (id ${id}).${created.length ? ` New empty notes for links: ${created.map((t) => `[[${t}]]`).join(', ')}.` : ''}`;
    },
  },
  {
    name: 'update_note',
    description: 'Add Markdown to the end of a note ("append", the default) or replace its whole content ("replace"). Can also rename it. [[Title]] links work as in create_note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string', description: 'Find the note by title (if no id)' },
        content: { type: 'string', description: 'Markdown' },
        mode: { type: 'string', enum: ['append', 'replace'] },
        new_title: { type: 'string' },
      },
    },
    async run(ctx, args) {
      const { note, pages } = await findNote(ctx, args);
      if (!note.canEdit) throw new Error(`[[${note.title}]] is read-only for you.`);
      if (note.type !== 'document') throw new Error(`[[${note.title}]] is a database, not a document — it can be read but not written as Markdown.`);
      const parts: string[] = [];
      if (str(args.new_title).trim()) {
        const res = await ctx.inject({
          method: 'PATCH',
          url: `/api/pages/${note.id}`,
          headers: { authorization: ctx.auth, 'content-type': 'application/json' },
          payload: JSON.stringify({ title: str(args.new_title).trim() }),
        });
        if (res.statusCode >= 300) throw new Error((res.json() as { error?: string }).error ?? 'Could not rename it');
        parts.push(`renamed to [[${str(args.new_title).trim()}]]`);
      }
      if (str(args.content)) {
        const created = await write(ctx, note.id, str(args.content), args.mode === 'replace', pages);
        parts.push(args.mode === 'replace' ? 'content replaced' : 'content added');
        if (created.length) parts.push(`new empty notes for links: ${created.map((t) => `[[${t}]]`).join(', ')}`);
      }
      return parts.length ? `[[${note.title}]]: ${parts.join('; ')}.` : 'Nothing to change (give content or new_title).';
    },
  },
  {
    name: 'related_notes',
    description: 'The notes connected to one note in the graph: what it links to, what links to it, its parent and the notes inside it — optionally two steps out.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, depth: { type: 'number', description: '1 (default) or 2' } } },
    async run(ctx, args) {
      const { note, pages } = await findNote(ctx, args);
      const titles = new Map(pages.map((p) => [p.id.toLowerCase(), p.title]));
      const near = async (id: string) => {
        const { out, back } = await neighbours(ctx, id);
        const p = pages.find((x) => x.id === id);
        return [...out, ...back, ...(p?.parentId ? [p.parentId] : []), ...pages.filter((x) => x.parentId === id).map((x) => x.id)].filter((x) => titles.has(x.toLowerCase()) && x !== note.id);
      };
      const first = [...new Set(await near(note.id))];
      const lines = [`[[${note.title}]] is connected to:`, ...first.map((id) => `- [[${titles.get(id.toLowerCase())}]]`)];
      if (Number(args.depth) >= 2) {
        const second = new Set<string>();
        for (const id of first) for (const x of await near(id)) if (!first.includes(x)) second.add(x);
        if (second.size) lines.push('', 'Two steps away:', ...[...second].slice(0, 60).map((id) => `- [[${titles.get(id.toLowerCase())}]]`));
      }
      return first.length ? lines.join('\n') : `[[${note.title}]] isn't connected to other notes yet.`;
    },
  },
  {
    name: 'delete_note',
    description: 'Move a note (and the notes inside it) to the trash. It can be restored from the trash in the app.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
    async run(ctx, args) {
      const { note } = await findNote(ctx, args);
      const res = await ctx.inject({ method: 'POST', url: `/api/pages/${note.id}/trash`, headers: { authorization: ctx.auth, 'content-type': 'application/json' }, payload: '{}' });
      if (res.statusCode >= 300) throw new Error((res.json() as { error?: string }).error ?? 'Could not delete it');
      return `Moved [[${note.title}]] to the trash.`;
    },
  },
  {
    name: 'app_guide',
    description:
      'How the app this memory lives in works — every feature (pages, databases, calendar, tasks, files, chat, meetings, graph, imports, notifications, API, MCP) with the exact menus and buttons. Give a topic (e.g. "meetings", "import files", "formulas") to get just the matching sections; leave it out for the whole guide. Use it before explaining the app to the person or when unsure how something works.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'What it is about (optional)' } } },
    async run(_ctx, args) {
      return guideFor(str(args.topic));
    },
  },
  {
    name: 'set_note_group',
    description:
      'Put a note in one of the graph\'s groups (or "none" to take it out). Groups give the graph its colours, and each colour means something — e.g. "People", "Projects", "Lessons". See and define groups with graph_groups first; a group can be named here with a colour to make it on the spot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string', description: 'Find the note by title (if no id)' },
        group: { type: 'string', description: 'The group\'s name, or "none"' },
        color: { type: 'string', description: `Only to make a new group: ${Object.keys(GRAPH_COLORS).join(', ')} or #rrggbb` },
        description: { type: 'string', description: 'Only to make a new group: what being in it means' },
      },
      required: ['group'],
    },
    async run(ctx, args) {
      const { note } = await findNote(ctx, args);
      const name = str(args.group).trim();
      if (name && name.toLowerCase() !== 'none' && args.color) {
        const style = await graphStyle(ctx.workspaceId);
        if (!style.groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
          await setGraphStyle(ctx.userId, ctx.workspaceId, { ...style, groups: [...style.groups, { name, color: args.color, description: str(args.description) }] });
        }
      }
      const group = await setPageGroup(ctx.userId, note.id, name);
      return group ? `[[${note.title}]] is in the group "${group.name}" (${group.color}).` : `[[${note.title}]] isn't in a group now.`;
    },
  },
  {
    name: 'graph_groups',
    description:
      'See or change what the graph\'s colours mean. Groups: each has a name, a colour and a description of what it means; notes are put in one with set_note_group, and a group can also take in notes by rule ("match": titles containing the text, or "under:Title" for the notes inside a note). The first group a note matches wins; a note put in a group by hand stays there. Lines: a colour for each kind ("link" between notes, "child" for notes inside notes, "relation" for database relations). Call with nothing to see the groups (with their notes) and line colours; giving groups replaces the list (keep a group\'s name to keep its notes in it), giving links replaces the line colours.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, color: { type: 'string' }, description: { type: 'string' }, match: { type: 'string' } },
            required: ['name', 'color'],
          },
        },
        links: { type: 'object', properties: { link: { type: 'string' }, child: { type: 'string' }, relation: { type: 'string' } } },
      },
    },
    async run(ctx, args) {
      let style = await graphStyle(ctx.workspaceId);
      if (args.links !== undefined || args.groups !== undefined) {
        style = await setGraphStyle(ctx.userId, ctx.workspaceId, { links: args.links ?? style.links, groups: args.groups ?? style.groups });
      }
      const members = await query<{ title: string; group: string }>(
        `select title, graph_group as "group" from pages where workspace_id = $1 and graph_group is not null and deleted_at is null order by title`,
        [ctx.workspaceId],
      );
      const links = Object.entries(style.links);
      const groups = style.groups.map((g) => {
        const notes = members.filter((m) => m.group === g.id).map((m) => `[[${m.title || 'Untitled'}]]`);
        return `- **${g.name}** ${g.color}${g.description ? ` — ${g.description}` : ''}${g.match ? ` (also takes in: ${g.match})` : ''}\n  ${notes.length ? notes.join(', ') : 'no notes put in by hand'}`;
      });
      return [groups.length ? `Groups:\n${groups.join('\n')}` : 'No groups yet.', `Line colours: ${links.length ? links.map(([k, c]) => `${k} ${c}`).join(', ') : 'the defaults'}.`].join('\n\n');
    },
  },
];

// ---------- the protocol ----------

async function workspaceFor(req: FastifyRequest): Promise<string> {
  const scoped = tokenWorkspace();
  if (scoped) return scoped;
  const asked = (req.query as { workspace?: string })?.workspace ?? (req.headers['x-workspace'] as string | undefined);
  if (asked && UUID.test(asked)) {
    await requireMember(req.user.id, asked, undefined, true);
    return asked;
  }
  throw new HttpError(400, 'Use an API token limited to one workspace (Settings → API & webhooks), or add ?workspace=<workspace id> to the address');
}

type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };

export async function mcpRoutes(app: FastifyInstance) {
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Send MCP messages with POST' }));

  app.post('/mcp', { preHandler: requireUser, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    if (!req.headers.authorization) throw new HttpError(401, 'Connect with an API token (Authorization: Bearer atr_…)');
    const workspaceId = await workspaceFor(req);
    const ctx: Ctx = { userId: req.user.id, workspaceId, auth: req.headers.authorization, inject: app.inject.bind(app) };
    const msg = req.body as RpcRequest | RpcRequest[];
    const answer = async (m: RpcRequest) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
      const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
      switch (m.method) {
        case 'initialize': {
          const ws = await one<{ name: string }>('select name from workspaces where id = $1', [workspaceId]);
          return ok({
            protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: `${config.appName} — ${ws?.name ?? 'workspace'}`, version: '1.0.0' },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const tool = TOOLS.find((t) => t.name === m.params?.name);
          if (!tool) return fail(-32602, `Unknown tool ${String(m.params?.name)}`);
          try {
            const text = await tool.run(ctx, (m.params?.arguments as Record<string, unknown>) ?? {});
            return ok({ content: [{ type: 'text', text }] });
          } catch (err) {
            return ok({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
          }
        }
        default:
          return m.id === undefined ? null : fail(-32601, `Method not found: ${m.method}`);
      }
    };
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(answer))).filter(Boolean);
      return out.length ? out : reply.code(202).send();
    }
    if (!msg || typeof msg.method !== 'string') return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    // Notifications (no id) get no answer.
    if (msg.id === undefined) return reply.code(202).send();
    return answer(msg);
  });
}
