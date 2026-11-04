import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import { accessMap, atLeast, requireMember, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { databaseRows, editDoc, eventBlock, readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { one, query } from '../db.js';
import { fieldsOf, pruneWorkspaceRowRefs } from '../docIndex.js';
import { locationsFor } from '../locations.js';
import { placeBody, placeBlock, removeEverywhere } from '../placement.js';
import { isDate, today, validRule } from '../repeat.js';
import { applyPathStep, checkPaths, choosePath, finishMore, pathsSchema, pathsView, undoMore } from '../paths.js';
import { syncCardStatuses } from '../taskStatus.js';
import { emit } from '../webhooks.js';
import { HttpError, idParams, parse } from '../util.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use an HH:MM time');
const repeat = z.unknown().refine((v) => v === null || validRule(v), 'Invalid repeat rule');
const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red', 'aqua'] as const;

const eventFields = {
  title: z.string().max(500),
  description: z.string().max(20_000),
  startDate: date,
  startTime: time.nullable(),
  endDate: date.nullable(),
  endTime: time.nullable(),
  color: z.enum(COLORS),
  status: z.enum(['todo', 'doing', 'done']).nullable(),
  repeat,
  /** Minutes before the start to remind people (0 = at the start); null for none. */
  reminder: z.number().int().min(0).max(40320).nullable(),
  /** Tasks: questions with answers that lead to steps (see paths.ts). */
  paths: pathsSchema,
};

const EVENT_COLUMNS = `e.id, e.workspace_id as "workspaceId", e.title, e.description, to_char(e.start_date, 'YYYY-MM-DD') as "startDate",
  e.start_time as "startTime", to_char(e.end_date, 'YYYY-MM-DD') as "endDate", e.end_time as "endTime", e.color, e.status, e.repeat, e.reminder,
  e.paths, e.path_state as "pathState", e.created_by as "createdBy", e.created_at as "createdAt", e.updated_at as "updatedAt"`;

interface EventRow {
  id: string;
  workspaceId: string;
  title: string;
  status: string | null;
  createdBy: string | null;
  startDate: string;
  endDate: string | null;
}

async function eventOr404(id: string) {
  const row = await one<EventRow>(`select ${EVENT_COLUMNS} from events e where e.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Event not found');
  return row;
}

function checkSpan(start: string, end: string | null | undefined) {
  if (end && end < start) throw new HttpError(400, 'The end date is before the start date');
}

const isDatabase = (type: string) => (DATABASE_TYPES as readonly string[]).includes(type);
const rowParams = z.object({ id: z.uuid(), rowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/**
 * Events and tasks that aren't in any page or card (only on the calendar). Owners clear everyone's;
 * members only the ones they made. Pages in the trash don't count (the calendar doesn't show them either).
 */
const UNPLACED = `from events e
  where e.workspace_id = $1 and ($2::uuid is null or e.created_by = $2)
    and not exists (select 1 from event_refs r join pages p on p.id = r.page_id and p.deleted_at is null where r.event_id = e.id)`;

export async function calendarRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/workspaces/:id/events/unplaced', async (req) => {
    const { id } = parse(idParams, req.params);
    const role = await requireMember(req.user.id, id);
    await pruneWorkspaceRowRefs(id);
    const row = await one<{ n: number }>(`select count(*)::int as n ${UNPLACED}`, [id, role === 'owner' ? null : req.user.id]);
    return { count: row?.n ?? 0, everyone: role === 'owner' };
  });

  app.delete('/workspaces/:id/events/unplaced', async (req) => {
    const { id } = parse(idParams, req.params);
    const role = await requireMember(req.user.id, id);
    await pruneWorkspaceRowRefs(id);
    const gone = await query(`delete from events where id in (select e.id ${UNPLACED}) returning id`, [id, role === 'owner' ? null : req.user.id]);
    return { deleted: gone.length };
  });

  /**
   * Everything on the calendar between two dates: events (repeating ones are always included so the
   * calendar can show their upcoming dates), every dated card, and every block with a date typed in it.
   */
  app.get('/workspaces/:id/calendar', async (req) => {
    const { id } = parse(idParams, req.params);
    const { from, to } = parse(z.object({ from: date, to: date }), req.query);
    await requireMember(req.user.id, id);
    const access = await accessMap(req.user.id, id);
    const visible = (pageId: string) => (access.get(pageId) ?? 'none') !== 'none';

    const events = await query<EventRow>(
      `select ${EVENT_COLUMNS} from events e
        where e.workspace_id = $1 and (e.repeat is not null or (e.start_date <= $3 and coalesce(e.end_date, e.start_date) >= $2))
        order by e.start_date, e.start_time nulls first`,
      [id, from, to],
    );
    const eventLocations = await locationsFor('event_refs', 'event_id', events.map((e) => e.id), access);

    const cards = (
      await query<{ pageId: string; rowId: string; fieldId: string; fieldName: string; date: string; endDate: string | null; title: string; status: string | null; statusColor: string | null; pageTitle: string; pageIcon: string; pageType: string; repeat: unknown }>(
        `select d.page_id as "pageId", d.row_id as "rowId", d.field_id as "fieldId", d.field_name as "fieldName", to_char(d.date, 'YYYY-MM-DD') as date,
                to_char(d.end_date, 'YYYY-MM-DD') as "endDate", d.title, d.status, d.status_color as "statusColor", p.title as "pageTitle", p.icon as "pageIcon",
                p.type as "pageType", r.rule as repeat
           from row_dates d
           join pages p on p.id = d.page_id and p.deleted_at is null and p.workspace_id = $1
           left join row_repeats r on r.page_id = d.page_id and r.row_id = d.row_id and r.rule->>'dateField' = d.field_id
          where (d.date <= $3 and coalesce(d.end_date, d.date) >= $2) or r.rule is not null`,
        [id, from, to],
      )
    ).filter((c) => visible(c.pageId));

    const blockRows = (
      await query<{ pageId: string; rowId: string; blockId: string; date: string; text: string; done: boolean | null; pageTitle: string; pageIcon: string; pageType: string }>(
        `select b.page_id as "pageId", b.row_id as "rowId", b.block_id as "blockId", to_char(b.date, 'YYYY-MM-DD') as date, b.text, b.done,
                p.title as "pageTitle", p.icon as "pageIcon", p.type as "pageType"
           from block_dates b join pages p on p.id = b.page_id and p.deleted_at is null and p.workspace_id = $1
          where b.date between $2 and $3`,
        [id, from, to],
      )
    ).filter((b) => visible(b.pageId));
    // Blocks written inside a card: name the card too.
    const titles = new Map<string, Map<string, string>>();
    const blocks = [];
    for (const b of blockRows) {
      let rowTitle: string | null = null;
      if (b.rowId) {
        if (!titles.has(b.pageId)) titles.set(b.pageId, new Map((await readDoc(b.pageId, null, databaseRows)).map((r) => [r.id, r.title])));
        rowTitle = titles.get(b.pageId)!.get(b.rowId) ?? null;
        if (rowTitle === null) continue;
      }
      blocks.push({ ...b, rowId: b.rowId || null, rowTitle });
    }

    return {
      events: events.map((e) => ({ ...e, locations: eventLocations.get(e.id) ?? [] })),
      cards,
      blocks,
    };
  });

  app.post('/workspaces/:id/events', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const body = parse(
      z.object({
        ...eventFields,
        title: eventFields.title.default(''),
        description: eventFields.description.default(''),
        startTime: eventFields.startTime.default(null),
        endDate: eventFields.endDate.default(null),
        endTime: eventFields.endTime.default(null),
        color: eventFields.color.default('blue'),
        status: eventFields.status.default(null),
        repeat: repeat.default(null),
        reminder: eventFields.reminder.default(null),
        paths: eventFields.paths.default(null),
        // Also put an event block on a page or card straight away.
        place: placeBody.shape.target.optional(),
      }),
      req.body,
    );
    checkSpan(body.startDate, body.endDate);
    checkPaths(body.paths);
    const row = await one<EventRow>(
      `insert into events (workspace_id, title, description, start_date, start_time, end_date, end_time, color, status, repeat, reminder, created_by, paths)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [
        id,
        body.title,
        body.description,
        body.startDate,
        body.startTime,
        body.endDate,
        body.endTime,
        body.color,
        body.status,
        body.repeat ? JSON.stringify(body.repeat) : null,
        body.reminder,
        req.user.id,
        body.paths ? JSON.stringify(body.paths) : null,
      ],
    );
    if (body.place) {
      await placeBlock({
        userId: req.user.id,
        workspaceId: id,
        access: await accessMap(req.user.id, id),
        refs: { table: 'event_refs', column: 'event_id', id: row!.id },
        match: eventBlock(row!.id),
        fresh: { nodeName: 'event', attrs: { eventId: row!.id } },
        target: body.place,
        keepExisting: true,
      });
    }
    const created = await eventOr404(row!.id);
    emit(id, 'event.created', created);
    return reply.code(201).send({ event: created });
  });

  app.get('/events/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    await requireMember(req.user.id, event.workspaceId);
    const locations = await locationsFor('event_refs', 'event_id', [id], await accessMap(req.user.id, event.workspaceId));
    return { event: { ...event, locations: locations.get(id) ?? [] } };
  });

  // Everyone in the workspace can change events, like a shared calendar.
  app.patch('/events/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    await requireMember(req.user.id, event.workspaceId);
    const body = parse(z.object(eventFields).partial(), req.body);
    checkSpan(body.startDate ?? event.startDate, body.endDate === undefined ? event.endDate : body.endDate);
    if (body.paths !== undefined) checkPaths(body.paths);
    const columns: Record<string, string> = {
      title: 'title',
      description: 'description',
      startDate: 'start_date',
      startTime: 'start_time',
      endDate: 'end_date',
      endTime: 'end_time',
      color: 'color',
      status: 'status',
      repeat: 'repeat',
      reminder: 'reminder',
      paths: 'paths',
    };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      const v = (body as Record<string, unknown>)[key];
      if (v === undefined) continue;
      values.push((key === 'repeat' || key === 'paths') && v !== null ? JSON.stringify(v) : v);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length) await query(`update events set ${sets.join(', ')}, updated_at = now() where id = $1`, values);
    // A task ticked off (or reopened): keep "finished today" up to date.
    if (body.status !== undefined && (body.status === 'done') !== (event.status === 'done')) {
      if (body.status === 'done') {
        await query(
          `insert into task_completions (workspace_id, key, title, user_id, completed_on) values ($1, $2, $3, $4, $5)
           on conflict (workspace_id, key, completed_on) do update set user_id = excluded.user_id`,
          [event.workspaceId, `event:${id}`, (body.title ?? event.title).slice(0, 300), req.user.id, today()],
        );
      } else {
        await query('delete from task_completions where workspace_id = $1 and key = $2 and completed_on = $3', [event.workspaceId, `event:${id}`, today()]);
      }
    }
    if (body.status !== undefined && (body.status === 'done') !== (event.status === 'done')) await applyPathStep(id, body.status === 'done', req.user.id);
    if (body.status !== undefined && body.status !== event.status) await syncCardStatuses(id);
    const locations = await locationsFor('event_refs', 'event_id', [id], await accessMap(req.user.id, event.workspaceId));
    const updated = await eventOr404(id);
    emit(event.workspaceId, 'event.updated', updated);
    if (updated.status === 'done' && event.status !== 'done') emit(event.workspaceId, 'task.completed', { kind: 'event', id, title: updated.title });
    return { event: { ...updated, locations: locations.get(id) ?? [] } };
  });

  // Tasks with paths: what to choose from today (with each path's progress), and choosing.
  app.get('/events/:id/paths', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    await requireMember(req.user.id, event.workspaceId);
    return pathsView(req.user.id, id);
  });

  app.post('/events/:id/paths/choose', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    await requireMember(req.user.id, event.workspaceId);
    const { trail } = parse(z.object({ trail: z.array(z.string().max(64)).max(6).nullable() }), req.body);
    const view = await choosePath(req.user.id, id, trail);
    emit(event.workspaceId, 'event.updated', await eventOr404(id));
    return view;
  });

  // Finishing more steps of a path on the same day (getting ahead, or catching up), and undoing one.
  app.post('/events/:id/paths/more', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    await requireMember(req.user.id, event.workspaceId);
    const { trail, count } = parse(z.object({ trail: z.array(z.string().max(64)).min(1).max(6), count: z.number().int().min(1).max(50) }), req.body);
    const view = await finishMore(req.user.id, id, trail, count, req.user.id);
    emit(event.workspaceId, 'event.updated', await eventOr404(id));
    return view;
  });

  app.post('/events/:id/paths/more/undo', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    await requireMember(req.user.id, event.workspaceId);
    const { index } = parse(z.object({ index: z.number().int().min(0) }), req.body);
    const view = await undoMore(req.user.id, id, index, req.user.id);
    emit(event.workspaceId, 'event.updated', await eventOr404(id));
    return view;
  });

  app.delete('/events/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    const role = await requireMember(req.user.id, event.workspaceId);
    if (role !== 'owner' && event.createdBy !== req.user.id) throw new HttpError(403, 'Only the person who added this event or a workspace owner can delete it');
    await removeEverywhere(await accessMap(req.user.id, event.workspaceId), { table: 'event_refs', column: 'event_id', id }, eventBlock(id));
    await query('delete from events where id = $1', [id]);
    emit(event.workspaceId, 'event.deleted', { id, title: event.title });
    return { ok: true };
  });

  // Attach the event to a page or card (moving it from wherever it is unless keepExisting), or unlink it.
  app.post('/events/:id/place', async (req) => {
    const { id } = parse(idParams, req.params);
    const event = await eventOr404(id);
    await requireMember(req.user.id, event.workspaceId);
    const body = parse(placeBody, req.body);
    const access = await accessMap(req.user.id, event.workspaceId);
    await placeBlock({
      userId: req.user.id,
      workspaceId: event.workspaceId,
      access,
      refs: { table: 'event_refs', column: 'event_id', id },
      match: eventBlock(id),
      fresh: { nodeName: 'event', attrs: { eventId: id } },
      target: body.target,
      keepExisting: body.keepExisting,
    });
    if (event.status) await syncCardStatuses(id);
    const locations = await locationsFor('event_refs', 'event_id', [id], access);
    return { locations: locations.get(id) ?? [] };
  });

  // ---------- cards seen from the calendar ----------

  async function databasePage(userId: string, pageId: string, need: 'view' | 'edit') {
    const page = await requirePage(userId, pageId, need);
    if (!isDatabase(page.type)) throw new HttpError(400, 'Not a database page');
    return page;
  }

  // Properties of a database (for the repeat settings: which date and status to use).
  app.get('/pages/:id/fields', async (req) => {
    const { id } = parse(idParams, req.params);
    await databasePage(req.user.id, id, 'view');
    return { fields: await readDoc(id, null, fieldsOf) };
  });

  // One card's cells and repeat rule.
  app.get('/pages/:id/rows/:rowId', async (req) => {
    const { id, rowId } = parse(rowParams, req.params);
    const page = await databasePage(req.user.id, id, 'view');
    const found = await readDoc(id, null, (doc) => {
      const row = doc.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === rowId);
      if (!row) return null;
      const cells = row.get('cells');
      return { id: rowId, cells: cells instanceof Y.Map ? cells.toJSON() : {}, repeat: row.get('repeat') ?? null, fields: fieldsOf(doc) };
    });
    if (!found) throw new HttpError(404, 'Card not found');
    return { row: found, canEdit: atLeast(page.access, 'edit') };
  });

  // Change some of a card's cells, e.g. its date when it's dragged on the calendar.
  app.patch('/pages/:id/rows/:rowId/cells', async (req) => {
    const { id, rowId } = parse(rowParams, req.params);
    await databasePage(req.user.id, id, 'edit');
    const { cells } = parse(z.object({ cells: z.record(z.string().max(64), z.unknown()) }), req.body);
    const ok = await editDoc(id, null, (doc) => {
      const row = doc.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === rowId);
      const map = row?.get('cells');
      if (!row || !(map instanceof Y.Map)) return false;
      const fields = new Map(fieldsOf(doc).map((f) => [f.id, f]));
      for (const [fieldId, value] of Object.entries(cells)) {
        const field = fields.get(fieldId);
        if (!field) continue;
        if (field.type === 'date' && value !== null && !isDate(value)) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
        if (value === null) map.delete(fieldId);
        else map.set(fieldId, value);
      }
      row.set('updatedAt', Date.now());
      return true;
    }, { editor: req.user.id });
    if (!ok) throw new HttpError(404, 'Card not found');
    return { ok: true };
  });

  // Make a card repeat (or stop repeating).
  app.put('/pages/:id/rows/:rowId/repeat', async (req) => {
    const { id, rowId } = parse(rowParams, req.params);
    await databasePage(req.user.id, id, 'edit');
    const { rule } = parse(z.object({ rule: repeat }), req.body);
    const ok = await editDoc(id, null, (doc) => {
      const row = doc.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === rowId);
      if (!row) return false;
      if (rule) {
        const fields = fieldsOf(doc);
        const r = rule as { dateField?: string };
        if (!fields.some((f) => f.id === r.dateField && f.type === 'date')) throw new HttpError(400, 'Choose a date property for the card to repeat on');
        row.set('repeat', rule);
      } else row.delete('repeat');
      return true;
    });
    if (!ok) throw new HttpError(404, 'Card not found');
    return { ok: true };
  });
}
