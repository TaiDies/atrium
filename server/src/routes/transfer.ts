import { randomUUID } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireMember, requireOwner, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { checkStorage } from '../limits.js';
import { ExportAborted, importExport, type PreparedExport, prepareExport } from '../transfer.js';
import { HttpError, idParams, parse } from '../util.js';
import { receiveFile } from '../uploads.js';

/**
 * Streams an export's .zip as it's written, so attachments never all sit in memory. The headers go out
 * first; a failure after that can't change the status any more, so it's logged and the connection is cut
 * (the browser shows the download as failed rather than saving a broken .zip). Without a Content-Length,
 * the reply is sent in chunks.
 */
function streamZip(req: FastifyRequest, reply: FastifyReply, prepared: PreparedExport) {
  const body = new PassThrough({ highWaterMark: 1024 * 1024 });
  prepared.write(body).then(
    () => body.end(),
    (err: unknown) => {
      if (err instanceof ExportAborted || body.destroyed) req.log.info({ name: prepared.name }, 'Export download closed before it finished');
      else req.log.error({ err, name: prepared.name }, 'Export failed partway; the download was cut off');
      body.destroy(err instanceof Error ? err : new Error(String(err)));
    },
  );
  return reply
    .header('Content-Type', 'application/zip')
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(prepared.name)}`)
    .send(body);
}

/** People with an import running. */
const importing = new Set<string>();

export async function transferRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // One page, or a page and everything under it (?subpages=1).
  app.get('/pages/:id/export', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { subpages } = parse(z.object({ subpages: z.enum(['0', '1']).default('0') }), req.query);
    const page = await requirePage(req.user.id, id, 'view');
    if (page.deleted_at) throw new HttpError(404, 'Page not found');
    return streamZip(req, reply, await prepareExport(req.user.id, page.workspace_id, [id], subpages === '1'));
  });

  // The whole workspace: every page, file, event and whiteboard.
  app.get('/workspaces/:id/export', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireOwner(req.user.id, id);
    return streamZip(req, reply, await prepareExport(req.user.id, id, null, true));
  });

  // An export .zip from this app, added as new pages (under ?parentId= or at the top).
  app.post('/workspaces/:id/import-export', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    if ((await requireMember(req.user.id, id)) !== 'owner') throw new HttpError(403, 'Only workspace owners can add pages');
    const { parentId } = parse(z.object({ parentId: z.uuid().optional() }), req.query);
    if (parentId) {
      const parent = await requirePage(req.user.id, parentId, 'edit');
      if (parent.workspace_id !== id) throw new HttpError(400, 'That page is in another workspace');
    }
    // One import at a time per person, and only a few on the whole server: each one unpacks to disk and
    // adds a lot at once.
    if (importing.has(req.user.id)) throw new HttpError(429, 'An import is already running — try again when it has finished');
    if (importing.size >= config.importParallel) throw new HttpError(429, 'The server is busy with other imports — try again in a few minutes');
    importing.add(req.user.id);
    const upload = path.join(os.tmpdir(), `atrium-upload-${randomUUID()}.zip`);
    let result;
    try {
      // The multipart field "file" (written to disk as it arrives, never held in memory), or a file sent
      // in pieces first (?upload=, see uploads.ts).
      await receiveFile(req, upload, config.maxImportBytes);
      // The attachments inside count against the importer's storage (the .zip's size is a close estimate).
      await checkStorage(req.user.id, (await stat(upload)).size);
      result = await importExport(req.user.id, id, upload, parentId ?? null);
    } finally {
      importing.delete(req.user.id);
      await unlink(upload).catch(() => {});
    }
    return reply.code(201).send(result);
  });
}
