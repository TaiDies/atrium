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
    const file = await req.file({ limits: { fileSize: config.maxImportBytes } });
    if (!file) throw new HttpError(400, 'No file uploaded');
    const bytes = await file.toBuffer().catch(() => {
      throw new HttpError(413, `Exports must be smaller than ${Math.round(config.maxImportBytes / 1024 / 1024)} MB`);
    });
    // The attachments inside count against the importer's storage (the .zip's size is a close estimate).
    await checkStorage(req.user.id, bytes.length);
    const result = await importExport(req.user.id, id, new Uint8Array(bytes), parentId ?? null);
    return reply.code(201).send(result);
  });
}
