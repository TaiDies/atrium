import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import { type Access, accessMap, atLeast, requireMember, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import {
  blankPdf,
  type BlockTemplate,
  databaseRows,
  editDoc,
  fileBlock,
  insertBlock,
  outlineOf,
  readDoc,
  readFileDoc,
  removeBlocks,
  updateBlocks,
} from '../blocks.js';
import { closeFileDoc, DATABASE_TYPES } from '../collab.js';
import { type Location, locationsFor as locationsIn } from '../locations.js';
import { placeBlock, placeBody, removeEverywhere } from '../placement.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { HttpError, idParams, parse } from '../util.js';

/** Deletes a file: its blocks everywhere, its notes layer, and the stored file. */
export async function deleteFile(access: Map<string, Access>, id: string) {
  await removeEverywhere(access, { table: 'file_refs', column: 'file_id', id }, fileBlock(id));
  closeFileDoc(id);
  await query('delete from files where id = $1', [id]);
  await unlink(path.join(config.uploadDir, id)).catch(() => {});
}

/** Files of a workspace nothing uses (only `uploadedBy`'s, if given). New uploads (under 10 minutes) are left alone. */
async function unusedFiles(workspaceId: string, uploadedBy: string | null) {
  const inState = (table: string, join: string) =>
    `not exists (select 1 from ${table} ${join} and position(convert_to(f.id::text, 'UTF8') in x.state) > 0)`;
  return query<{ id: string; name: string; size: string; createdAt: string }>(
    `select f.id, f.filename as name, f.size::text as size, f.created_at as "createdAt" from files f
      where f.workspace_id = $1 and not f.is_note and f.created_at < now() - interval '10 minutes'
        and ($2::uuid is null or f.uploaded_by = $2)
        and not exists (select 1 from file_refs r where r.file_id = f.id)
        and not exists (select 1 from file_annotations a where a.file_id = f.id and coalesce(a.stroke_count, 0) > 0)
        and not exists (select 1 from pages p where p.workspace_id = $1 and (p.cover like '%' || f.id::text || '%' or p.icon like '%' || f.id::text || '%'))
        and not exists (select 1 from chat_messages m join chats c on c.id = m.chat_id where c.workspace_id = $1 and m.body like '%' || f.id::text || '%')
        and not exists (select 1 from workspaces w where w.id = $1 and w.icon like '%' || f.id::text || '%')
        and not exists (select 1 from teamspaces t where t.workspace_id = $1 and t.icon like '%' || f.id::text || '%')
        and not exists (select 1 from templates t where t.workspace_id = $1 and t.icon like '%' || f.id::text || '%')
        and ${inState('page_content x', 'join pages p on p.id = x.page_id where p.workspace_id = $1')}
        and ${inState('row_documents x', 'join pages p on p.id = x.page_id where p.workspace_id = $1')}
        and ${inState('page_versions x', 'join pages p on p.id = x.page_id where p.workspace_id = $1')}
        and ${inState('(select data as state, workspace_id from templates) x', 'where x.workspace_id = $1')}
        and ${inState('whiteboards x', 'where x.workspace_id = $1')}
      order by f.created_at`,
    [workspaceId, uploadedBy],
  );
}

/**
 * Files used only in a page and the pages and cards inside it — in no other page, card, cover, chat
 * message, template or whiteboard — so they can go with it.
 */
export async function filesOnlyIn(pageId: string) {
  const outside = (table: string) =>
    `not exists (select 1 from ${table} x join pages p on p.id = x.page_id
                  where p.workspace_id = f.workspace_id and p.id not in (select id from sub) and position(convert_to(f.id::text, 'UTF8') in x.state) > 0)`;
  return query<{ id: string }>(
    `with recursive sub as (
       select id from pages where id = $1
       union all select p.id from pages p join sub on p.parent_id = sub.id
     )
     select f.id from files f
      where f.workspace_id = (select workspace_id from pages where id = $1) and not f.is_note
        and (exists (select 1 from file_refs r where r.file_id = f.id and r.page_id in (select id from sub))
             or exists (select 1 from pages p where p.id in (select id from sub) and p.cover like '%' || f.id::text || '%'))
        and not exists (select 1 from file_refs r where r.file_id = f.id and r.page_id not in (select id from sub))
        and not exists (select 1 from pages p where p.workspace_id = f.workspace_id and p.id not in (select id from sub)
                          and (p.cover like '%' || f.id::text || '%' or p.icon like '%' || f.id::text || '%'))
        and not exists (select 1 from chat_messages m join chats c on c.id = m.chat_id where c.workspace_id = f.workspace_id and m.body like '%' || f.id::text || '%')
        and not exists (select 1 from workspaces w where w.id = f.workspace_id and w.icon like '%' || f.id::text || '%')
        and not exists (select 1 from teamspaces t where t.workspace_id = f.workspace_id and t.icon like '%' || f.id::text || '%')
        and ${outside('page_content')}
        and ${outside('row_documents')}
        and not exists (select 1 from templates t where t.workspace_id = f.workspace_id and position(convert_to(f.id::text, 'UTF8') in t.data) > 0)
        and not exists (select 1 from whiteboards w where w.workspace_id = f.workspace_id and position(convert_to(f.id::text, 'UTF8') in w.state) > 0)`,
    [pageId],
  );
}

interface FileRow {
  id: string;
  workspace_id: string;
  uploaded_by: string | null;
  filename: string;
  mime_type: string;
  size: string;
  is_note: boolean;
  created_at: Date;
  updated_at: Date;
}

const isDatabase = (type: string) => (DATABASE_TYPES as readonly string[]).includes(type);

async function fileOr404(id: string) {
  const row = await one<FileRow>('select * from files where id = $1', [id]);
  if (!row) throw new HttpError(404, 'File not found');
  return row;
}

const locationsFor = (ids: string[], access: Map<string, Access>) => locationsIn('file_refs', 'file_id', ids, access);

function summary(f: FileRow, locations: Location[], strokes: number) {
  return {
    id: f.id,
    url: `/api/files/${f.id}`,
    name: f.filename,
    mimeType: f.mime_type,
    size: Number(f.size),
    isNote: f.is_note,
    strokes,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    uploadedBy: f.uploaded_by,
    locations,
  };
}

export async function noteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // Every file in the workspace the user may see, with where it's used — the Notes home screen.
  app.get('/workspaces/:id/files', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const access = await accessMap(req.user.id, id);
    const files = await query<FileRow & { strokes: number | null }>(
      `select f.*, a.stroke_count as strokes from files f left join file_annotations a on a.file_id = f.id
        where f.workspace_id = $1 order by f.updated_at desc`,
      [id],
    );
    const anyRefs = new Set((await query<{ file_id: string }>('select distinct file_id from file_refs where file_id = any($1::uuid[])', [files.map((f) => f.id)])).map((r) => r.file_id));
    const locations = await locationsFor(files.map((f) => f.id), access);
    return {
      files: files
        // A file used only on pages hidden from this user stays hidden, unless they uploaded it.
        .filter((f) => !anyRefs.has(f.id) || locations.has(f.id) || f.uploaded_by === req.user.id)
        .map((f) => summary(f, locations.get(f.id) ?? [], f.strokes ?? 0)),
    };
  });

  // A new blank handwritten note (an empty A4 PDF to draw on).
  app.post('/workspaces/:id/notes', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const body = parse(z.object({ name: z.string().trim().max(200).optional() }), req.body ?? {});
    const fileId = randomUUID();
    const pdf = blankPdf(1);
    await writeFile(path.join(config.uploadDir, fileId), pdf);
    const name = `${(body.name || 'Untitled note').replace(/\.pdf$/i, '')}.pdf`;
    const row = await one<FileRow>(
      `insert into files (id, workspace_id, uploaded_by, filename, mime_type, size, is_note) values ($1, $2, $3, $4, 'application/pdf', $5, true) returning *`,
      [fileId, id, req.user.id, name, pdf.length],
    );
    return reply.code(201).send({ file: summary(row!, [], 0) });
  });

  app.patch('/files/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const file = await fileOr404(id);
    await requireMember(req.user.id, file.workspace_id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(255) }), req.body);
    await query('update files set filename = $2, updated_at = now() where id = $1', [id, body.name]);
    // Keep the name shown on attachment blocks in step.
    const access = await accessMap(req.user.id, file.workspace_id);
    const refs = await query<{ page_id: string; row_id: string }>('select page_id, row_id from file_refs where file_id = $1', [id]);
    for (const r of refs) {
      if (atLeast(access.get(r.page_id) ?? 'none', 'edit')) await editDoc(r.page_id, r.row_id || null, (doc) => updateBlocks(doc, fileBlock(id), { name: body.name }));
    }
    return { ok: true };
  });

  app.delete('/files/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const file = await fileOr404(id);
    const role = await requireMember(req.user.id, file.workspace_id);
    if (role !== 'owner' && file.uploaded_by !== req.user.id) throw new HttpError(403, 'Only the person who added this file or a workspace owner can delete it');
    await deleteFile(await accessMap(req.user.id, file.workspace_id), id);
    return { ok: true };
  });

  // Files nothing uses any more (no page, card, cover, chat message, whiteboard, template or page
  // history mentions them). Handwritten notes are kept. Members see only what they added themselves.
  app.get('/workspaces/:id/files/unused', async (req) => {
    const { id } = parse(idParams, req.params);
    const role = await requireMember(req.user.id, id);
    const files = await unusedFiles(id, role === 'owner' ? null : req.user.id);
    return { files, size: files.reduce((n, f) => n + Number(f.size), 0) };
  });

  app.post('/workspaces/:id/files/unused/delete', async (req) => {
    const { id } = parse(idParams, req.params);
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).min(1).max(5000) }), req.body);
    const role = await requireMember(req.user.id, id);
    // Checked again now: only files that are still unused go.
    const unused = new Set((await unusedFiles(id, role === 'owner' ? null : req.user.id)).map((f) => f.id));
    const access = await accessMap(req.user.id, id);
    let deleted = 0;
    for (const fileId of ids) {
      if (!unused.has(fileId)) continue;
      await deleteFile(access, fileId);
      deleted += 1;
    }
    return { deleted };
  });

  app.get('/files/:id/locations', async (req) => {
    const { id } = parse(idParams, req.params);
    const file = await fileOr404(id);
    await requireMember(req.user.id, file.workspace_id);
    const locations = await locationsFor([id], await accessMap(req.user.id, file.workspace_id));
    return { locations: locations.get(id) ?? [] };
  });

  /**
   * Moves a file's attachment block: removes it from every page and card it's on and puts it in
   * `target` (a page, or a card of a database page) at the start, end, after a block or nested inside
   * one. A null target just removes it everywhere ("unlink"). Files cells in databases aren't touched.
   */
  app.post('/files/:id/move', async (req) => {
    const { id } = parse(idParams, req.params);
    const file = await fileOr404(id);
    await requireMember(req.user.id, file.workspace_id);
    const body = parse(placeBody, req.body);
    const access = await accessMap(req.user.id, file.workspace_id);

    const kind = file.mime_type.startsWith('image/') ? 'image' : file.mime_type.startsWith('video/') ? 'video' : file.mime_type.startsWith('audio/') ? 'audio' : 'file';
    await placeBlock({
      userId: req.user.id,
      workspaceId: file.workspace_id,
      access,
      refs: { table: 'file_refs', column: 'file_id', id },
      match: fileBlock(id),
      fresh: { nodeName: kind, attrs: { url: `/api/files/${id}`, name: file.filename } },
      target: body.target,
      keepExisting: body.keepExisting,
    });
    const locations = await locationsFor([id], access);
    return { locations: locations.get(id) ?? [] };
  });

  // The blocks of a page (or of one card of a database page), for choosing where a file goes.
  app.get('/pages/:id/outline', async (req) => {
    const { id } = parse(idParams, req.params);
    const { rowId } = parse(z.object({ rowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }), req.query);
    const page = await requirePage(req.user.id, id, 'view');
    if (isDatabase(page.type) && !rowId) return { type: page.type, rows: await readDoc(id, null, databaseRows), blocks: [] };
    return { type: page.type, blocks: await readDoc(id, rowId ?? null, outlineOf) };
  });

  // The strokes on a file's first page, for thumbnails on the Notes screen.
  app.get('/files/:id/preview', async (req) => {
    const { id } = parse(idParams, req.params);
    const file = await fileOr404(id);
    await requireMember(req.user.id, file.workspace_id);
    return readFileDoc(id, (doc) => ({
      strokes: doc
        .getArray('strokes')
        .toArray()
        .filter((s): s is { page: number } => !!s && typeof s === 'object' && (s as { page?: number }).page === 0)
        .slice(0, 400),
      extraPages: Number((doc.getMap('meta') as Y.Map<unknown>).get('extraPages') ?? 0),
    }));
  });
}
