import { createEvent, type EventColor } from '../calendar/api';
import type { RepeatRule } from '../calendar/repeat';
import type { FieldType, SelectOption } from '../database/model';
import { newId, nextColor } from '../database/model';
import { api, type PageSummary, type PageType } from '../lib/api';
import { appendBlocks, type JsonBlock, markdownToBlocks, type MigratedDatabase, writeBlocks, writeDatabase } from '../lib/importer';

// Turning what the AI assistant proposed (and the person picked) into real pages, databases and
// calendar tasks. The proposal format is described to the model in server/src/aiGuide.ts.

export interface ProposedDocument {
  ref: string;
  title: string;
  icon: string;
  parent: string | null;
  appendTo: string | null;
  markdown: string;
}

export interface ProposedDatabase {
  ref: string;
  title: string;
  icon: string;
  parent: string | null;
  layout: 'board' | 'list' | 'grid' | 'calendar' | 'timeline' | 'gallery';
  fields: { name: string; type: 'text' | 'number' | 'select' | 'multi_select' | 'date' | 'checkbox' | 'url'; options: string[] }[];
  rows: { name: string; cells: Record<string, unknown>; notes: string }[];
}

export interface ProposedTask {
  title: string;
  date: string;
  endDate: string | null;
  time: string | null;
  minutes: number | null;
  notes: string;
  color: string | null;
  reminder: number | null;
  repeat: { every: number; unit: 'day' | 'week' | 'month' | 'year'; until: string | null } | null;
  document: string | null;
  task: boolean;
}

export interface Proposal {
  documents: ProposedDocument[];
  databases?: ProposedDatabase[];
  tasks: ProposedTask[];
}

export interface Picked {
  documents: Set<number>;
  databases: Set<number>;
  tasks: Set<number>;
}

export interface Built {
  pages: { id: string; title: string }[];
  tasks: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DONE = /\b(done|complete|completed|finished)\b/i;
const DOING = /\b(doing|in progress|started|working)\b/i;
const TODO = /\b(to ?do|not started|planned|backlog|open)\b/i;

const pad = (n: number) => String(n).padStart(2, '0');
function endTime(start: string, minutes: number) {
  const [h, m] = start.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// ---------- documents ----------

/** Splits "@2026-11-03" in text into date chips (a dated to-do shows on Today). */
function withDates(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  for (const item of content as { type: string; text?: string; styles?: unknown }[]) {
    if (item.type !== 'text' || !item.text || !/@\d{4}-\d{2}-\d{2}/.test(item.text)) {
      out.push(item);
      continue;
    }
    const parts = item.text.split(/@(\d{4}-\d{2}-\d{2})/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) out.push({ type: 'dateMention', props: { date: part } });
      else if (part) out.push({ ...item, text: part });
    });
  }
  return out;
}

function plainText(block: JsonBlock): string {
  return Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? '').join('').trim() : '';
}

/**
 * The document's blocks: Markdown, with dates turned into chips and {{database:REF}}, {{page:REF}} and
 * {{tasks}} lines replaced by those blocks. Whatever wasn't placed is added at the end.
 */
function documentBlocks(markdown: string, place: { databases: Map<string, string>; pages: Map<string, string>; events: string[] }): JsonBlock[] {
  const used = { databases: new Set<string>(), pages: new Set<string>(), tasks: false };
  const visit = (blocks: JsonBlock[]): JsonBlock[] =>
    blocks.flatMap((b): JsonBlock[] => {
      const text = b.type === 'paragraph' ? plainText(b) : '';
      const m = /^\{\{\s*(database|page)\s*:\s*([^}]+?)\s*\}\}$/.exec(text);
      if (m) {
        const id = (m[1] === 'database' ? place.databases : place.pages).get(m[2]);
        if (!id) return [];
        (m[1] === 'database' ? used.databases : used.pages).add(m[2]);
        return [{ type: m[1] === 'database' ? 'database' : 'subpage', props: { pageId: id } }];
      }
      if (/^\{\{\s*tasks\s*\}\}$/.test(text)) {
        used.tasks = true;
        return place.events.map((eventId) => ({ type: 'event', props: { eventId } }));
      }
      return [{ ...b, content: withDates(b.content), children: b.children ? visit(b.children) : b.children }];
    });
  const blocks = visit(markdownToBlocks(markdown));
  for (const [ref, id] of place.databases) if (!used.databases.has(ref)) blocks.push({ type: 'database', props: { pageId: id } });
  if (place.events.length && !used.tasks) {
    blocks.push({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Tasks', styles: {} }] });
    for (const eventId of place.events) blocks.push({ type: 'event', props: { eventId } });
  }
  for (const [ref, id] of place.pages) if (!used.pages.has(ref)) blocks.push({ type: 'subpage', props: { pageId: id } });
  return blocks;
}

// ---------- databases ----------

const FIELD_TYPE: Record<ProposedDatabase['fields'][number]['type'], FieldType> = {
  text: 'text',
  number: 'number',
  select: 'select',
  multi_select: 'multi_select',
  date: 'date',
  checkbox: 'checkbox',
  url: 'url',
};

function optionColor(name: string, i: number) {
  if (DONE.test(name)) return 'green';
  if (DOING.test(name)) return 'orange';
  if (TODO.test(name)) return 'purple';
  return nextColor(i);
}

/** The database the AI described, as stored: properties (with the name first), cards and one view. */
function databaseOf(db: ProposedDatabase): MigratedDatabase {
  const name = { id: newId(), name: 'Name', type: 'text' as FieldType, primary: true, width: 240 };
  const fields: MigratedDatabase['fields'] = [name];
  const byName = new Map<string, MigratedDatabase['fields'][number]>();
  for (const f of db.fields) {
    if (byName.has(f.name.toLowerCase()) || f.name.toLowerCase() === 'name') continue;
    const field = {
      id: newId(),
      name: f.name,
      type: FIELD_TYPE[f.type],
      width: f.type === 'date' ? 160 : 180,
      ...(f.type === 'select' || f.type === 'multi_select'
        ? { options: f.options.map((o, i): SelectOption => ({ id: newId(), name: o, color: optionColor(o, i) })) }
        : {}),
    };
    fields.push(field);
    byName.set(f.name.toLowerCase(), field);
  }
  // Each layout needs something to work with: a status to group by, or dates to place cards on.
  const selects = fields.filter((f) => f.type === 'select');
  const dates = fields.filter((f) => f.type === 'date');
  const add = (field: MigratedDatabase['fields'][number]) => {
    fields.push(field);
    byName.set(field.name.toLowerCase(), field);
    return field;
  };
  if (db.layout === 'board' && !selects.length) {
    selects.push(
      add({
        id: newId(),
        name: 'Status',
        type: 'select',
        width: 160,
        options: ['To do', 'Doing', 'Done'].map((o, i) => ({ id: newId(), name: o, color: optionColor(o, i) })),
      }),
    );
  }
  if ((db.layout === 'calendar' || db.layout === 'timeline') && !dates.length) dates.push(add({ id: newId(), name: 'Date', type: 'date', width: 160 }));
  if (db.layout === 'timeline' && dates.length < 2) dates.push(add({ id: newId(), name: 'End', type: 'date', width: 160 }));

  const now = Date.now();
  const rows = db.rows.map((r, i) => {
    const cells: Record<string, unknown> = { [name.id]: r.name || `Item ${i + 1}` };
    for (const [key, raw] of Object.entries(r.cells)) {
      const field = byName.get(key.toLowerCase());
      if (!field || raw === null || raw === undefined || raw === '') continue;
      const optionId = (value: string) => {
        let option = field.options?.find((o) => o.name.toLowerCase() === value.toLowerCase());
        if (!option) {
          option = { id: newId(), name: value, color: optionColor(value, field.options?.length ?? 0) };
          field.options = [...(field.options ?? []), option];
        }
        return option.id;
      };
      if (field.type === 'select') cells[field.id] = optionId(String(raw).trim());
      else if (field.type === 'multi_select') {
        const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
        cells[field.id] = list.map((v) => v.trim()).filter(Boolean).map(optionId);
      } else if (field.type === 'date') {
        if (typeof raw === 'string' && DATE.test(raw.slice(0, 10))) cells[field.id] = raw.slice(0, 10);
      } else if (field.type === 'checkbox') cells[field.id] = raw === true || /^(true|yes|done|x|1)$/i.test(String(raw));
      else if (field.type === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) cells[field.id] = n;
      } else cells[field.id] = String(raw).slice(0, 5000);
    }
    return { id: newId(), createdAt: now + i, updatedAt: now + i, cells };
  });

  const view = {
    id: newId(),
    name: db.layout === 'grid' ? 'Grid' : db.layout.charAt(0).toUpperCase() + db.layout.slice(1),
    type: db.layout,
    groupBy: db.layout === 'board' ? (selects[0]?.id ?? null) : null,
    dateField: db.layout === 'calendar' || db.layout === 'timeline' ? (dates[0]?.id ?? null) : null,
    endField: db.layout === 'timeline' ? (dates[1]?.id ?? null) : null,
    coverField: null,
    chart: null,
    form: null,
    sorts: [],
    filters: [],
    hidden: [],
  };
  return { fields, rows, views: [view] };
}

// ---------- tasks ----------

async function createTask(workspaceId: string, t: ProposedTask, defaults: { color: EventColor; reminder: number | null }) {
  const repeat: RepeatRule | null = t.repeat
    ? { unit: t.repeat.unit, every: t.repeat.every, start: t.date, end: t.repeat.until, when: 'date', ...(t.task ? { resetStatus: 'todo' as const } : {}) }
    : null;
  return createEvent(workspaceId, {
    title: t.title,
    description: [t.notes, t.minutes ? `About ${t.minutes} minutes.` : ''].filter(Boolean).join('\n\n'),
    startDate: t.date,
    endDate: t.endDate,
    startTime: t.time,
    endTime: t.time && t.minutes ? endTime(t.time, t.minutes) : null,
    status: t.task ? 'todo' : null,
    color: ((t.color as EventColor | null) ?? defaults.color) as EventColor,
    reminder: t.reminder ?? defaults.reminder,
    repeat,
  });
}

// ---------- putting it together ----------

async function newPage(workspaceId: string, body: { type: PageType; title: string; icon: string; parentId: string | null; insertIntoParent?: boolean; empty?: boolean }) {
  const { page } = await api<{ page: PageSummary }>(`/api/workspaces/${workspaceId}/pages`, { method: 'POST', body });
  return page;
}

/** Order documents so a parent made in the same answer comes before its sub-pages. */
function parentsFirst(docs: { doc: ProposedDocument; i: number }[]) {
  const refs = new Map(docs.map((d) => [d.doc.ref, d]));
  const out: typeof docs = [];
  const seen = new Set<string>();
  const visit = (d: (typeof docs)[number], depth: number) => {
    if (seen.has(d.doc.ref) || depth > 20) return;
    const parent = d.doc.parent ? refs.get(d.doc.parent) : undefined;
    if (parent && parent !== d) visit(parent, depth + 1);
    if (!seen.has(d.doc.ref)) {
      seen.add(d.doc.ref);
      out.push(d);
    }
  };
  docs.forEach((d) => visit(d, 0));
  return out;
}

/**
 * Adds the picked parts of a proposal to the workspace. `existing` is the workspace's pages, for
 * checking ids the model used. Reports progress; throws on the first failure (what was made stays).
 */
export async function buildProposal(
  workspaceId: string,
  proposal: Proposal,
  picked: Picked,
  existing: { id: string; type: PageType; title: string }[],
  defaults: { color: EventColor; reminder: number | null },
  progress: (msg: string) => void,
  made: Built,
): Promise<Built> {
  const known = new Map(existing.map((p) => [p.id, p]));
  const isExisting = (id: string | null) => !!id && UUID.test(id) && known.has(id);

  const docs = proposal.documents.map((doc, i) => ({ doc, i })).filter(({ i }) => picked.documents.has(i));
  const newDocs = parentsFirst(docs.filter(({ doc }) => !isExisting(doc.appendTo)));
  const appends = docs.filter(({ doc }) => isExisting(doc.appendTo));
  const databases = (proposal.databases ?? []).map((db, i) => ({ db, i })).filter(({ i }) => picked.databases.has(i));
  const tasks = proposal.tasks.map((t, i) => ({ t, i })).filter(({ i }) => picked.tasks.has(i));

  // 1. Pages, so everything can point at them. Sub-pages of new documents are linked from their content below.
  const docIds = new Map<string, string>();
  for (const { doc } of newDocs) {
    progress(`Making “${doc.title}”…`);
    const parentRef = doc.parent && docIds.get(doc.parent);
    const parentId = parentRef ?? (isExisting(doc.parent) ? doc.parent : null);
    const insert = !parentRef && !!parentId && known.get(parentId!)?.type === 'document';
    const page = await newPage(workspaceId, { type: 'document', title: doc.title, icon: doc.icon, parentId, insertIntoParent: insert });
    docIds.set(doc.ref, page.id);
    made.pages.push({ id: page.id, title: doc.title });
  }
  const dbIds = new Map<string, string>();
  for (const { db } of databases) {
    progress(`Making “${db.title}”…`);
    const parentRef = db.parent && docIds.get(db.parent);
    const parentId = parentRef ?? (isExisting(db.parent) ? db.parent : null);
    const page = await newPage(workspaceId, { type: db.layout, title: db.title, icon: db.icon, parentId, empty: true });
    dbIds.set(db.ref, page.id);
    made.pages.push({ id: page.id, title: db.title });
    // A database for an existing document appears inside it.
    if (!parentRef && parentId && known.get(parentId)?.type === 'document') await appendBlocks(parentId, [{ type: 'database', props: { pageId: page.id } }]);
  }

  // 2. Database contents, and each card's notes.
  for (const { db } of databases) {
    progress(`Filling “${db.title}”…`);
    const id = dbIds.get(db.ref)!;
    const data = databaseOf(db);
    await writeDatabase(id, data);
    for (const [k, row] of db.rows.entries()) {
      if (row.notes.trim()) await writeBlocks(id, documentBlocks(row.notes, { databases: new Map(), pages: new Map(), events: [] }), data.rows[k].id);
    }
  }

  // 3. Calendar tasks (a few at a time).
  const eventsFor = new Map<string, string[]>();
  for (let k = 0; k < tasks.length; k += 4) {
    progress(`Adding tasks… ${k} of ${tasks.length}`);
    const batch = await Promise.all(tasks.slice(k, k + 4).map(({ t }) => createTask(workspaceId, t, defaults).then((ev) => ({ t, ev }))));
    for (const { t, ev } of batch) {
      made.tasks++;
      const owner = t.document && docs.some(({ doc }) => doc.ref === t.document) ? t.document : null;
      if (owner) eventsFor.set(owner, [...(eventsFor.get(owner) ?? []), ev.id]);
    }
  }

  // 4. Document contents, with their databases, sub-pages and linked tasks in place.
  const childrenOf = (ref: string) => ({
    databases: new Map(databases.filter(({ db }) => db.parent === ref).map(({ db }) => [db.ref, dbIds.get(db.ref)!])),
    pages: new Map(newDocs.filter(({ doc }) => doc.parent === ref).map(({ doc }) => [doc.ref, docIds.get(doc.ref)!])),
    events: eventsFor.get(ref) ?? [],
  });
  for (const { doc } of newDocs) {
    progress(`Writing “${doc.title}”…`);
    await writeBlocks(docIds.get(doc.ref)!, documentBlocks(doc.markdown, childrenOf(doc.ref)));
  }
  for (const { doc } of appends) {
    progress('Adding to an existing page…');
    await appendBlocks(doc.appendTo!, documentBlocks(doc.markdown, childrenOf(doc.ref)));
    made.pages.push({ id: doc.appendTo!, title: known.get(doc.appendTo!)?.title || 'Untitled' });
  }
  return made;
}
