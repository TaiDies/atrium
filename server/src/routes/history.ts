import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as Y from 'yjs';
import { accessMap, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { editDoc } from '../blocks.js';
import { one, query } from '../db.js';
import { historyNotice } from '../historyNotice.js';
import { HttpError, parse } from '../util.js';

// Page history (snapshots taken while editing, to look at and restore) and backlinks.

const VERSION_EVERY_MS = 10 * 60_000;
const KEEP_VERSIONS = 200;

/** Called after a document is saved: keeps a snapshot if the last one is old enough. */
export async function recordVersion(pageId: string, rowId: string | null, state: Uint8Array, editor: string | null) {
  const row = rowId ?? '';
  const last = await one<{ created_at: Date }>('select created_at from page_versions where page_id = $1 and row_id = $2 order by created_at desc limit 1', [pageId, row]);
  if (last && Date.now() - last.created_at.getTime() < VERSION_EVERY_MS) return;
  await query('insert into page_versions (page_id, row_id, state, editor) values ($1, $2, $3, $4)', [pageId, row, Buffer.from(state), editor]);
  await query(
    `delete from page_versions where page_id = $1 and row_id = $2 and id not in (
       select id from page_versions where page_id = $1 and row_id = $2 order by created_at desc limit ${KEEP_VERSIONS})`,
    [pageId, row],
  );
}

/** How long older snapshots are kept (the newest few of each page are always kept). */
const HISTORY_DAYS = Math.max(1, Number(process.env.HISTORY_DAYS ?? 90) || 90);
const ALWAYS_KEEP = 10;

/** Removes snapshots older than HISTORY_DAYS, beyond the newest few of each page and card. */
export async function pruneHistory(): Promise<number> {
  const res = await query<{ id: string }>(
    `delete from page_versions where id in (
       select id from (
         select id, created_at, row_number() over (partition by page_id, row_id order by created_at desc) as n from page_versions
       ) v where v.n > ${ALWAYS_KEEP} and v.created_at < now() - make_interval(days => ${HISTORY_DAYS})
     ) returning id`,
  );
  return res.length;
}

/** Prunes now and then once a day. The first time it removes anything, it says so plainly (once). */
export function startHistoryPruning(log: (msg: string) => void, warn: (msg: string) => void = log) {
  const run = async () => {
    const n = await pruneHistory().catch(() => 0);
    if (!n) return;
    const told = await one(`select 1 from settings where key = 'history_prune_notice'`).catch(() => null);
    if (told) return log(`Removed ${n} old page history snapshots`);
    warn(historyNotice(n, HISTORY_DAYS, ALWAYS_KEEP));
    await query(`insert into settings (key, value) values ('history_prune_notice', 'true'::jsonb) on conflict (key) do nothing`).catch(() => {});
  };
  setTimeout(run, 15_000).unref();
  setInterval(run, 24 * 3600_000).unref();
}

const params = z.object({ id: z.uuid() });
const rowQuery = z.object({ row: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() });

/** What a page shows: its blocks, and (for databases) its properties, cards and views. */
const PARTS = { fragment: 'document-store', arrays: ['fields', 'rows', 'views', 'cardTemplates'], maps: ['dbSettings'] };

function copyInto(target: Y.Doc, source: Y.Doc) {
  const frag = target.getXmlFragment(PARTS.fragment);
  frag.delete(0, frag.length);
  frag.insert(0, source.getXmlFragment(PARTS.fragment).toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone()));
  for (const name of PARTS.arrays) {
    const arr = target.getArray<unknown>(name);
    const from = source.getArray<unknown>(name);
    if (!arr.length && !from.length) continue;
    arr.delete(0, arr.length);
    arr.insert(0, from.toArray().map((v) => (v instanceof Y.Map || v instanceof Y.Array ? v.clone() : v)));
  }
  for (const name of PARTS.maps) {
    const map = target.getMap<unknown>(name);
    const from = source.getMap<unknown>(name);
    for (const k of [...map.keys()]) if (!from.has(k)) map.delete(k);
    for (const [k, v] of from.entries()) map.set(k, v instanceof Y.Map || v instanceof Y.Array ? v.clone() : v);
  }
}

export async function historyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/pages/:id/versions', async (req) => {
    const { id } = parse(params, req.params);
    const { row } = parse(rowQuery, req.query);
    await requirePage(req.user.id, id, 'view');
    const versions = await query(
      `select v.id, v.created_at as "createdAt", u.name as "editorName", octet_length(v.state) as size
         from page_versions v left join users u on u.id = v.editor
        where v.page_id = $1 and v.row_id = $2 order by v.created_at desc limit ${KEEP_VERSIONS}`,
      [id, row ?? ''],
    );
    return { versions };
  });

  /** One snapshot, as a Yjs update (without comment threads), to show read-only. */
  app.get('/pages/:id/versions/:vid', async (req, reply) => {
    const { id, vid } = parse(params.extend({ vid: z.coerce.number().int() }), req.params);
    await requirePage(req.user.id, id, 'view');
    const v = await one<{ state: Buffer }>('select state from page_versions where id = $1 and page_id = $2', [vid, id]);
    if (!v) throw new HttpError(404, 'That version is gone');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(v.state));
    const threads = doc.getMap('threads');
    doc.transact(() => [...threads.keys()].forEach((k) => threads.delete(k)));
    const out = Buffer.from(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    return reply.header('Content-Type', 'application/octet-stream').send(out);
  });

  /** Puts a page (or card) back the way it was in a snapshot. The current state is kept as a version first. */
  app.post('/pages/:id/versions/:vid/restore', async (req) => {
    const { id, vid } = parse(params.extend({ vid: z.coerce.number().int() }), req.params);
    await requirePage(req.user.id, id, 'edit');
    const v = await one<{ state: Buffer; row_id: string }>('select state, row_id from page_versions where id = $1 and page_id = $2', [vid, id]);
    if (!v) throw new HttpError(404, 'That version is gone');
    const source = new Y.Doc();
    Y.applyUpdate(source, new Uint8Array(v.state));
    await editDoc(
      id,
      v.row_id || null,
      (doc) => {
        // Keep what's being replaced, so a restore can be undone.
        query('insert into page_versions (page_id, row_id, state, editor) values ($1, $2, $3, $4)', [id, v.row_id, Buffer.from(Y.encodeStateAsUpdate(doc)), req.user.id]).catch(() => {});
        copyInto(doc, source);
      },
      { editor: req.user.id },
    );
    source.destroy();
    return { ok: true };
  });

  /** Pages that link to this one (mentions, links and sub-page blocks) that this person can see. */
  app.get('/pages/:id/backlinks', async (req) => {
    const { id } = parse(params, req.params);
    const page = await requirePage(req.user.id, id, 'view');
    const rows = await query<{ id: string; title: string; icon: string; type: string; rowId: string }>(
      `select p.id, p.title, p.icon, p.type, l.source_row as "rowId"
         from page_links l join pages p on p.id = l.source_page
        where l.target_page = $1 and p.deleted_at is null and p.id <> $1 and p.parent_id is distinct from $1
        order by p.updated_at desc limit 100`,
      [id],
    );
    const access = await accessMap(req.user.id, page.workspace_id);
    return { backlinks: rows.filter((r) => (access.get(r.id) ?? 'none') !== 'none') };
  });
}
