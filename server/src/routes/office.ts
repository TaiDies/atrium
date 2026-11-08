import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { queueFileText } from '../fileText.js';
import { z } from 'zod';
import { requireFileEditor, requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { canConvertTo, convert, converterAvailable, kindOfName, type OfficeKind } from '../convert.js';
import { one, query } from '../db.js';
import { checkStorage, uploadLimitBytes } from '../limits.js';
import { requirePermission } from '../roles.js';
import { HttpError, idParams, parse } from '../util.js';

// Documents, spreadsheets and presentations: new blank files, conversions between formats, saving
// the editors' work back into the file, and an exact "original layout" preview as PDF.

const KIND = z.enum(['document', 'spreadsheet', 'presentation']);
const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  // Pictures and videos saved by the quick editors.
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
};
const NEW_EXT: Record<OfficeKind, string> = { document: 'docx', spreadsheet: 'xlsx', presentation: 'pptx' };

export const mimeFor = (ext: string) => MIME[ext.toLowerCase()] ?? 'application/octet-stream';

interface FileRow {
  id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
  size: string;
  updated_at: Date;
}

async function fileFor(userId: string, id: string) {
  const file = await one<FileRow>('select id, workspace_id, filename, mime_type, size, updated_at from files where id = $1', [id]);
  if (!file) throw new HttpError(404, 'File not found');
  await requireMember(userId, file.workspace_id);
  return file;
}

const previewDir = path.join(config.uploadDir, '..', 'previews');

/** Someone is loading a file into its (still empty) live editor; others wait for them. */
const claims = new Map<string, { token: string; until: number }>();

export async function officeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);
  await mkdir(previewDir, { recursive: true });

  app.get('/office/status', async () => ({ converter: await converterAvailable() }));

  // A new, empty document, spreadsheet or presentation (filled in by its editor).
  app.post('/workspaces/:id/office', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    // A new file is an upload (it gets filled in by saving), so it needs the same permission.
    await requirePermission(req.user.id, 'upload_files');
    const body = parse(z.object({ kind: KIND, name: z.string().trim().max(200).optional() }), req.body);
    const ext = NEW_EXT[body.kind];
    const fallback = { document: 'Untitled document', spreadsheet: 'Untitled spreadsheet', presentation: 'Untitled presentation' }[body.kind];
    const name = `${(body.name || fallback).replace(/\.[a-z0-9]{2,5}$/i, '')}.${ext}`;
    const fileId = randomUUID();
    await writeFile(path.join(config.uploadDir, fileId), Buffer.alloc(0));
    await query('insert into files (id, workspace_id, uploaded_by, filename, mime_type, size) values ($1, $2, $3, $4, $5, 0)', [fileId, id, req.user.id, name, mimeFor(ext)]);
    return reply.code(201).send({ file: { id: fileId, url: `/api/files/${fileId}`, name, mimeType: mimeFor(ext), size: 0, kind: body.kind } });
  });

  // A stored file in another format, e.g. a .doc as HTML for the editor, or a sheet as .ods to download.
  app.get('/files/:id/convert', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { to, download } = parse(z.object({ to: z.string().regex(/^[a-z]{2,5}$/), download: z.string().optional() }), req.query);
    const file = await fileFor(req.user.id, id);
    const kind = kindOfName(file.filename, file.mime_type);
    if (!kind || !canConvertTo(kind, to)) throw new HttpError(400, `This file can't be converted to .${to}`);
    if (Number(file.size) === 0) throw new HttpError(404, 'This file is empty');
    const out = await convert(await readFile(path.join(config.uploadDir, id)), file.filename, kind, to);
    const name = `${file.filename.replace(/\.[^.]+$/, '')}.${to}`;
    // The editors fetch this; opened directly, a converted document (HTML especially, which is made from the
    // uploaded file) must not run as a page of this site: HTML always downloads, and nothing runs scripts.
    const inline = !download && to !== 'html' && to !== 'htm';
    return reply
      .header('Content-Type', mimeFor(to))
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .send(out);
  });

  // Converting what an editor produced (e.g. its HTML) to a file format, for "Download as…" and saving.
  app.post('/workspaces/:id/convert', { bodyLimit: 200 * 1024 * 1024 }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const { kind, from, to, name } = parse(z.object({ kind: KIND, from: z.string().regex(/^[a-z]{2,5}$/), to: z.string().regex(/^[a-z]{2,5}$/), name: z.string().max(200).default('file') }), req.query);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Send the file as application/octet-stream');
    // LibreOffice names things (e.g. a CSV's sheet) after the file, so keep the real name.
    const safe = name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 80) || 'file';
    const out = await convert(req.body, `${safe}.${from}`, kind, to);
    return reply
      .header('Content-Type', mimeFor(to))
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${name.replace(/\.[^.]+$/, '')}.${to}`)}`)
      .send(out);
  });

  // Saving the editor's work into the file itself (optionally renaming it, e.g. .doc → .docx).
  app.put('/files/:id/content', { bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(255).optional() }), req.query);
    const file = await fileFor(req.user.id, id);
    await requireFileEditor(req.user.id, id);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Send the file as application/octet-stream');
    // Saving is uploading: the same permission and size limit apply.
    await requirePermission(req.user.id, 'upload_files');
    const max = await uploadLimitBytes(req.user.id);
    if (req.body.length > max) throw new HttpError(413, `Files must be smaller than ${Math.round(max / 1024 / 1024)} MB`);
    const filename = name ?? file.filename;
    // A bigger file counts against the storage of whoever uploaded it.
    const stored = await one<{ uploaded_by: string | null; size: string }>('select uploaded_by, size from files where id = $1', [id]);
    if (stored?.uploaded_by) await checkStorage(stored.uploaded_by, req.body.length, Number(stored.size));
    await writeFile(path.join(config.uploadDir, id), req.body);
    await query('update files set filename = $2, mime_type = $3, size = $4, updated_at = now() where id = $1', [id, filename, mimeFor(path.extname(filename).slice(1)), req.body.length]);
    for (const f of await readdir(previewDir)) if (f.startsWith(id)) await unlink(path.join(previewDir, f)).catch(() => {});
    queueFileText(id);
    return { ok: true, name: filename, size: req.body.length };
  });

  // The file exactly as it looks in its own app, as a PDF (made once per version, then kept).
  app.get('/files/:id/preview.pdf', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const file = await fileFor(req.user.id, id);
    const kind = kindOfName(file.filename, file.mime_type);
    if (!kind) throw new HttpError(400, "This file can't be previewed");
    if (Number(file.size) === 0) throw new HttpError(404, 'This file is empty');
    const cached = path.join(previewDir, `${id}-${file.updated_at.getTime()}.pdf`);
    let pdf: Buffer;
    if (existsSync(cached)) pdf = await readFile(cached);
    else {
      pdf = await convert(await readFile(path.join(config.uploadDir, id)), file.filename, kind, 'pdf');
      for (const f of await readdir(previewDir)) if (f.startsWith(id)) await unlink(path.join(previewDir, f)).catch(() => {});
      await writeFile(cached, pdf);
    }
    return reply.header('Content-Type', 'application/pdf').header('Cache-Control', 'private, max-age=0, must-revalidate').send(pdf);
  });

  /**
   * The first person to open a file in its editor loads it in; everyone else waits until it's there.
   * A claim lapses after a minute in case that person closes the tab mid-way.
   */
  app.post('/files/:id/claim', async (req) => {
    const { id } = parse(idParams, req.params);
    await fileFor(req.user.id, id);
    // One token per open editor (tab), so two tabs of the same person don't both load the file.
    const { token } = parse(z.object({ token: z.string().min(8).max(100) }), req.body);
    const now = Date.now();
    const current = claims.get(id);
    if (current && current.until > now && current.token !== token) return { granted: false };
    claims.set(id, { token, until: now + 60_000 });
    return { granted: true };
  });
}
