import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { queueFileText } from '../fileText.js';
import { accessMap, requireMember, requireRefAccess } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { checkStorage, uploadLimitBytes } from '../limits.js';
import { emit } from '../webhooks.js';
import { HttpError, idParams, parse } from '../util.js';
import { requirePermission } from '../roles.js';
import { positionSchema, positionsFor, savePosition } from '../filePositions.js';
import { receiveFile } from '../uploads.js';
import { flatPath, flatStatus, isPdf, queueFlat } from '../pdfFlat.js';

// Types that are safe to render inline; everything else (HTML, SVG, ...) is forced to download.
export const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'application/pdf',
]);

export async function fileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.post('/workspaces/:id/files', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id, undefined, true);
    const fileId = randomUUID();
    const target = path.join(config.uploadDir, fileId);
    // The multipart field "file", or a file sent in pieces first (?upload=, see uploads.ts).
    const file = await receiveFile(req, target, config.maxUploadBytes);
    const size = file.size;
    // This person's own limits: the largest file, and their total storage.
    try {
      await requirePermission(req.user.id, 'upload_files');
      const max = await uploadLimitBytes(req.user.id);
      if (size > max) throw new HttpError(413, `Files must be smaller than ${Math.round(max / 1024 / 1024)} MB`);
      await checkStorage(req.user.id, size);
    } catch (err) {
      await unlink(target).catch(() => {});
      throw err;
    }

    await query(
      `insert into files (id, workspace_id, uploaded_by, filename, mime_type, size) values ($1, $2, $3, $4, $5, $6)`,
      [fileId, id, req.user.id, file.filename.slice(0, 255) || 'file', file.mimetype || 'application/octet-stream', size],
    );
    queueFileText(fileId);
    emit(id, 'file.uploaded', { id: fileId, url: `/api/files/${fileId}` }, { id: req.user.id, name: req.user.name });
    return reply.code(201).send({ id: fileId, url: `/api/files/${fileId}` });
  });

  // Name and type for the in-app file viewer (/file/:id).
  app.get('/files/:id/info', async (req) => {
    const { id } = parse(idParams, req.params);
    const row = await one<{ workspace_id: string; filename: string; mime_type: string; size: string; is_note: boolean }>(
      'select workspace_id, filename, mime_type, size, is_note from files where id = $1',
      [id],
    );
    if (!row) throw new HttpError(404, 'File not found');
    if ((await requireMember(req.user.id, row.workspace_id, undefined, true)) === 'guest') {
      const access = await accessMap(req.user.id, row.workspace_id);
      const refs = await query<{ page_id: string }>('select page_id from file_refs where file_id = $1', [id]);
      if (!refs.some((r) => (access.get(r.page_id) ?? 'none') !== 'none')) throw new HttpError(404, 'File not found');
    }
    const position = (await positionsFor(req.user.id, [id])).get(id) ?? null;
    return { id, workspaceId: row.workspace_id, name: row.filename, mimeType: row.mime_type, size: Number(row.size), isNote: row.is_note, url: `/api/files/${id}`, position };
  });

  // Where this person stopped in some files (for attachments in a page), and saving it as they read.
  app.get('/file-positions', async (req) => {
    const { ids } = parse(z.object({ ids: z.string().max(4000) }), req.query);
    const list = ids.split(',').filter((x) => z.uuid().safeParse(x).success).slice(0, 200);
    return { positions: Object.fromEntries(await positionsFor(req.user.id, list)) };
  });

  app.put('/files/:id/position', async (req) => {
    const { id } = parse(idParams, req.params);
    const { position } = parse(z.object({ position: positionSchema }), req.body);
    const row = await one<{ workspace_id: string }>('select workspace_id from files where id = $1', [id]);
    if (!row) throw new HttpError(404, 'File not found');
    await requireMember(req.user.id, row.workspace_id, undefined, true);
    await savePosition(req.user.id, id, position);
    return { ok: true };
  });

  // The PDF's picture copy ("without text", pdfFlat.ts): the PDF itself when it's ready, otherwise its
  // status ({ status: 'pending' | 'notext' | 'failed' }); asking for one that isn't made yet starts it.
  app.get('/files/:id/flat', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const row = await one<{ workspace_id: string; filename: string; mime_type: string }>('select workspace_id, filename, mime_type from files where id = $1', [id]);
    if (!row) throw new HttpError(404, 'File not found');
    await requireRefAccess(req.user.id, row.workspace_id, 'file', id);
    if (!isPdf(row)) throw new HttpError(400, 'Not a PDF');
    let status = await flatStatus(id);
    if (status === 'none') {
      queueFlat(id, true);
      status = 'pending';
    }
    // ?status=1 only asks whether it's ready, without sending the PDF.
    if (status !== 'ready' || (req.query as Record<string, string> | undefined)?.status === '1') return reply.header('Cache-Control', 'no-store').send({ status });
    const file = flatPath(id);
    const info = await stat(file);
    const etag = `"flat-${info.size}-${Math.round(info.mtimeMs)}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.filename.replace(/\.pdf$/i, '') + ' (without text).pdf')}`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(sendRange(req, reply, file, info.size, etag));
  });

  app.get('/files/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const row = await one<{ workspace_id: string; filename: string; mime_type: string; size: string; updated_at: Date }>(
      'select workspace_id, filename, mime_type, size, updated_at from files where id = $1',
      [id],
    );
    if (!row) throw new HttpError(404, 'File not found');
    await requireRefAccess(req.user.id, row.workspace_id, 'file', id);

    // Files can be saved over by the editors, so browsers check for a newer version each time.
    const etag = `"${row.size}-${row.updated_at.getTime()}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();

    // ?download=1 asks for a download even for files the browser could show (e.g. PDFs on phones).
    const wantsDownload = (req.query as Record<string, string> | undefined)?.download === '1';
    const inline = INLINE_TYPES.has(row.mime_type) && !wantsDownload;
    reply
      .header('Content-Type', INLINE_TYPES.has(row.mime_type) ? row.mime_type : 'application/octet-stream')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(sendRange(req, reply, path.join(config.uploadDir, id), Number(row.size), etag));
  });
}

/**
 * The file, or the part of it a Range header asks for ("bytes=0-65535"). The PDF viewer asks for parts,
 * so a big book shows its first pages without waiting for the whole file to arrive. Sets the length,
 * status and range headers; anything it can't serve as a part is sent whole.
 */
function sendRange(req: FastifyRequest, reply: FastifyReply, file: string, size: number, etag: string) {
  reply.header('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  const m = typeof range === 'string' && (!ifRange || ifRange === etag) ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2]) && size > 0) {
    let start: number;
    let end: number;
    if (!m[1]) {
      // "bytes=-500": the last 500 bytes.
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (start > end || start >= size) {
      reply.code(416).header('Content-Range', `bytes */${size}`);
      return '';
    }
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', String(end - start + 1));
    return createReadStream(file, { start, end });
  }
  reply.header('Content-Length', String(size));
  return createReadStream(file);
}
