import { emit } from '../webhooks.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as Y from 'yjs';
import { updateDocIndex } from '../docIndex.js';
import { notify } from '../notify.js';
import { type Access, accessMap, requireMember, requirePage, requireUnlocked, visibleFiles } from '../access.js';
import { deleteFile, filesOnlyIn } from './notes.js';
import { requireUser } from '../auth.js';
import { editDoc } from '../blocks.js';
import { appendSubpageBlock, applyUpdate, closePage, createDatabaseState, DATABASE_TYPES, notifyPageChanged } from '../collab.js';
import { one, query, tx } from '../db.js';
import { escapeLike, HttpError, idParams, parse } from '../util.js';

const PAGE_COLUMNS = `p.id, p.workspace_id as "workspaceId", p.parent_id as "parentId", p.type, p.title, p.icon,
  p.cover, p.position, p.created_at as "createdAt", p.updated_at as "updatedAt", p.locked, p.archived_at as "archivedAt",
  p.verified_until as "verifiedUntil", p.layout, p.teamspace_id as "teamspaceId"`;

const title = z.string().max(300);
const icon = z.string().max(16);
const cover = z.string().max(1000).nullable();
const pageType = z.enum(['document', ...DATABASE_TYPES]);
const level = z.enum(['edit', 'view', 'none']);

/** Pages the user can see, each tagged with their access level. */
function visible<T extends { id: string }>(rows: T[], access: Map<string, Access>) {
  return rows.filter((r) => (access.get(r.id) ?? 'none') !== 'none').map((r) => ({ ...r, access: access.get(r.id)! }));
}

/** Events placed only in a page and the pages inside it (with their cards), and in no other page. */
const OWN_EVENTS = `with recursive sub as (
    select id from pages where id = $1
    union all select p.id from pages p join sub on p.parent_id = sub.id
  )
  select e.id from events e
   where exists (select 1 from event_refs r where r.event_id = e.id and r.page_id in (select id from sub))
     and not exists (select 1 from event_refs r where r.event_id = e.id and r.page_id not in (select id from sub))`;

/** Only workspace owners add pages; members edit the pages they've been given access to. */
async function requirePageCreator(userId: string, workspaceId: string) {
  if ((await requireMember(userId, workspaceId)) !== 'owner') throw new HttpError(403, 'Only workspace owners can add pages');
}

export async function pageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/workspaces/:id/pages', async (req) => {
    const { id } = parse(idParams, req.params);
    const access = await accessMap(req.user.id, id);
    const pages = await query(
      `select ${PAGE_COLUMNS}, (f.page_id is not null) as "isFavorite",
              (p.default_access is not null or exists (select 1 from page_permissions pp where pp.page_id = p.id)) as "restricted"
         from pages p
         left join favorites f on f.page_id = p.id and f.user_id = $2
        where p.workspace_id = $1 and p.deleted_at is null
        order by p.position, p.created_at`,
      [id, req.user.id],
    );
    return { pages: visible(pages, access) };
  });

  app.post('/workspaces/:id/pages', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requirePageCreator(req.user.id, id);
    const body = parse(
      z.object({
        // Apps choose the id themselves when a page is made offline, so it can be sent again safely.
        id: z.uuid().optional(),
        parentId: z.uuid().nullable().optional(),
        type: pageType.default('document'),
        title: title.optional(),
        icon: icon.optional(),
        // Also add a link block for the new page inside the parent document.
        insertIntoParent: z.boolean().default(false),
        // Skip the starter fields/rows of a new database (used when importing).
        empty: z.boolean().default(false),
      }),
      req.body,
    );
    if (body.id) {
      const existing = await one(
        `select ${PAGE_COLUMNS}, false as "isFavorite", false as "restricted", 'manage' as "access" from pages p where p.id = $1 and p.workspace_id = $2`,
        [body.id, id],
      );
      if (existing) return reply.code(200).send({ page: existing }); // already made (a retried request)
    }
    const parentId = body.parentId ?? null;
    let parentType: string | null = null;
    if (parentId) {
      const parent = await requirePage(req.user.id, parentId, 'edit');
      if (parent.workspace_id !== id || parent.deleted_at) throw new HttpError(400, 'Invalid parent page');
      parentType = parent.type;
    }
    const page = await tx(async (c) => {
      const page = (await one(
        `insert into pages (id, workspace_id, parent_id, type, title, icon, position, created_by, updated_by)
         values (coalesce($7::uuid, gen_random_uuid()), $1, $2, $3, $4, $5,
                 coalesce((select max(position) + 1 from pages where workspace_id = $1 and parent_id is not distinct from $2), 0),
                 $6, $6)
         returning ${PAGE_COLUMNS.replaceAll('p.', '')}, false as "isFavorite", false as "restricted", 'manage' as "access"`,
        [id, parentId, body.type, body.title ?? '', body.icon ?? '', req.user.id, body.id ?? null],
        c,
      ))!;
      if (body.type !== 'document' && !body.empty) {
        const db = createDatabaseState(body.type);
        await query('insert into page_content (page_id, state, text_content) values ($1, $2, $3)', [page.id, db.state, db.text], c);
      }
      return page;
    });
    if (parentId && parentType === 'document' && body.insertIntoParent) {
      await appendSubpageBlock(parentId, page.id).catch((err) => req.log.error(err, 'failed to add sub-page block'));
    }
    // A new database's sample cards (with dates and statuses) show on the calendar and task list straight away.
    if (body.type !== 'document' && !body.empty) {
      const stored = await one<{ state: Buffer }>('select state from page_content where page_id = $1', [page.id]);
      if (stored) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(stored.state));
        await updateDocIndex(page.id, null, doc, { log: false }).catch((err) => req.log.error(err, 'failed to index the new database'));
        doc.destroy();
      }
    }
    emit(id, 'page.created', { id: page.id, title: page.title, type: page.type, parentId: page.parentId ?? null }, { id: req.user.id, name: req.user.name });
    return reply.code(201).send({ page });
  });

  app.get('/pages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { access } = await requirePage(req.user.id, id);
    const page = await one(
      `select ${PAGE_COLUMNS}, p.deleted_at as "deletedAt",
              (f.page_id is not null) as "isFavorite",
              cu.name as "createdByName", uu.name as "updatedByName", vu.name as "verifiedByName"
         from pages p
         left join users vu on vu.id = p.verified_by
         left join favorites f on f.page_id = p.id and f.user_id = $2
         left join users cu on cu.id = p.created_by
         left join users uu on uu.id = p.updated_by
        where p.id = $1`,
      [id, req.user.id],
    );
    return { page: { ...page, access } };
  });

  app.patch('/pages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const current = await requirePage(req.user.id, id, 'edit');
    const body = parse(
      z.object({
        title: title.optional(),
        icon: icon.optional(),
        cover: cover.optional(),
        parentId: z.uuid().nullable().optional(),
        position: z.number().finite().optional(),
        locked: z.boolean().optional(),
        archived: z.boolean().optional(),
        /** Verified for this many days (0 = no end), or null to remove the verification. */
        verifiedDays: z.number().int().min(0).max(3650).nullable().optional(),
        layout: z.object({ fullWidth: z.boolean().optional(), smallText: z.boolean().optional() }).optional(),
        teamspaceId: z.uuid().nullable().optional(),
      }),
      req.body,
    );
    // Moving a page under another one or into a teamspace changes who can see it: that's for the
    // people who manage its sharing, not every editor.
    const moving = (body.parentId !== undefined && body.parentId !== current.parent_id) || body.teamspaceId !== undefined;
    if (moving && current.access !== 'manage') throw new HttpError(403, 'Only the page owner or a workspace owner can move it somewhere that changes who can see it');
    if (body.teamspaceId) {
      const ts = await one<{ workspace_id: string }>('select workspace_id from teamspaces where id = $1', [body.teamspaceId]);
      if (!ts || ts.workspace_id !== current.workspace_id) throw new HttpError(400, 'Unknown teamspace');
    }

    if (body.parentId !== undefined && body.parentId !== null) {
      const parent = await requirePage(req.user.id, body.parentId, 'edit');
      if (parent.workspace_id !== current.workspace_id || parent.deleted_at) throw new HttpError(400, 'Invalid parent page');
      const cycle = await one(
        `with recursive sub as (
           select id from pages where id = $1
           union all select p.id from pages p join sub on p.parent_id = sub.id
         ) select 1 from sub where id = $2`,
        [id, body.parentId],
      );
      if (cycle) throw new HttpError(400, "A page can't be moved inside itself");
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (body.title !== undefined) set('title', body.title);
    if (body.icon !== undefined) set('icon', body.icon);
    if (body.cover !== undefined) set('cover', body.cover);
    if (body.parentId !== undefined) set('parent_id', body.parentId);
    if (body.position !== undefined) set('position', body.position);
    if (body.locked !== undefined) set('locked', body.locked);
    if (body.archived !== undefined) set('archived_at', body.archived ? new Date() : null);
    if (body.layout !== undefined) set('layout', JSON.stringify(body.layout));
    if (body.teamspaceId !== undefined) set('teamspace_id', body.teamspaceId);
    if (body.verifiedDays !== undefined) {
      set('verified_until', body.verifiedDays === null ? null : body.verifiedDays === 0 ? new Date('9999-12-31') : new Date(Date.now() + body.verifiedDays * 86_400_000));
      set('verified_by', body.verifiedDays === null ? null : req.user.id);
    }
    if (sets.length === 0) return { ok: true };
    set('updated_by', req.user.id);

    await query(`update pages set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    notifyPageChanged(id);
    emit(current.workspace_id, 'page.updated', { id, ...body }, { id: req.user.id, name: req.user.name });
    return { ok: true };
  });

  // ----- sharing -----

  app.get('/pages/:id/permissions', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'manage');
    const own = await one<{ default_access: string | null }>('select default_access from pages where id = $1', [id]);
    // What this page would get from its parent if it had no settings of its own.
    let inheritedDefault = 'edit';
    if (page.parent_id) {
      const chain = await query<{ default_access: string | null }>(
        `with recursive up as (
           select id, parent_id, default_access, 0 as depth from pages where id = $1
           union all select p.id, p.parent_id, p.default_access, up.depth + 1 from pages p join up on p.id = up.parent_id
         ) select default_access from up where default_access is not null order by depth limit 1`,
        [page.parent_id],
      );
      inheritedDefault = chain[0]?.default_access ?? 'edit';
    }
    const members = await query(
      `select u.id, u.name, u.email, u.color, m.role, pp.level
         from workspace_members m
         join users u on u.id = m.user_id
         left join page_permissions pp on pp.page_id = $1 and pp.user_id = u.id
        where m.workspace_id = $2
        order by m.role, u.name`,
      [id, page.workspace_id],
    );
    return { defaultAccess: own?.default_access ?? null, inheritedDefault, members };
  });

  app.put('/pages/:id/permissions', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'manage');
    const body = parse(
      z.object({
        defaultAccess: level.nullable(),
        members: z.array(z.object({ userId: z.uuid(), level: level.nullable() })).max(1000),
      }),
      req.body,
    );
    await tx(async (c) => {
      await query('update pages set default_access = $2 where id = $1', [id, body.defaultAccess], c);
      for (const m of body.members) {
        const member = await one('select 1 from workspace_members where workspace_id = $1 and user_id = $2', [page.workspace_id, m.userId], c);
        if (!member) continue;
        const before = await one<{ level: string }>('select level from page_permissions where page_id = $1 and user_id = $2', [id, m.userId], c);
        if (m.level === null) await query('delete from page_permissions where page_id = $1 and user_id = $2', [id, m.userId], c);
        else {
          // Tell people when they're given access (or more of it).
          const rank = { view: 1, edit: 2, manage: 3 } as Record<string, number>;
          if (m.userId !== req.user.id && rank[m.level] > (before ? rank[before.level] : 0)) {
            const what = m.level === 'view' ? 'view' : m.level === 'edit' ? 'edit' : 'manage';
            await notify(m.userId, { kind: 'page-shared', title: `${req.user.name} shared “${page.title || 'Untitled'}” with you`, body: `You can ${what} it.`, link: `/w/${page.workspace_id}/p/${id}` }, c);
          }
          await query(
            `insert into page_permissions (page_id, user_id, level) values ($1, $2, $3)
             on conflict (page_id, user_id) do update set level = excluded.level`,
            [id, m.userId, m.level],
            c,
          );
        }
      }
    });
    // Reconnect open editors so new read-only / no-access rules apply straight away.
    const subtree = await query<{ id: string }>(
      `with recursive sub as (select id from pages where id = $1 union all select p.id from pages p join sub on p.parent_id = sub.id) select id from sub`,
      [id],
    );
    subtree.forEach((p) => closePage(p.id));
    return { ok: true };
  });

  // ----- content -----

  /** Merge a Yjs update (e.g. imported content) into a page; open editors receive it live. */
  app.put('/pages/:id/content', { bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'edit');
    if (page.deleted_at) throw new HttpError(400, 'This page is in the trash');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Expected a Yjs update');
    await requireUnlocked(id);
    await applyUpdate(id, new Uint8Array(req.body));
    return { ok: true };
  });

  /**
   * Adds blocks to the end of a document, keeping what's there (e.g. text the AI assistant wrote). The
   * body is a Yjs update of a separate document whose blocks are copied in.
   */
  app.post('/pages/:id/append', { bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'edit');
    if (page.deleted_at) throw new HttpError(400, 'This page is in the trash');
    if (page.type !== 'document') throw new HttpError(400, 'Text can only be added to documents');
    await requireUnlocked(id);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Expected a Yjs update');
    const source = new Y.Doc();
    Y.applyUpdate(source, new Uint8Array(req.body));
    const from = source.getXmlFragment('document-store').get(0);
    const blocks = from instanceof Y.XmlElement && from.nodeName === 'blockGroup' ? from.toArray().filter((b) => b instanceof Y.XmlElement) : [];
    if (!blocks.length) return { ok: true, added: 0 };
    await editDoc(
      id,
      null,
      (doc) => {
        const fragment = doc.getXmlFragment('document-store');
        let group = fragment.get(0);
        if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') {
          group = new Y.XmlElement('blockGroup');
          fragment.insert(0, [group]);
        }
        (group as Y.XmlElement).push(blocks.map((b) => (b as Y.XmlElement).clone()));
      },
      { editor: req.user.id },
    );
    source.destroy();
    await query('update pages set updated_at = now(), updated_by = $2 where id = $1', [id, req.user.id]);
    return { ok: true, added: blocks.length };
  });

  /** Same as above for the document attached to a database row (a card's page). */
  app.put('/pages/:id/rows/:rowId/content', { bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const { id, rowId } = parse(z.object({ id: z.uuid(), rowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }), req.params);
    const page = await requirePage(req.user.id, id, 'edit');
    await requireUnlocked(id);
    if (page.deleted_at) throw new HttpError(400, 'This page is in the trash');
    if (page.type === 'document') throw new HttpError(400, 'Only database pages have rows');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Expected a Yjs update');
    await applyUpdate(`${id}:${rowId}`, new Uint8Array(req.body));
    return { ok: true };
  });

  /** Gives a new card the body of another (a card template), before anyone opens it. */
  app.post('/pages/:id/rows/:rowId/copy', async (req) => {
    const rowParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
    const { id, rowId } = parse(z.object({ id: z.uuid(), rowId: rowParam }), req.params);
    const { from } = parse(z.object({ from: rowParam }), req.body);
    const page = await requirePage(req.user.id, id, 'edit');
    if (page.type === 'document') throw new HttpError(400, 'Only database pages have rows');
    const source = await one<{ state: Buffer }>('select state from row_documents where page_id = $1 and row_id = $2', [id, from]);
    const target = await one<{ text_content: string }>('select text_content from row_documents where page_id = $1 and row_id = $2', [id, rowId]);
    if (source && !target) await applyUpdate(`${id}:${rowId}`, new Uint8Array(source.state));
    return { ok: true };
  });

  /** The start of each row's document, for the Feed view. */
  app.get('/pages/:id/rows/previews', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id);
    const rows = await query<{ row_id: string; text: string }>(
      `select row_id, left(text_content, 600) as text from row_documents where page_id = $1 and text_content <> ''`,
      [id],
    );
    return { previews: Object.fromEntries(rows.map((r) => [r.row_id, r.text])) };
  });

  app.post('/pages/:id/duplicate', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const source = await requirePage(req.user.id, id, 'edit');
    await requirePageCreator(req.user.id, source.workspace_id);
    const page = await tx(async (c) => {
      const copy = (await one(
        `insert into pages (workspace_id, parent_id, type, title, icon, cover, position, created_by, updated_by)
         select workspace_id, parent_id, type, case when title = '' then '' else title || ' (copy)' end, icon, cover,
                position + 0.5, $2, $2
           from pages where id = $1
         returning id`,
        [id, req.user.id],
        c,
      ))!;
      await query(
        `insert into page_content (page_id, state, text_content)
         select $2, state, text_content from page_content where page_id = $1`,
        [id, copy.id],
        c,
      );
      await query(
        `insert into row_documents (page_id, row_id, state, text_content)
         select $2, row_id, state, text_content from row_documents where page_id = $1`,
        [id, copy.id],
        c,
      );
      return copy;
    });
    return reply.code(201).send({ page: { id: page.id, workspaceId: source.workspace_id } });
  });

  /** Events and tasks that are only in this page, its sub-pages and their cards (nowhere else). */
  app.get('/pages/:id/own-events', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id, 'edit');
    const row = await one<{ n: number }>(`select count(*)::int as n from (${OWN_EVENTS}) x`, [id]);
    return { count: row?.n ?? 0 };
  });

  // What lives only in this page (and the pages and cards inside it), so it can be deleted with it.
  app.get('/pages/:id/own-content', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id, 'edit');
    const row = await one<{ n: number }>(`select count(*)::int as n from (${OWN_EVENTS}) x`, [id]);
    return { events: row?.n ?? 0, files: (await filesOnlyIn(id)).length };
  });

  app.post('/pages/:id/trash', async (req) => {
    const { id } = parse(idParams, req.params);
    const { deleteEvents, deleteFiles } = parse(z.object({ deleteEvents: z.boolean().default(false), deleteFiles: z.boolean().default(false) }), req.body ?? {});
    const trashed = await requirePage(req.user.id, id, 'edit');
    // Optionally delete the events, tasks and files that live only here (restoring the page won't bring them back).
    if (deleteEvents) await query(`delete from events where id in (${OWN_EVENTS})`, [id]);
    if (deleteFiles) {
      const access = await accessMap(req.user.id, trashed.workspace_id);
      for (const f of await filesOnlyIn(id)) await deleteFile(access, f.id);
    }
    await query(
      `with recursive sub as (
         select id from pages where id = $1
         union all select p.id from pages p join sub on p.parent_id = sub.id
       ) update pages set deleted_at = now() where id in (select id from sub) and deleted_at is null`,
      [id],
    );
    emit(trashed.workspace_id, 'page.trashed', { id, title: trashed.title }, { id: req.user.id, name: req.user.name });
    closePage(id);
    return { ok: true };
  });

  app.post('/pages/:id/restore', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'edit');
    await tx(async (c) => {
      await query(
        `with recursive sub as (
           select id from pages where id = $1
           union all select p.id from pages p join sub on p.parent_id = sub.id
         ) update pages set deleted_at = null where id in (select id from sub)`,
        [id],
        c,
      );
      if (page.parent_id) {
        // If the parent is still in the trash, restore this page to the top level.
        await query(
          `update pages set parent_id = null
            where id = $1 and exists (select 1 from pages where id = $2 and deleted_at is not null)`,
          [id, page.parent_id],
          c,
        );
      }
    });
    return { ok: true };
  });

  app.delete('/pages/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'edit');
    if (!page.deleted_at) throw new HttpError(400, 'Move the page to the trash first');
    closePage(id);
    await query('delete from pages where id = $1', [id]);
    return { ok: true };
  });

  app.get('/workspaces/:id/trash', async (req) => {
    const { id } = parse(idParams, req.params);
    const access = await accessMap(req.user.id, id);
    const pages = await query(
      `select ${PAGE_COLUMNS}, p.deleted_at as "deletedAt"
         from pages p
         left join pages parent on parent.id = p.parent_id
        where p.workspace_id = $1 and p.deleted_at is not null
          and (parent.id is null or parent.deleted_at is null)
        order by p.deleted_at desc`,
      [id],
    );
    return { pages: visible(pages, access) };
  });

  app.delete('/workspaces/:id/trash', async (req) => {
    const { id } = parse(idParams, req.params);
    const access = await accessMap(req.user.id, id);
    const trashed = await query<{ id: string }>('select id from pages where workspace_id = $1 and deleted_at is not null', [id]);
    // Only remove what this user is allowed to edit.
    const ids = trashed.map((p) => p.id).filter((pid) => ['edit', 'manage'].includes(access.get(pid) ?? 'none'));
    if (ids.length) await query('delete from pages where id = any($1::uuid[])', [ids]);
    ids.forEach(closePage);
    return { ok: true };
  });

  app.put('/pages/:id/favorite', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id);
    await query('insert into favorites (user_id, page_id) values ($1, $2) on conflict do nothing', [req.user.id, id]);
    return { ok: true };
  });

  app.delete('/pages/:id/favorite', async (req) => {
    const { id } = parse(idParams, req.params);
    await query('delete from favorites where user_id = $1 and page_id = $2', [req.user.id, id]);
    return { ok: true };
  });

  app.get('/workspaces/:id/recent', async (req) => {
    const { id } = parse(idParams, req.params);
    const access = await accessMap(req.user.id, id);
    const pages = await query(
      `select ${PAGE_COLUMNS}, uu.name as "updatedByName"
         from pages p left join users uu on uu.id = p.updated_by
        where p.workspace_id = $1 and p.deleted_at is null
        order by p.updated_at desc limit 60`,
      [id],
    );
    return { pages: visible(pages, access).slice(0, 12) };
  });

  /**
   * Search: page titles and text, cards, and the text inside files. Filters: what kind of thing
   * (pages, databases, files), when it was last edited, and whether this person made it.
   */
  app.get('/workspaces/:id/search', async (req) => {
    const { id } = parse(idParams, req.params);
    const access = await accessMap(req.user.id, id);
    const f = parse(
      z.object({
        q: z.string().trim().max(200).default(''),
        kind: z.enum(['all', 'pages', 'databases', 'files']).default('all'),
        edited: z.enum(['any', '1', '7', '30', '365']).default('any'),
        mine: z.enum(['0', '1']).default('0'),
      }),
      req.query,
    );
    const q = f.q;
    if (!q) return { results: [] };
    const pattern = `%${escapeLike(q)}%`;
    const since = f.edited === 'any' ? null : new Date(Date.now() - Number(f.edited) * 86_400_000);
    const needle = q.toLowerCase();
    const snippetOf = (text: string | null) => {
      const at = text ? text.toLowerCase().indexOf(needle) : -1;
      if (!text || at < 0) return '';
      const start = Math.max(0, at - 60);
      return (start > 0 ? '…' : '') + text.slice(start, at + needle.length + 100) + (at + needle.length + 100 < text.length ? '…' : '');
    };

    const results: Record<string, unknown>[] = [];
    if (f.kind !== 'files') {
      const rows = await query<{ id: string; title: string; icon: string; type: string; text: string | null; archivedAt: string | null }>(
        `select p.id, p.title, p.icon, p.type, p.archived_at as "archivedAt",
                coalesce(
                  case when c.text_content ilike $2 then c.text_content end,
                  (select r.text_content from row_documents r where r.page_id = p.id and r.text_content ilike $2 limit 1),
                  c.text_content
                ) as text
           from pages p left join page_content c on c.page_id = p.id
          where p.workspace_id = $1 and p.deleted_at is null
            and (p.title ilike $2 or c.text_content ilike $2
                 or exists (select 1 from row_documents r where r.page_id = p.id and r.text_content ilike $2))
            and ($3::text = 'all' or ($3 = 'pages' and p.type = 'document') or ($3 = 'databases' and p.type <> 'document'))
            and ($4::timestamptz is null or p.updated_at >= $4)
            and ($5::uuid is null or p.created_by = $5)
          order by (p.title ilike $2) desc, p.updated_at desc
          limit 100`,
        [id, pattern, f.kind, since, f.mine === '1' ? req.user.id : null],
      );
      for (const { text, access: _a, ...row } of visible(rows, access).slice(0, 30)) results.push({ ...row, snippet: snippetOf(text) });
    }
    const guest = (await requireMember(req.user.id, id, undefined, true)) === 'guest';
    if (!guest && (f.kind === 'all' || f.kind === 'files')) {
      const files = await query<{ id: string; name: string; mimeType: string; text: string | null }>(
        `select f.id, f.filename as name, f.mime_type as "mimeType", f.text_content as text
           from files f
          where f.workspace_id = $1 and (f.filename ilike $2 or f.text_content ilike $2)
            and ($3::timestamptz is null or f.updated_at >= $3)
            and ($4::uuid is null or f.uploaded_by = $4)
          order by (f.filename ilike $2) desc, f.updated_at desc
          limit 20`,
        [id, pattern, since, f.mine === '1' ? req.user.id : null],
      ).catch(() => []);
      // Files on pages hidden from this person don't show up (their text would leak through the snippet).
      const seen = await visibleFiles(req.user.id, id, files.map((f) => f.id));
      for (const file of files.filter((f) => seen.has(f.id))) results.push({ id: file.id, title: file.name, icon: '', type: 'file', mimeType: file.mimeType, snippet: snippetOf(file.text) });
    }
    return { results };
  });
}
