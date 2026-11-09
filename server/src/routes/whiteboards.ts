import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessMap, requireMember, requireRefAccess } from '../access.js';
import { requireUser } from '../auth.js';
import { boardBlock, readBoardDoc } from '../blocks.js';
import { closeBoardDoc } from '../collab.js';
import { one, query } from '../db.js';
import { locationsFor } from '../locations.js';
import { placeBlock, placeBody, removeEverywhere } from '../placement.js';
import { HttpError, idParams, parse } from '../util.js';

const COLUMNS = `b.id, b.workspace_id as "workspaceId", b.title, b.element_count as "elementCount", b.created_by as "createdBy",
  b.created_at as "createdAt", b.updated_at as "updatedAt"`;

interface BoardRow {
  id: string;
  workspaceId: string;
  title: string;
  createdBy: string | null;
}

async function boardOr404(id: string) {
  const row = await one<BoardRow>(`select ${COLUMNS} from whiteboards b where b.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Whiteboard not found');
  return row;
}

export async function whiteboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // The Whiteboards home screen: every board in the workspace and where each one is used.
  app.get('/workspaces/:id/whiteboards', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const boards = await query<BoardRow>(`select ${COLUMNS} from whiteboards b where b.workspace_id = $1 order by b.updated_at desc`, [id]);
    const locations = await locationsFor('board_refs', 'board_id', boards.map((b) => b.id), await accessMap(req.user.id, id));
    return { whiteboards: boards.map((b) => ({ ...b, locations: locations.get(b.id) ?? [] })) };
  });

  app.post('/workspaces/:id/whiteboards', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const body = parse(z.object({ title: z.string().trim().max(300).default('Untitled whiteboard'), place: placeBody.shape.target.optional() }), req.body ?? {});
    const row = await one<{ id: string }>('insert into whiteboards (workspace_id, title, created_by) values ($1, $2, $3) returning id', [id, body.title || 'Untitled whiteboard', req.user.id]);
    if (body.place) {
      await placeBlock({
        userId: req.user.id,
        workspaceId: id,
        access: await accessMap(req.user.id, id),
        refs: { table: 'board_refs', column: 'board_id', id: row!.id },
        match: boardBlock(row!.id),
        fresh: { nodeName: 'whiteboard', attrs: { boardId: row!.id } },
        target: body.place,
        keepExisting: true,
      });
    }
    return reply.code(201).send({ whiteboard: await boardOr404(row!.id) });
  });

  app.get('/whiteboards/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const board = await boardOr404(id);
    await requireMember(req.user.id, board.workspaceId);
    const locations = await locationsFor('board_refs', 'board_id', [id], await accessMap(req.user.id, board.workspaceId));
    return { whiteboard: { ...board, locations: locations.get(id) ?? [] } };
  });

  app.patch('/whiteboards/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const board = await boardOr404(id);
    await requireMember(req.user.id, board.workspaceId);
    const { title } = parse(z.object({ title: z.string().trim().min(1).max(300) }), req.body);
    await query('update whiteboards set title = $2, updated_at = now() where id = $1', [id, title]);
    return { whiteboard: await boardOr404(id) };
  });

  app.delete('/whiteboards/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const board = await boardOr404(id);
    const role = await requireMember(req.user.id, board.workspaceId);
    if (role !== 'owner' && board.createdBy !== req.user.id) throw new HttpError(403, 'Only the person who made this whiteboard or a workspace owner can delete it');
    await removeEverywhere(await accessMap(req.user.id, board.workspaceId), { table: 'board_refs', column: 'board_id', id }, boardBlock(id));
    closeBoardDoc(id);
    await query('delete from whiteboards where id = $1', [id]);
    return { ok: true };
  });

  // The board's elements, for thumbnails and for the block preview inside pages.
  app.get('/whiteboards/:id/preview', async (req) => {
    const { id } = parse(idParams, req.params);
    const board = await boardOr404(id);
    await requireRefAccess(req.user.id, board.workspaceId, 'board', id);
    return readBoardDoc(id, (doc) => {
      const elements: unknown[] = [];
      doc.getMap<{ isDeleted?: boolean }>('elements').forEach((el) => {
        if (el && !el.isDeleted) elements.push(el);
      });
      const files: Record<string, unknown> = {};
      doc.getMap('files').forEach((f, key) => (files[key] = f));
      return { elements: elements.slice(0, 3000), files };
    });
  });

  app.post('/whiteboards/:id/place', async (req) => {
    const { id } = parse(idParams, req.params);
    const board = await boardOr404(id);
    await requireMember(req.user.id, board.workspaceId);
    const body = parse(placeBody, req.body);
    const access = await accessMap(req.user.id, board.workspaceId);
    await placeBlock({
      userId: req.user.id,
      workspaceId: board.workspaceId,
      access,
      refs: { table: 'board_refs', column: 'board_id', id },
      match: boardBlock(id),
      fresh: { nodeName: 'whiteboard', attrs: { boardId: id } },
      target: body.target,
      keepExisting: body.keepExisting,
    });
    const locations = await locationsFor('board_refs', 'board_id', [id], access);
    return { locations: locations.get(id) ?? [] };
  });
}
