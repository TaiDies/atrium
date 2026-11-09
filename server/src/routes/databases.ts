import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import { requirePage, requireUnlocked } from '../access.js';
import { requireUser } from '../auth.js';
import { editDoc, readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { query } from '../db.js';
import { cardTasks } from '../taskStatus.js';
import { fillAiField } from '../aiFill.js';
import { asyncCapable } from '../aiJobs.js';
import { addFieldFlat } from './rows.js';
import { fieldsOf } from '../docIndex.js';
import { HttpError, idParams, parse } from '../util.js';

// Reading one database from another (relations and rollups show the linked cards), and adding a
// property to another database (the "linked from" side of a two-way relation).

const isDatabase = (type: string) => (DATABASE_TYPES as readonly string[]).includes(type);

export async function databaseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** A database's properties and cards (their stored values), for relations and rollups elsewhere. */
  app.get('/pages/:id/database', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'view');
    if (!isDatabase(page.type)) throw new HttpError(400, 'Not a database');
    const data = await readDoc(id, null, (doc) => ({
      fields: fieldsOf(doc),
      rows: doc
        .getArray<Y.Map<unknown>>('rows')
        .toArray()
        .filter((r) => r instanceof Y.Map)
        .map((r) => {
          const cells = r.get('cells');
          return { id: String(r.get('id')), cells: cells instanceof Y.Map ? (cells.toJSON() as Record<string, unknown>) : {} };
        }),
    }));
    return { id, title: page.title || 'Untitled', icon: page.icon, type: page.type, ...data };
  });

  /** Adds a property to a database (used for the other side of a two-way relation). */
  /** The files attached inside each card's page (for "Files & media" properties that include them). */
  /** The tasks inside each card's page, with whether they're done (for "Tasks" properties). */
  app.get('/pages/:id/rows/tasks', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id, 'view');
    return { tasks: await cardTasks(id) };
  });

  /** Has the AI fill an "AI autofill" property (for some cards, or every card that's empty). */
  app.post('/pages/:id/fields/:fieldId/ai-fill', asyncCapable(async (req) => {
    const { id, fieldId } = parse(z.object({ id: z.uuid(), fieldId: z.string().min(1).max(64) }), req.params);
    const body = parse(z.object({ rowIds: z.array(z.string().max(64)).max(500).default([]), overwrite: z.boolean().default(false) }), req.body ?? {});
    await requirePage(req.user.id, id, 'edit');
    return fillAiField(req.user.id, id, fieldId, body.rowIds, body.overwrite);
  }));

  app.get('/pages/:id/rows/files', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id, 'view');
    const rows = await query<{ rowId: string; id: string; name: string; type: string }>(
      `select r.row_id as "rowId", f.id, f.filename as name, f.mime_type as type
         from file_refs r join files f on f.id = r.file_id
        where r.page_id = $1 and r.row_id <> '' and r.row_id not like 'tpl\_%'
        order by f.created_at`,
      [id],
    );
    const files: Record<string, { url: string; name: string; type: string }[]> = {};
    for (const r of rows) (files[r.rowId] ??= []).push({ url: `/api/files/${r.id}`, name: r.name, type: r.type });
    return { files };
  });

  app.post('/pages/:id/fields', async (req, reply) => {
    // {name, type, options…}: any type (rows.ts). {field: {…}}: the app's own shape, for relations.
    if (!(req.body as { field?: unknown } | null)?.field) return addFieldFlat(req, reply);
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        field: z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            name: z.string().trim().min(1).max(200),
            type: z.enum(['relation', 'rollup', 'formula', 'text', 'number']),
          })
          .passthrough(),
      }),
      req.body,
    );
    const page = await requirePage(req.user.id, id, 'edit');
    if (!isDatabase(page.type)) throw new HttpError(400, 'Not a database');
    await requireUnlocked(id);
    // "Lock views and properties" on a database keeps its properties as they are.
    if (await readDoc(id, null, (doc) => doc.getMap('dbSettings').get('locked') === true).catch(() => false)) {
      throw new HttpError(423, 'Views and properties are locked. Unlock them from the database’s ••• menu first.');
    }
    const added = await editDoc(
      id,
      null,
      (doc) => {
        const fields = doc.getArray<Y.Map<unknown>>('fields');
        if (fields.toArray().some((f) => f instanceof Y.Map && f.get('id') === body.field.id)) return false;
        const m = new Y.Map<unknown>();
        for (const [k, v] of Object.entries({ width: 180, ...body.field })) m.set(k, v);
        fields.push([m]);
        return true;
      },
      { editor: req.user.id },
    );
    return reply.code(added ? 201 : 200).send({ ok: true, added });
  });
}
