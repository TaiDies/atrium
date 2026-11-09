import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
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
    const file = await req.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const fileId = randomUUID();
    const target = path.join(config.uploadDir, fileId);
    let size = 0;
    file.file.on('data', (chunk: Buffer) => (size += chunk.length));
    await pipeline(file.file, createWriteStream(target));
    if (file.file.truncated) {
      await unlink(target).catch(() => {});
      throw new HttpError(413, `Files must be smaller than ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`);
    }
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
    emit(id, 'file.uploaded', { id: fileId, url: `/api/files/${fileId}` });
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
      .header('Content-Length', row.size)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(path.join(config.uploadDir, id)));
  });
}
