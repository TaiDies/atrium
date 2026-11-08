import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import * as Y from 'yjs';
import { type Access, accessMap } from './access.js';
import { DATABASE_TYPES, extractText, liveElementCount } from './collab.js';
import { config } from './config.js';
import { one, query, tx } from './db.js';
import { updateDocIndex } from './docIndex.js';
import { databaseToCsv, docToMarkdown } from './readable.js';
import { unzipToDisk } from './unzipDisk.js';
import { HttpError } from './util.js';

// Exporting pages (one, with or without its sub-pages, or a whole workspace) to a .zip that this app
// can import into another account or workspace, with readable Markdown/CSV copies for other apps.

export const EXPORT_FORMAT = 'atrium-export';
const MANIFEST = 'atrium-export.json';

interface ExportPage {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  icon: string;
  cover: string | null;
  position: number;
  state: string | null; // base64 Yjs update
  rows: { rowId: string; state: string }[];
}

interface ExportFile {
  id: string;
  name: string;
  mimeType: string;
  isNote: boolean;
  path: string;
  annotations: string | null;
}

interface ExportEvent {
  id: string;
  title: string;
  description: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  color: string;
  status: string | null;
  repeat: unknown;
  /** Tasks with paths (absent in older exports). */
  paths?: unknown;
  pathState?: unknown;
}

interface ExportBoard {
  id: string;
  title: string;
  state: string | null;
}

interface Manifest {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  source: { workspace: string; scope: 'page' | 'pages' | 'workspace' };
  pages: ExportPage[];
  files: ExportFile[];
  events: ExportEvent[];
  whiteboards: ExportBoard[];
}

const b64 = (buf: Buffer | Uint8Array | null | undefined) => (buf ? Buffer.from(buf).toString('base64') : null);
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function safeName(s: string, fallback: string) {
  const clean = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || fallback;
}

/** Every id (page, file, event, board) a Yjs document's blocks, cells and cover point at. */
function idsIn(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(UUID_G)) out.add(m[0].toLowerCase());
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    if (node instanceof Y.XmlElement) add(node.getAttributes());
    for (const c of node.toArray()) {
      if (c instanceof Y.XmlElement) walk(c);
      else if (c instanceof Y.XmlText) for (const op of c.toDelta() as { attributes?: unknown }[]) add(op.attributes);
    }
  };
  walk(doc.getXmlFragment('document-store'));
  for (const r of [...doc.getArray<Y.Map<unknown>>('rows').toArray(), ...doc.getArray<Y.Map<unknown>>('cardTemplates').toArray()]) if (r instanceof Y.Map) add(r.toJSON());
  doc.getMap('files').forEach((f) => add(f));
  return out;
}

function decode(state: string | Buffer | null | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, typeof state === 'string' ? Buffer.from(state, 'base64') : new Uint8Array(state));
  return doc;
}

/**
 * Builds the export .zip. `rootIds` null means the whole workspace; otherwise those pages (and, with
 * `subpages`, everything under them). Only pages the user can see are included.
 */
export async function buildExport(userId: string, workspaceId: string, rootIds: string[] | null, subpages: boolean): Promise<{ zip: Uint8Array; name: string }> {
  const workspace = await one<{ name: string }>('select name from workspaces where id = $1', [workspaceId]);
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  const access = await accessMap(userId, workspaceId);
  const visible = (id: string) => (access.get(id) ?? 'none') !== ('none' as Access);

  const all = await query<{ id: string; parent_id: string | null; type: string; title: string; icon: string; cover: string | null; position: number }>(
    'select id, parent_id, type, title, icon, cover, position from pages where workspace_id = $1 and deleted_at is null order by position, created_at',
    [workspaceId],
  );
  const children = new Map<string | null, typeof all>();
  for (const p of all) children.set(p.parent_id, [...(children.get(p.parent_id) ?? []), p]);
  const chosen = new Map<string, (typeof all)[number]>();
  const take = (p: (typeof all)[number], deep: boolean) => {
    if (!visible(p.id) || chosen.has(p.id)) return;
    chosen.set(p.id, p);
    if (deep) for (const c of children.get(p.id) ?? []) take(c, true);
  };
  if (rootIds === null) all.forEach((p) => take(p, false));
  else for (const id of rootIds) {
    const p = all.find((x) => x.id === id);
    if (p) take(p, subpages);
  }
  if (!chosen.size) throw new HttpError(404, 'Nothing to export');

  // A page whose parent isn't exported becomes a top-level page of the export.
  const parentIn = (p: (typeof all)[number]) => {
    let parent = p.parent_id;
    while (parent && !chosen.has(parent)) parent = all.find((x) => x.id === parent)?.parent_id ?? null;
    return parent;
  };

  const ids = [...chosen.keys()];
  const states = new Map((await query<{ page_id: string; state: Buffer }>('select page_id, state from page_content where page_id = any($1::uuid[])', [ids])).map((r) => [r.page_id, r.state]));
  const rowStates = await query<{ page_id: string; row_id: string; state: Buffer }>('select page_id, row_id, state from row_documents where page_id = any($1::uuid[])', [ids]);

  const referenced = new Set<string>();
  const pages: ExportPage[] = [];
  for (const p of chosen.values()) {
    const state = states.get(p.id);
    const rows = rowStates.filter((r) => r.page_id === p.id);
    for (const s of [state, ...rows.map((r) => r.state)]) if (s) idsIn(decode(s)).forEach((id) => referenced.add(id));
    if (p.cover) for (const m of p.cover.matchAll(UUID_G)) referenced.add(m[0].toLowerCase());
    pages.push({
      id: p.id,
      parentId: parentIn(p),
      type: p.type,
      title: p.title,
      icon: p.icon,
      cover: p.cover,
      position: p.position,
      state: b64(state),
      rows: rows.map((r) => ({ rowId: r.row_id, state: b64(r.state)! })),
    });
  }

  const whole = rootIds === null;
  const boards = await query<{ id: string; title: string; state: Buffer | null }>(
    `select id, title, state from whiteboards where workspace_id = $1 ${whole ? '' : 'and id = any($2::uuid[])'}`,
    whole ? [workspaceId] : [workspaceId, [...referenced]],
  );
  for (const b of boards) if (b.state) idsIn(decode(b.state)).forEach((id) => referenced.add(id));
  const events = await query<ExportEvent & { start: string }>(
    `select id, title, description, to_char(start_date, 'YYYY-MM-DD') as "startDate", start_time as "startTime", to_char(end_date, 'YYYY-MM-DD') as "endDate",
            end_time as "endTime", color, status, repeat, paths, path_state as "pathState" from events where workspace_id = $1 ${whole ? '' : 'and id = any($2::uuid[])'}`,
    whole ? [workspaceId] : [workspaceId, [...referenced]],
  );
  const files = await query<{ id: string; filename: string; mime_type: string; is_note: boolean; annotations: Buffer | null }>(
    `select f.id, f.filename, f.mime_type, f.is_note, a.state as annotations from files f left join file_annotations a on a.file_id = f.id
      where f.workspace_id = $1 ${whole ? '' : 'and f.id = any($2::uuid[])'}`,
    whole ? [workspaceId] : [workspaceId, [...referenced]],
  );

  const zip: Zippable = {};
  const manifestFiles: ExportFile[] = [];
  for (const f of files) {
    const filePath = `files/${f.id}/${safeName(f.filename, 'file')}`;
    try {
      zip[filePath] = [await readFile(path.join(config.uploadDir, f.id)), { level: 0 }];
    } catch {
      continue; // missing on disk
    }
    manifestFiles.push({ id: f.id, name: f.filename, mimeType: f.mime_type, isNote: f.is_note, path: filePath, annotations: b64(f.annotations) });
  }

  // Readable copies: a folder per page, Markdown for documents and CSV for databases.
  const dirOf = new Map<string, string>();
  const used = new Set<string>();
  const dirFor = (p: ExportPage): string => {
    if (dirOf.has(p.id)) return dirOf.get(p.id)!;
    const parent = p.parentId ? pages.find((x) => x.id === p.parentId) : null;
    const base = `${parent ? dirFor(parent) : 'readable'}/${safeName(p.title, 'Untitled')}`;
    let dir = base;
    for (let i = 2; used.has(dir); i++) dir = `${base} (${i})`;
    used.add(dir);
    dirOf.set(p.id, dir);
    return dir;
  };
  const fileOf = (p: ExportPage) => `${dirFor(p)}/${safeName(p.title, 'Untitled')}.${(DATABASE_TYPES as readonly string[]).includes(p.type) ? 'csv' : 'md'}`;
  const relative = (from: string, to: string) => path.posix.relative(path.posix.dirname(from), to).split('/').map(encodeURIComponent).join('/');
  const fileById = new Map(manifestFiles.map((f) => [f.id, f]));
  const titleOf = new Map(all.map((p) => [p.id, p.title || 'Untitled']));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const boardById = new Map(boards.map((b) => [b.id, b]));
  for (const p of pages) {
    const out = fileOf(p);
    const doc = decode(p.state);
    if ((DATABASE_TYPES as readonly string[]).includes(p.type)) zip[out] = strToU8(databaseToCsv(doc));
    else
      zip[out] = strToU8(
        docToMarkdown(doc, p.title, {
          pageLink: (id) => {
            const target = pages.find((x) => x.id === id);
            return { title: titleOf.get(id) ?? 'a page that was not exported', href: target ? relative(out, fileOf(target)) : null };
          },
          fileLink: (url) => {
            const id = /\/api\/files\/([0-9a-f-]{36})/i.exec(url)?.[1]?.toLowerCase();
            const f = id ? fileById.get(id) : undefined;
            return f ? relative(out, f.path) : null;
          },
          eventLabel: (id) => {
            const e = eventById.get(id);
            return e ? `${e.title || 'Untitled'} — ${e.startDate}${e.startTime ? ` ${e.startTime}` : ''}` : null;
          },
          boardLabel: (id) => boardById.get(id)?.title ?? null,
        }),
      );
  }

  const manifest: Manifest = {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    source: { workspace: workspace.name, scope: whole ? 'workspace' : subpages ? 'pages' : 'page' },
    pages,
    files: manifestFiles,
    events: events.map(({ id, title, description, startDate, startTime, endDate, endTime, color, status, repeat, paths, pathState }) => ({
      id,
      title,
      description,
      startDate,
      startTime,
      endDate,
      endTime,
      color,
      status,
      repeat,
      ...(paths ? { paths, pathState } : {}),
    })),
    whiteboards: boards.map((b) => ({ id: b.id, title: b.title, state: b64(b.state) })),
  };
  zip[MANIFEST] = strToU8(JSON.stringify(manifest));
  zip['README.txt'] = strToU8(
    [
      `Exported from "${workspace.name}" on ${new Date().toUTCString()}.`,
      '',
      'To bring this into another account or workspace of this app: Import (in the sidebar) and choose this .zip.',
      'Everything comes across: pages and sub-pages, databases and cards, attachments, handwriting on PDFs,',
      'calendar events and whiteboards.',
      '',
      'For other apps: "readable" has each page as Markdown (.md) and each database as a spreadsheet (.csv),',
      'and "files" has every attachment in its original format.',
      '',
    ].join('\n'),
  );

  const first = rootIds?.length === 1 ? chosen.get(rootIds[0]) : null;
  const name = safeName(whole ? workspace.name : first ? first.title : 'Pages', 'Export');
  return { zip: zipSync(zip, { level: 6 }), name: `${name}.zip` };
}

/** Rewrites every id in a document that's in `map` (pages, files, events, boards made by the import). */
function remapDoc(doc: Y.Doc, map: Map<string, string>) {
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(UUID_G, (m) => map.get(m.toLowerCase()) ?? m);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  doc.transact(() => {
    const walk = (node: Y.XmlElement | Y.XmlFragment) => {
      if (node instanceof Y.XmlElement) {
        for (const [k, v] of Object.entries(node.getAttributes())) {
          const next = fix(v);
          if (changed(v, next)) node.setAttribute(k, next as string);
        }
      }
      for (const c of node.toArray()) {
        if (c instanceof Y.XmlElement) walk(c);
        else if (c instanceof Y.XmlText) {
          // Links in text (e.g. to a file) are formatting attributes.
          let index = 0;
          for (const op of c.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
            const len = typeof op.insert === 'string' ? op.insert.length : 1;
            if (op.attributes) {
              const next = fix(op.attributes) as Record<string, unknown>;
              if (changed(op.attributes, next)) c.format(index, len, next);
            }
            index += len;
          }
        }
      }
    };
    walk(doc.getXmlFragment('document-store'));
    for (const r of [...doc.getArray<Y.Map<unknown>>('rows').toArray(), ...doc.getArray<Y.Map<unknown>>('cardTemplates').toArray()]) {
      const cells = r instanceof Y.Map ? r.get('cells') : null;
      if (!(cells instanceof Y.Map)) continue;
      for (const [k, v] of cells.entries()) {
        const next = fix(v);
        if (changed(v, next)) cells.set(k, next);
      }
    }
    const files = doc.getMap<unknown>('files');
    for (const [k, v] of files.entries()) {
      const next = fix(v);
      if (changed(v, next)) files.set(k, next);
    }
  });
}

/** The most an export .zip may unpack to (its files and pages together), and how many entries it may hold. */
const MAX_UNPACKED = Math.min(2 * config.maxImportBytes, 1024 ** 3);
const MAX_ENTRIES = 50_000;
/** The list of pages, files and events inside (page contents are in it, so it can be large, but not this large). */
const MAX_MANIFEST = 256 * 1024 * 1024;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const many = <T extends z.ZodType>(item: T) => z.array(item).max(MAX_ENTRIES);
/** What an export's manifest must look like before anything in it is used. */
const manifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().max(64),
  source: z.object({ workspace: z.string().max(500), scope: z.enum(['page', 'pages', 'workspace']) }),
  pages: many(
    z.object({
      id: uuid,
      parentId: uuid.nullable(),
      type: z.enum(['document', ...DATABASE_TYPES] as [string, ...string[]]),
      title: z.string().max(2000),
      icon: z.string().max(2000),
      cover: z.string().max(4000).nullable(),
      position: z.number().finite(),
      state: z.string().nullable(),
      rows: many(z.object({ rowId: z.string().min(1).max(64), state: z.string() })),
    }),
  ),
  files: many(
    z.object({
      id: uuid,
      name: z.string().max(1000),
      mimeType: z.string().max(255),
      isNote: z.boolean(),
      path: z.string().max(1000),
      annotations: z.string().nullable(),
    }),
  ),
  events: many(
    z.object({
      id: uuid,
      title: z.string().max(2000),
      description: z.string().max(200_000),
      startDate: z.string().max(32),
      startTime: z.string().max(32).nullable(),
      endDate: z.string().max(32).nullable(),
      endTime: z.string().max(32).nullable(),
      color: z.string().max(32),
      status: z.string().max(32).nullable(),
      repeat: z.unknown(),
      paths: z.unknown().optional(),
      pathState: z.unknown().optional(),
    }),
  ),
  whiteboards: many(z.object({ id: uuid, title: z.string().max(2000), state: z.string().nullable() })),
});

/**
 * Reads an export .zip (a file on disk) into `workspaceId`, under `parentId` (or at the top). It's unpacked
 * to a temporary folder entry by entry, never all in memory, and the folder is removed afterwards.
 * Returns the new top-level pages.
 */
export async function importExport(userId: string, workspaceId: string, zipPath: string, parentId: string | null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atrium-import-'));
  try {
    return await importFrom(userId, workspaceId, zipPath, dir, parentId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Removes uploads and unpack folders a crash or restart left in the temp folder (run at start-up). */
export async function cleanImportLeftovers(): Promise<number> {
  const dir = os.tmpdir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const left = names.filter((n) => /^atrium-(upload-.+\.zip|import-.+|template-.+)$/.test(n));
  await Promise.all(left.map((n) => rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {})));
  return left.length;
}

/** The same, for a .zip already in memory (templates, which are kept in the database). */
export async function importExportBytes(userId: string, workspaceId: string, zipBytes: Uint8Array, parentId: string | null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atrium-template-'));
  try {
    const zipPath = path.join(dir, 'template.zip');
    await writeFile(zipPath, zipBytes);
    return await importExport(userId, workspaceId, zipPath, parentId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function importFrom(userId: string, workspaceId: string, zipPath: string, dir: string, parentId: string | null) {
  const entries = await unzipToDisk(zipPath, dir, { maxBytes: MAX_UNPACKED, maxEntries: MAX_ENTRIES });
  const raw = entries.get(MANIFEST);
  if (!raw) throw new HttpError(400, 'This .zip wasn’t exported from this app');
  if (raw.size > MAX_MANIFEST) throw new HttpError(413, 'This export is too large to import here');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(raw.file, 'utf8'));
  } catch {
    throw new HttpError(400, 'This export is damaged');
  }
  if ((parsed as { format?: unknown })?.format === EXPORT_FORMAT && (parsed as { version?: unknown }).version !== 1) {
    throw new HttpError(400, 'This export is from a newer version of the app');
  }
  const checked = manifestSchema.safeParse(parsed);
  if (!checked.success) throw new HttpError(400, 'This .zip wasn’t exported from this app, or it is damaged');
  const manifest = checked.data as Manifest;

  const map = new Map<string, string>();
  for (const p of manifest.pages) map.set(p.id.toLowerCase(), randomUUID());
  for (const f of manifest.files) map.set(f.id.toLowerCase(), randomUUID());
  for (const e of manifest.events) map.set(e.id.toLowerCase(), randomUUID());
  for (const b of manifest.whiteboards) map.set(b.id.toLowerCase(), randomUUID());
  const id = (old: string) => map.get(old.toLowerCase())!;
  // Paths point at databases and cards by id: those made by the import get their new ids.
  const remapJson = (v: unknown) =>
    v ? JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => map.get(m.toLowerCase()) ?? m) : null;

  // Attachments go to disk first; if anything later fails, they're removed again.
  const written: string[] = [];
  try {
    for (const f of manifest.files) {
      const entry = entries.get(f.path);
      if (!entry) continue;
      await copyFile(entry.file, path.join(config.uploadDir, id(f.id)));
      written.push(id(f.id));
    }

    const top: string[] = [];
    const docs: { pageId: string; rowId: string | null; doc: Y.Doc }[] = [];
    await tx(async (c) => {
      for (const f of manifest.files) {
        if (!written.includes(id(f.id))) continue;
        await c.query('insert into files (id, workspace_id, uploaded_by, filename, mime_type, size, is_note) values ($1, $2, $3, $4, $5, $6, $7)', [
          id(f.id),
          workspaceId,
          userId,
          f.name.slice(0, 255),
          f.mimeType,
          entries.get(f.path)!.size,
          f.isNote,
        ]);
        if (f.annotations) await c.query('insert into file_annotations (file_id, state) values ($1, $2)', [id(f.id), Buffer.from(f.annotations, 'base64')]);
      }
      for (const e of manifest.events) {
        await c.query(
          `insert into events (id, workspace_id, title, description, start_date, start_time, end_date, end_time, color, status, repeat, created_by, paths, path_state)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            id(e.id),
            workspaceId,
            e.title,
            e.description,
            e.startDate,
            e.startTime,
            e.endDate,
            e.endTime,
            e.color,
            e.status,
            e.repeat ? JSON.stringify(e.repeat) : null,
            userId,
            remapJson(e.paths),
            remapJson(e.pathState),
          ],
        );
      }
      for (const b of manifest.whiteboards) {
        const doc = decode(b.state);
        remapDoc(doc, map);
        await c.query('insert into whiteboards (id, workspace_id, title, state, element_count, created_by) values ($1, $2, $3, $4, $5, $6)', [
          id(b.id),
          workspaceId,
          b.title,
          Buffer.from(Y.encodeStateAsUpdate(doc)),
          liveElementCount(doc),
          userId,
        ]);
      }

      // Parents before children.
      const done = new Set<string>();
      const ordered: ExportPage[] = [];
      const visit = (p: ExportPage) => {
        if (done.has(p.id)) return;
        const parent = p.parentId ? manifest.pages.find((x) => x.id === p.parentId) : null;
        if (parent) visit(parent);
        done.add(p.id);
        ordered.push(p);
      };
      manifest.pages.forEach(visit);
      const base = Number((await c.query('select coalesce(max(position), 0) as max from pages where workspace_id = $1 and parent_id is not distinct from $2', [workspaceId, parentId])).rows[0].max);
      for (const [i, p] of ordered.entries()) {
        const isTop = !p.parentId || !map.has(p.parentId.toLowerCase());
        const cover = p.cover ? p.cover.replace(UUID_G, (m) => map.get(m.toLowerCase()) ?? m) : null;
        await c.query(
          `insert into pages (id, workspace_id, parent_id, type, title, icon, cover, position, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [id(p.id), workspaceId, isTop ? parentId : id(p.parentId!), p.type, p.title, p.icon, cover, isTop ? base + 1 + i : p.position, userId],
        );
        if (isTop) top.push(id(p.id));
        const doc = decode(p.state);
        remapDoc(doc, map);
        await c.query('insert into page_content (page_id, state, text_content) values ($1, $2, $3)', [id(p.id), Buffer.from(Y.encodeStateAsUpdate(doc)), extractText(doc)]);
        docs.push({ pageId: id(p.id), rowId: null, doc });
        for (const r of p.rows) {
          const rowDoc = decode(r.state);
          remapDoc(rowDoc, map);
          await c.query('insert into row_documents (page_id, row_id, state, text_content) values ($1, $2, $3, $4)', [id(p.id), r.rowId, Buffer.from(Y.encodeStateAsUpdate(rowDoc)), extractText(rowDoc)]);
          docs.push({ pageId: id(p.id), rowId: r.rowId, doc: rowDoc });
        }
      }
    });
    for (const d of docs) await updateDocIndex(d.pageId, d.rowId, d.doc, { log: false });
    return { pages: manifest.pages.length, files: written.length, events: manifest.events.length, whiteboards: manifest.whiteboards.length, top };
  } catch (err) {
    for (const f of written) await unlink(path.join(config.uploadDir, f)).catch(() => {});
    throw err;
  }
}
