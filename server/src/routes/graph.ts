import type { FastifyInstance } from 'fastify';
import { accessMap, requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { fieldsOf } from '../docIndex.js';
import { query } from '../db.js';
import { graphStyle, setGraphStyle, setPageGroup } from '../graphStyle.js';
import { idParams, parse } from '../util.js';

// The workspace as a graph: every page someone can see, and how pages connect — links and mentions
// written in them (cards included), pages inside pages, and database relations — with the groups
// pages belong to (each a colour with a meaning) and the colours of the lines.

type EdgeKind = 'link' | 'child' | 'relation';

export async function graphRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/workspaces/:id/graph', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id, undefined, true);
    const access = await accessMap(req.user.id, id);
    const visible = (pageId: string) => (access.get(pageId) ?? 'none') !== 'none';

    const pages = (
      await query<{ id: string; title: string; icon: string; type: string; parentId: string | null; group: string | null }>(
        `select id, title, icon, type, parent_id as "parentId", graph_group as "group" from pages
          where workspace_id = $1 and deleted_at is null and archived_at is null`,
        [id],
      )
    ).filter((p) => visible(p.id));
    const ids = new Set(pages.map((p) => p.id));

    const edges = new Map<string, { source: string; target: string; kind: EdgeKind }>();
    const add = (source: string, target: string, kind: EdgeKind) => {
      if (source === target || !ids.has(source) || !ids.has(target)) return;
      // One line per pair (a link wins over the others).
      const key = source < target ? `${source}|${target}` : `${target}|${source}`;
      const existing = edges.get(key);
      if (!existing || (kind === 'link' && existing.kind !== 'link')) edges.set(key, { source, target, kind });
    };

    for (const p of pages) if (p.parentId) add(p.parentId, p.id, 'child');

    const links = await query<{ source: string; target: string }>(
      `select distinct l.source_page as source, l.target_page as target
         from page_links l join pages p on p.id = l.source_page and p.workspace_id = $1`,
      [id],
    );
    for (const l of links) add(l.source, l.target, 'link');

    // Relations: a database whose cards link to another database's cards.
    for (const p of pages.filter((p) => (DATABASE_TYPES as readonly string[]).includes(p.type))) {
      const fields = await readDoc(p.id, null, fieldsOf).catch(() => []);
      for (const f of fields as { type: string; relation?: { pageId?: string } }[]) {
        if (f.type === 'relation' && f.relation?.pageId) add(p.id, f.relation.pageId, 'relation');
      }
    }

    return {
      nodes: pages.map((p) => ({ id: p.id, title: p.title, icon: p.icon, type: p.type, parentId: p.parentId, group: p.group })),
      edges: [...edges.values()],
      style: await graphStyle(id),
    };
  });

  app.put('/workspaces/:id/graph/style', async (req) => {
    const { id } = parse(idParams, req.params);
    return { style: await setGraphStyle(req.user.id, id, req.body) };
  });

  app.put('/pages/:id/graph-group', async (req) => {
    const { id } = parse(idParams, req.params);
    return { group: await setPageGroup(req.user.id, id, (req.body as { group?: unknown } | null)?.group) };
  });
}
