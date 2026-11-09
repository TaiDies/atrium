import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import { requirePage, requireUnlocked } from '../access.js';
import { requireUser } from '../auth.js';
import { editDoc, readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { query } from '../db.js';
import { fieldsOf } from '../docIndex.js';
import { writeMarkdown } from '../markdownBlocks.js';
import { docToMarkdown } from '../readable.js';
import { type FieldDef, findField, namedCells, normaliseCells } from '../rowCells.js';
import { HttpError, idParams, parse } from '../util.js';
import { emit } from '../webhooks.js';
import { applyView, FILTER_OPS, type Filter, type Sort } from '../viewFilter.js';

// Database cards through the API: making, changing and deleting them, their properties, and the text
// of each card's own page. Values are checked against the properties (see rowCells.ts).

const isDatabase = (type: string) => (DATABASE_TYPES as readonly string[]).includes(type);
const ROW_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const rowParams = z.object({ id: z.uuid(), rowId: ROW_ID });
const newId = () => randomUUID().replace(/-/g, '').slice(0, 12);
const today = () => new Date().toISOString().slice(0, 10);

const rowBody = z.object({
  id: ROW_ID.optional(),
  cells: z.record(z.string().max(200), z.unknown()).default({}),
  /** Put it after this card (default: at the end). */
  afterRowId: ROW_ID.optional(),
  /** Start from one of the database's card templates. */
  templateId: ROW_ID.optional(),
  /** The card's own page, as Markdown. */
  markdown: z.string().max(1_000_000).optional(),
});
type RowBody = z.infer<typeof rowBody>;

async function databaseFor(userId: string, id: string, need: 'view' | 'edit') {
  const page = await requirePage(userId, id, need);
  if (!isDatabase(page.type)) throw new HttpError(400, 'Not a database');
  if (page.deleted_at) throw new HttpError(400, 'This page is in the trash');
  if (need === 'edit') await requireUnlocked(id);
  return page;
}

async function memberIds(workspaceId: string) {
  return new Set((await query<{ user_id: string }>('select user_id from workspace_members where workspace_id = $1', [workspaceId])).map((r) => r.user_id));
}

function rowJson(r: Y.Map<unknown>, fields: FieldDef[], named: boolean) {
  const cells = r.get('cells');
  const stored = cells instanceof Y.Map ? (cells.toJSON() as Record<string, unknown>) : {};
  return { id: String(r.get('id')), createdAt: r.get('createdAt') ?? null, updatedAt: r.get('updatedAt') ?? null, cells: named ? namedCells(fields, stored) : stored };
}

/** Adds cards in one change. Returns what was made (with templates' bodies still to copy). */
async function addRows(pageId: string, userId: string, workspaceId: string, items: RowBody[]) {
  const members = await memberIds(workspaceId);
  const made = await editDoc(
    pageId,
    null,
    (doc) => {
      const fields = fieldsOf(doc) as FieldDef[];
      const rows = doc.getArray<Y.Map<unknown>>('rows');
      const templates = doc.getArray<Y.Map<unknown>>('cardTemplates');
      const yfields = doc.getArray<Y.Map<unknown>>('fields').toArray();
      const out: { id: string; json: ReturnType<typeof rowJson>; templateId?: string; markdown?: string }[] = [];
      for (const item of items) {
        const cells = normaliseCells(fields, item.cells, { members, today: today() });
        const id = item.id ?? newId();
        if (rows.toArray().some((r) => r instanceof Y.Map && r.get('id') === id)) throw new HttpError(409, `A card with id ${id} already exists`);
        let start: Record<string, unknown> = {};
        if (item.templateId) {
          const tpl = templates.toArray().find((t) => t instanceof Y.Map && t.get('id') === item.templateId);
          if (!tpl) throw new HttpError(400, `No card template ${item.templateId}`);
          const c = tpl.get('cells');
          start = c instanceof Y.Map ? structuredClone(c.toJSON()) : {};
        }
        const ycells = new Y.Map<unknown>();
        for (const [k, v] of Object.entries({ ...start, ...cells })) if (v !== null) ycells.set(k, v);
        // Unique IDs: the next number, as in the app.
        for (const f of yfields) {
          if (f.get('type') !== 'unique_id') continue;
          const fid = String(f.get('id'));
          const next = (f.get('nextId') as number | undefined) ?? 1;
          ycells.set(fid, next);
          f.set('nextId', next + 1);
        }
        const now = Date.now();
        const row = new Y.Map<unknown>();
        for (const [k, v] of Object.entries({ id, createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId })) row.set(k, v);
        row.set('cells', ycells);
        const after = item.afterRowId ? rows.toArray().findIndex((r) => r instanceof Y.Map && r.get('id') === item.afterRowId) : -1;
        if (item.afterRowId && after < 0) throw new HttpError(400, `No card ${item.afterRowId} to put it after`);
        rows.insert(after >= 0 ? after + 1 : rows.length, [row]);
        out.push({ id, json: rowJson(row, fields, false), templateId: item.templateId, markdown: item.markdown });
      }
      return out;
    },
    { editor: userId },
  );
  // Each card's own page: from its template, then any Markdown given.
  for (const m of made) {
    if (m.templateId) {
      const state = await readDoc(pageId, m.templateId, (doc) => Y.encodeStateAsUpdate(doc)).catch(() => null);
      if (state) await editDoc(pageId, m.id, (doc) => Y.applyUpdate(doc, state), { editor: userId });
    }
    if (m.markdown) await editDoc(pageId, m.id, (doc) => writeMarkdown(doc, m.markdown!, !m.templateId), { editor: userId });
  }
  return made.map((m) => m.json);
}

const actorOf = (u: { id: string; name: string }) => ({ id: u.id, name: u.name });

const FIELD_TYPES = ['text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'person', 'media', 'checklist', 'unique_id', 'button', 'ai', 'relation', 'rollup', 'formula', 'created_time', 'last_edited', 'created_by', 'edited_by'] as const;
const STATUS_GROUP = z.enum(['todo', 'doing', 'done']);
const optionIn = z.object({ id: z.string().max(64).optional(), name: z.string().trim().min(1).max(200), color: z.string().max(20).optional(), group: STATUS_GROUP.optional() });
const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const options = (list: z.infer<typeof optionIn>[]) =>
  list.map((o, i) => ({ id: o.id ?? newId(), name: o.name, color: o.color ?? COLORS[i % COLORS.length], ...(o.group ? { group: o.group } : {}) }));

const locked = (doc: Y.Doc) => doc.getMap('dbSettings').get('locked') === true;
const lockedError = () => new HttpError(423, 'Views and properties are locked. Unlock them from the database’s ••• menu first.');


export async function rowRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** The cards, with their values (by property id, or by name with ?format=named). */
  app.get('/pages/:id/rows', async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(
      z.object({
        format: z.enum(['ids', 'named']).default('ids'),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        cursor: z.coerce.number().int().min(0).default(0),
        /** A view (id or name): its filters and sorting apply. */
        view: z.string().max(200).optional(),
        /** JSON list of {property, op, value}, applied after the view's own filters. */
        filters: z.string().max(20_000).optional(),
        filterMode: z.enum(['and', 'or']).default('and'),
        /** JSON list of {property, dir}. */
        sort: z.string().max(5_000).optional(),
      }),
      req.query,
    );
    await databaseFor(req.user.id, id, 'view');
    const extraFilters = jsonList(q.filters, 'filters');
    const extraSorts = jsonList(q.sort, 'sort');
    return readDoc(id, null, (doc) => {
      const fields = fieldsOf(doc) as FieldDef[];
      let all = doc.getArray<Y.Map<unknown>>('rows').toArray().filter((r) => r instanceof Y.Map);
      if (q.view || extraFilters.length || extraSorts.length) {
        let shown = all.map((y) => {
          const c = y.get('cells');
          return { y, createdAt: y.get('createdAt'), updatedAt: y.get('updatedAt'), createdBy: y.get('createdBy'), updatedBy: y.get('updatedBy'), cells: (c instanceof Y.Map ? c.toJSON() : {}) as Record<string, unknown> };
        });
        if (q.view) {
          const v = findView(doc, q.view);
          if (!v) throw new HttpError(404, `There's no view “${q.view}”`);
          shown = applyView(fields, shown, { filters: (v.filters as Filter[]) ?? [], sorts: (v.sorts as Sort[]) ?? [], filterMode: v.filterMode === 'or' ? 'or' : 'and' }, req.user.id);
        }
        if (extraFilters.length || extraSorts.length) {
          shown = applyView(fields, shown, { filters: filtersIn(fields, extraFilters), sorts: sortsIn(fields, extraSorts), filterMode: q.filterMode }, req.user.id);
        }
        all = shown.map((r) => r.y);
      }
      const page = all.slice(q.cursor, q.cursor + q.limit).map((r) => rowJson(r, fields, q.format === 'named'));
      return { fields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options?.map((o) => ({ id: o.id, name: o.name })) })), rows: page, nextCursor: q.cursor + q.limit < all.length ? q.cursor + q.limit : null };
    });
  });

  app.post('/pages/:id/rows', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(rowBody, req.body ?? {});
    const page = await databaseFor(req.user.id, id, 'edit');
    const [row] = await addRows(id, req.user.id, page.workspace_id, [body]);
    emit(page.workspace_id, 'row.created', { pageId: id, row }, actorOf(req.user));
    return reply.code(201).send({ row });
  });

  app.post('/pages/:id/rows/batch', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { rows } = parse(z.object({ rows: z.array(rowBody).min(1).max(200) }), req.body);
    const page = await databaseFor(req.user.id, id, 'edit');
    const made = await addRows(id, req.user.id, page.workspace_id, rows);
    for (const row of made) emit(page.workspace_id, 'row.created', { pageId: id, row }, actorOf(req.user));
    return reply.code(201).send({ rows: made });
  });

  /** Changes some of a card's values (unknown properties or wrong values are refused). */
  app.patch('/pages/:id/rows/:rowId', async (req) => {
    const { id, rowId } = parse(rowParams, req.params);
    const { cells } = parse(z.object({ cells: z.record(z.string().max(200), z.unknown()) }), req.body);
    const page = await databaseFor(req.user.id, id, 'edit');
    const members = await memberIds(page.workspace_id);
    const row = await editDoc(
      id,
      null,
      (doc) => {
        const fields = fieldsOf(doc) as FieldDef[];
        const clean = normaliseCells(fields, cells, { members, today: today() });
        const r = doc.getArray<Y.Map<unknown>>('rows').toArray().find((x) => x instanceof Y.Map && x.get('id') === rowId);
        const map = r?.get('cells');
        if (!r || !(map instanceof Y.Map)) return null;
        for (const [k, v] of Object.entries(clean)) {
          if (v === null) map.delete(k);
          else map.set(k, v);
        }
        r.set('updatedAt', Date.now());
        r.set('updatedBy', req.user.id);
        return rowJson(r, fields, false);
      },
      { editor: req.user.id },
    );
    if (!row) throw new HttpError(404, 'Card not found');
    emit(page.workspace_id, 'row.updated', { pageId: id, row }, actorOf(req.user));
    return { row };
  });

  app.delete('/pages/:id/rows/:rowId', async (req) => {
    const { id, rowId } = parse(rowParams, req.params);
    const page = await databaseFor(req.user.id, id, 'edit');
    const gone = await editDoc(
      id,
      null,
      (doc) => {
        const rows = doc.getArray<Y.Map<unknown>>('rows');
        const i = rows.toArray().findIndex((x) => x instanceof Y.Map && x.get('id') === rowId);
        if (i < 0) return false;
        rows.delete(i, 1);
        return true;
      },
      { editor: req.user.id },
    );
    if (!gone) throw new HttpError(404, 'Card not found');
    emit(page.workspace_id, 'row.deleted', { pageId: id, rowId }, actorOf(req.user));
    return { ok: true };
  });

  /** A card's own page as Markdown. */
  app.get('/pages/:id/rows/:rowId/markdown', async (req) => {
    const { id, rowId } = parse(rowParams, req.params);
    await databaseFor(req.user.id, id, 'view');
    const content = await readDoc(id, rowId, (doc) =>
      docToMarkdown(doc, '', { pageLink: () => ({ title: 'a page', href: null }), fileLink: () => null, eventLabel: () => null, boardLabel: () => null }),
    );
    return { id: rowId, format: 'markdown', content };
  });

  app.put('/pages/:id/rows/:rowId/markdown', async (req) => {
    const { id, rowId } = parse(rowParams, req.params);
    const { markdown, mode } = parse(z.object({ markdown: z.string().max(1_000_000), mode: z.enum(['append', 'replace']).default('replace') }), req.body);
    const page = await databaseFor(req.user.id, id, 'edit');
    const exists = await readDoc(id, null, (doc) => doc.getArray<Y.Map<unknown>>('rows').toArray().some((x) => x instanceof Y.Map && x.get('id') === rowId));
    if (!exists) throw new HttpError(404, 'Card not found');
    const blocks = await editDoc(id, rowId, (doc) => writeMarkdown(doc, markdown, mode === 'replace'), { editor: req.user.id });
    emit(page.workspace_id, 'row.updated', { pageId: id, rowId, body: true }, actorOf(req.user));
    return { ok: true, blocks };
  });

  // ----- properties -----


  /** Changes a property: its name, options (select/status), or other settings. */
  app.patch('/pages/:id/fields/:fieldId', async (req) => {
    const { id, fieldId } = parse(z.object({ id: z.uuid(), fieldId: z.string().max(200) }), req.params);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(200).optional(), options: z.array(optionIn).max(200).optional(), formula: z.string().max(5000).optional(), aiPrompt: z.string().max(5000).optional(), prefix: z.string().max(20).optional() }),
      req.body,
    );
    const page = await databaseFor(req.user.id, id, 'edit');
    const field = await editDoc(
      id,
      null,
      (doc) => {
        if (locked(doc)) throw lockedError();
        const f = findField(fieldsOf(doc) as FieldDef[], fieldId);
        const y = f && doc.getArray<Y.Map<unknown>>('fields').toArray().find((x) => x instanceof Y.Map && x.get('id') === f.id);
        if (!f || !y) return null;
        if (body.name !== undefined) y.set('name', body.name);
        if (body.options !== undefined) {
          if (!['select', 'multi_select'].includes(f.type)) throw new HttpError(400, `“${f.name}” has no options`);
          y.set('options', options(body.options));
        }
        if (body.formula !== undefined) y.set('formula', body.formula);
        if (body.aiPrompt !== undefined) y.set('aiPrompt', body.aiPrompt);
        if (body.prefix !== undefined) y.set('prefix', body.prefix);
        return y.toJSON();
      },
      { editor: req.user.id },
    );
    if (!field) throw new HttpError(404, 'Property not found');
    void page;
    return { field };
  });

  app.delete('/pages/:id/fields/:fieldId', async (req) => {
    const { id, fieldId } = parse(z.object({ id: z.uuid(), fieldId: z.string().max(200) }), req.params);
    await databaseFor(req.user.id, id, 'edit');
    const done = await editDoc(
      id,
      null,
      (doc) => {
        if (locked(doc)) throw lockedError();
        const f = findField(fieldsOf(doc) as FieldDef[], fieldId);
        if (!f) return false;
        if (f.primary) throw new HttpError(400, 'The first property (the card title) can’t be deleted');
        const arr = doc.getArray<Y.Map<unknown>>('fields');
        const i = arr.toArray().findIndex((x) => x instanceof Y.Map && x.get('id') === f.id);
        arr.delete(i, 1);
        for (const r of doc.getArray<Y.Map<unknown>>('rows').toArray()) {
          const c = r instanceof Y.Map ? r.get('cells') : null;
          if (c instanceof Y.Map) c.delete(f.id);
        }
        return true;
      },
      { editor: req.user.id },
    );
    if (!done) throw new HttpError(404, 'Property not found');
    return { ok: true };
  });

  /** Puts the properties in this order (ids or names; ones left out keep their place after these). */
  app.post('/pages/:id/fields/order', async (req) => {
    const { id } = parse(idParams, req.params);
    const { fields: order } = parse(z.object({ fields: z.array(z.string().max(200)).min(1).max(100) }), req.body);
    await databaseFor(req.user.id, id, 'edit');
    const result = await editDoc(
      id,
      null,
      (doc) => {
        if (locked(doc)) throw lockedError();
        const defs = fieldsOf(doc) as FieldDef[];
        const ids = order.map((k) => {
          const f = findField(defs, k);
          if (!f) throw new HttpError(400, `There's no property “${k}”`);
          return f.id;
        });
        const arr = doc.getArray<Y.Map<unknown>>('fields');
        const current = arr.toArray().filter((x) => x instanceof Y.Map);
        const sorted = [...ids.map((fid) => current.find((x) => x.get('id') === fid)!), ...current.filter((x) => !ids.includes(String(x.get('id'))))];
        // Y.Maps can't be moved: copy them in the new order.
        const copies = sorted.map((m) => {
          const c = new Y.Map<unknown>();
          for (const [k, v] of Object.entries(m.toJSON())) c.set(k, v);
          return c;
        });
        arr.delete(0, arr.length);
        arr.insert(0, copies);
        return copies.map((c) => String(c.get('id')));
      },
      { editor: req.user.id },
    );
    return { fields: result };
  });

}

// ----- views -----

const VIEW_TYPES = ['grid', 'board', 'calendar', 'timeline', 'chart', 'form', 'list', 'gallery', 'feed'] as const;
const filterIn = z.object({ property: z.string().max(200), op: z.enum(FILTER_OPS as [string, ...string[]]), value: z.unknown().optional() });
const sortIn = z.object({ property: z.string().max(200), dir: z.enum(['asc', 'desc']).default('asc') });

function jsonList(raw: string | undefined, what: string): unknown[] {
  if (raw === undefined) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  throw new HttpError(400, `${what} must be a JSON list`);
}

function propertyId(fields: FieldDef[], key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null;
  const f = findField(fields, key);
  if (!f) throw new HttpError(400, `There's no property “${key}”`);
  return f.id;
}

/** API filters ({property, op, value}, options by name) as the app stores them (by id). */
export function filtersIn(fields: FieldDef[], list: unknown[]): (Filter & { id: string })[] {
  return list.map((raw) => {
    const f = parse(filterIn, raw);
    const field = findField(fields, f.property);
    if (!field) throw new HttpError(400, `There's no property “${f.property}”`);
    let value = f.value;
    if (field.options && typeof value === 'string' && ['select', 'status', 'multi_select'].includes(field.type)) {
      const v = value;
      const o = field.options.find((x) => x.id === v) ?? field.options.find((x) => x.name.trim().toLowerCase() === v.trim().toLowerCase());
      if (!o) throw new HttpError(400, `“${field.name}”: there's no option “${v}”`);
      value = o.id;
    }
    return { id: newId(), fieldId: field.id, op: f.op as Filter['op'], ...(value !== undefined ? { value } : {}) };
  });
}

function sortsIn(fields: FieldDef[], list: unknown[]): Sort[] {
  return list.map((raw) => {
    const s = parse(sortIn, raw);
    return { fieldId: propertyId(fields, s.property)!, dir: s.dir };
  });
}

function viewMaps(doc: Y.Doc) {
  return doc.getArray<Y.Map<unknown>>('views').toArray().filter((v) => v instanceof Y.Map);
}

function findView(doc: Y.Doc, key: string) {
  const all = viewMaps(doc);
  const m = all.find((v) => v.get('id') === key) ?? all.find((v) => String(v.get('name') ?? '').trim().toLowerCase() === key.trim().toLowerCase());
  return m ? (m.toJSON() as { id: string; filters?: unknown; sorts?: unknown; filterMode?: unknown }) : null;
}

const viewBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  type: z.enum(VIEW_TYPES).optional(),
  groupBy: z.string().max(200).nullable().optional(),
  subGroupBy: z.string().max(200).nullable().optional(),
  dateField: z.string().max(200).nullable().optional(),
  endField: z.string().max(200).nullable().optional(),
  coverField: z.string().max(200).nullable().optional(),
  filters: z.array(z.unknown()).max(50).optional(),
  filterMode: z.enum(['and', 'or']).optional(),
  sorts: z.array(z.unknown()).max(20).optional(),
  hidden: z.array(z.string().max(200)).max(200).optional(),
});

/** The stored settings a view body asks for (property names turned into ids). */
function viewValues(fields: FieldDef[], body: z.infer<typeof viewBody>) {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined) out.name = body.name;
  if (body.type !== undefined) out.type = body.type;
  for (const k of ['groupBy', 'subGroupBy', 'dateField', 'endField', 'coverField'] as const) if (body[k] !== undefined) out[k] = propertyId(fields, body[k]);
  if (body.filters !== undefined) out.filters = filtersIn(fields, body.filters);
  if (body.filterMode !== undefined) out.filterMode = body.filterMode;
  if (body.sorts !== undefined) out.sorts = sortsIn(fields, body.sorts);
  if (body.hidden !== undefined) out.hidden = body.hidden.map((h) => propertyId(fields, h));
  return out;
}

/** A view as the API shows it: its stored settings, with property names next to the ids. */
function viewJson(v: Y.Map<unknown>, fields: FieldDef[]) {
  const j = v.toJSON() as Record<string, unknown>;
  const name = (id: unknown) => fields.find((f) => f.id === id)?.name ?? null;
  return {
    ...j,
    filters: ((j.filters as Filter[] | undefined) ?? []).map((f) => ({ ...f, property: name(f.fieldId) })),
    sorts: ((j.sorts as Sort[] | undefined) ?? []).map((s) => ({ ...s, property: name(s.fieldId) })),
  };
}

/** A database's views (tabs): list, add, change and delete them. */
export async function viewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/pages/:id/views', async (req) => {
    const { id } = parse(idParams, req.params);
    await databaseFor(req.user.id, id, 'view');
    return readDoc(id, null, (doc) => {
      const fields = fieldsOf(doc) as FieldDef[];
      return { views: viewMaps(doc).map((v) => viewJson(v, fields)) };
    });
  });

  app.post('/pages/:id/views', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(viewBody.extend({ name: z.string().trim().min(1).max(200), type: z.enum(VIEW_TYPES) }), req.body);
    await databaseFor(req.user.id, id, 'edit');
    const view = await editDoc(
      id,
      null,
      (doc) => {
        if (locked(doc)) throw lockedError();
        const fields = fieldsOf(doc) as FieldDef[];
        const values: Record<string, unknown> = { id: newId(), groupBy: null, dateField: null, sorts: [], filters: [], hidden: [], ...viewValues(fields, body) };
        // Boards group by a select or status property; calendars and timelines need a date.
        if (values.type === 'board' && !values.groupBy) {
          const g = fields.find((f) => f.type === 'select' || f.type === 'status');
          if (!g) throw new HttpError(400, 'A board needs a select or status property to group by (groupBy)');
          values.groupBy = g.id;
        }
        if ((values.type === 'calendar' || values.type === 'timeline') && !values.dateField) {
          const d = fields.find((f) => f.type === 'date');
          if (!d) throw new HttpError(400, `A ${values.type} view needs a date property (dateField)`);
          values.dateField = d.id;
        }
        const m = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(values)) m.set(k, v);
        doc.getArray<Y.Map<unknown>>('views').push([m]);
        return viewJson(m, fields);
      },
      { editor: req.user.id },
    );
    return reply.code(201).send({ view });
  });

  app.patch('/pages/:id/views/:viewId', async (req) => {
    const { id, viewId } = parse(z.object({ id: z.uuid(), viewId: z.string().max(200) }), req.params);
    const body = parse(viewBody, req.body ?? {});
    await databaseFor(req.user.id, id, 'edit');
    const view = await editDoc(
      id,
      null,
      (doc) => {
        if (locked(doc)) throw lockedError();
        const fields = fieldsOf(doc) as FieldDef[];
        const key = findView(doc, viewId)?.id;
        const m = viewMaps(doc).find((v) => v.get('id') === key);
        if (!m) return null;
        for (const [k, v] of Object.entries(viewValues(fields, body))) m.set(k, v);
        return viewJson(m, fields);
      },
      { editor: req.user.id },
    );
    if (!view) throw new HttpError(404, 'View not found');
    return { view };
  });

  app.delete('/pages/:id/views/:viewId', async (req) => {
    const { id, viewId } = parse(z.object({ id: z.uuid(), viewId: z.string().max(200) }), req.params);
    await databaseFor(req.user.id, id, 'edit');
    const done = await editDoc(
      id,
      null,
      (doc) => {
        if (locked(doc)) throw lockedError();
        const key = findView(doc, viewId)?.id;
        const arr = doc.getArray<Y.Map<unknown>>('views');
        const i = arr.toArray().findIndex((v) => v instanceof Y.Map && v.get('id') === key);
        if (i < 0) return false;
        if (viewMaps(doc).length <= 1) throw new HttpError(400, 'A database needs at least one view');
        arr.delete(i, 1);
        return true;
      },
      { editor: req.user.id },
    );
    if (!done) throw new HttpError(404, 'View not found');
    return { ok: true };
  });
}

/**
 * Adds a property of any type: POST /pages/:id/fields with {name, type, options?…} (status options take a
 * group). The older {field: {…}} shape, used by the app for relations, is handled in databases.ts.
 */
  /** Adds a property of any type (select and status take options; status options take a group). */
export async function addFieldFlat(req: FastifyRequest, reply: FastifyReply) {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
        name: z.string().trim().min(1).max(200),
        type: z.enum(FIELD_TYPES),
        options: z.array(optionIn).max(200).optional(),
        formula: z.string().max(5000).optional(),
        aiPrompt: z.string().max(5000).optional(),
        prefix: z.string().max(20).optional(),
      }),
      req.body,
    );
    await databaseFor(req.user.id, id, 'edit');
    const field = await editDoc(
      id,
      null,
      (doc) => {
        if (locked(doc)) throw lockedError();
        const arr = doc.getArray<Y.Map<unknown>>('fields');
        const fid = body.id ?? newId();
        if (arr.toArray().some((x) => x instanceof Y.Map && x.get('id') === fid)) throw new HttpError(409, 'A property with that id already exists');
        const status = body.type === 'status';
        if (status && body.options?.some((o) => !o.group)) throw new HttpError(400, 'Give every status option a group: "todo", "doing" or "done"');
        const m = new Y.Map<unknown>();
        const values: Record<string, unknown> = {
          id: fid,
          name: body.name,
          type: status ? 'select' : body.type,
          width: 180,
          ...(status ? { status: true } : {}),
          ...(body.options ? { options: options(body.options) } : status ? { options: options([{ name: 'Not started', group: 'todo' }, { name: 'In progress', group: 'doing' }, { name: 'Done', group: 'done' }]) } : {}),
          ...(body.formula !== undefined ? { formula: body.formula } : {}),
          ...(body.aiPrompt !== undefined ? { aiPrompt: body.aiPrompt } : {}),
          ...(body.type === 'unique_id' ? { prefix: body.prefix ?? '', nextId: 1 } : {}),
        };
        for (const [k, v] of Object.entries(values)) m.set(k, v);
        arr.push([m]);
        return m.toJSON();
      },
      { editor: req.user.id },
    );
    return reply.code(201).send({ field });
  }
