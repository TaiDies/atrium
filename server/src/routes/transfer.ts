import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireMember, requireOwner, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { checkStorage } from '../limits.js';
import { buildExport, importExport } from '../transfer.js';
import { HttpError, idParams, parse } from '../util.js';

function sendZip(reply: FastifyReply, zip: Uint8Array, name: string) {
  return reply
    .header('Content-Type', 'application/zip')
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    .header('Content-Length', zip.length)
    .send(Buffer.from(zip));
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
    const { zip, name } = await buildExport(req.user.id, page.workspace_id, [id], subpages === '1');
    return sendZip(reply, zip, name);
  });

  // The whole workspace: every page, file, event and whiteboard.
  app.get('/workspaces/:id/export', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireOwner(req.user.id, id);
    const { zip, name } = await buildExport(req.user.id, id, null, true);
    return sendZip(reply, zip, name);
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
      const file = await req.file({ limits: { fileSize: config.maxImportBytes } });
      if (!file) throw new HttpError(400, 'No file uploaded');
      // Written to a temporary file as it arrives, never held in memory.
      await pipeline(file.file, createWriteStream(upload));
      if (file.file.truncated) throw new HttpError(413, `Exports must be smaller than ${Math.round(config.maxImportBytes / 1024 / 1024)} MB`);
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
