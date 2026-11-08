import * as Y from 'yjs';
import { one, query } from './db.js';
import { readDoc } from './blocks.js';
import { runAutomations } from './automations.js';
import { noticeMentions } from './mentions.js';
import { notify } from './notify.js';
import { isDate, nextAfter, type RepeatRule, today, validRule } from './repeat.js';

// Every time a page or card document is saved, this records what it contains that other screens list:
// attachments (Files), event blocks and dated blocks (Calendar), whiteboard blocks (Whiteboards), and —
// for database pages — every card's dates and repeat rule.

const FILE_URL_RE = /\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectFileIds(value: unknown, out: Set<string>) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(FILE_URL_RE)) out.add(m[1].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) collectFileIds(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectFileIds(v, out);
  }
}

function textOf(el: Y.XmlElement): string {
  return el
    .toArray()
    .map((c) =>
      c instanceof Y.XmlText
        ? c.toDelta().map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : '')).join('')
        : c instanceof Y.XmlElement && c.nodeName !== 'dateMention'
          ? textOf(c)
          : '',
    )
    .join('');
}

interface DocContents {
  files: Set<string>;
  events: Set<string>;
  /** The block each event sits in. */
  eventBlocks: Map<string, string>;
  boards: Set<string>;
  /** Pages this one links to (mentions, links, sub-page and database blocks), for backlinks. */
  links: Set<string>;
  dates: { blockId: string; date: string; text: string; done: boolean | null; time: string | null; remind: number | null; remindBy: string | null }[];
}

/** What a page or card document contains, from its blocks. */
export function contentsOf(doc: Y.Doc): DocContents {
  const out: DocContents = { files: new Set(), events: new Set(), eventBlocks: new Map(), boards: new Set(), links: new Set(), dates: [] };
  const visit = (node: Y.XmlElement | Y.XmlFragment, block: { id: string; content: Y.XmlElement | null } | null) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      collectFileIds(child.getAttributes(), out.files);
      const name = child.nodeName;
      if ((name === 'pageMention' || name === 'subpage' || name === 'database') && UUID_RE.test(String(child.getAttribute('pageId') ?? ''))) {
        out.links.add(String(child.getAttribute('pageId')).toLowerCase());
      }
      for (const c of child.toArray()) {
        if (!(c instanceof Y.XmlText)) continue;
        for (const op of c.toDelta() as { attributes?: { link?: { href?: string } } }[]) {
          const href = op.attributes?.link?.href;
          const id = href && /\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(href)?.[1];
          if (id) out.links.add(id.toLowerCase());
        }
      }
      if (name === 'event' && UUID_RE.test(String(child.getAttribute('eventId') ?? ''))) {
        const eventId = String(child.getAttribute('eventId')).toLowerCase();
        out.events.add(eventId);
        if (block?.id && !out.eventBlocks.has(eventId)) out.eventBlocks.set(eventId, block.id);
      }
      if (name === 'whiteboard' && UUID_RE.test(String(child.getAttribute('boardId') ?? ''))) out.boards.add(String(child.getAttribute('boardId')).toLowerCase());
      if (name === 'dateMention' && block && isDate(child.getAttribute('date'))) {
        const content = block.content;
        const checked = content?.nodeName === 'checkListItem' ? String(content.getAttribute('checked')) === 'true' : null;
        const time = String(child.getAttribute('time') ?? '');
        const remind = String(child.getAttribute('remind') ?? '');
        const by = String(child.getAttribute('by') ?? '');
        out.dates.push({
          blockId: block.id,
          date: child.getAttribute('date') as string,
          text: content ? textOf(content).trim().slice(0, 300) : '',
          done: checked,
          time: /^\d{2}:\d{2}$/.test(time) ? time : null,
          remind: /^\d{1,5}$/.test(remind) ? Number(remind) : null,
          remindBy: UUID_RE.test(by) ? by : null,
        });
      }
      if (name === 'blockContainer') {
        const first = child.get(0);
        visit(child, { id: String(child.getAttribute('id') ?? ''), content: first instanceof Y.XmlElement ? first : null });
      } else {
        visit(child, block);
      }
    }
  };
  visit(doc.getXmlFragment('document-store'), null);
  for (const row of doc.getArray<Y.Map<unknown>>('rows').toArray()) {
    const cells = row instanceof Y.Map ? row.get('cells') : null;
    if (cells instanceof Y.Map) collectFileIds(cells.toJSON(), out.files);
  }
  return out;
}

export interface FieldInfo {
  id: string;
  name: string;
  type: string;
  primary?: boolean;
  options?: { id: string; name: string; color: string; group?: 'todo' | 'doing' | 'done' }[];
  /** A select set up as a status, with its options in to-do / in progress / complete groups. */
  status?: boolean;
}

/** The select property that holds a card's status (a status property, one named like "Status", else the first select). */
export function statusFieldOf(fields: FieldInfo[]): FieldInfo | undefined {
  return (
    fields.find((f) => f.type === 'select' && f.status) ??
    fields.find((f) => f.type === 'select' && /status|stage|state/i.test(f.name)) ??
    fields.find((f) => f.type === 'select')
  );
}

/** Whether a status option means done: its group for status properties, else its name. */
export function isDoneOption(field: FieldInfo, option: { name: string; group?: string }): boolean {
  return field.status ? option.group === 'done' : DONE_STATUS.test(option.name);
}

export function fieldsOf(doc: Y.Doc): FieldInfo[] {
  return doc
    .getArray<Y.Map<unknown>>('fields')
    .toArray()
    .filter((f) => f instanceof Y.Map)
    .map((f) => f.toJSON() as FieldInfo);
}

/** Whether a card counts as done under its repeat rule. */
export function isRowDone(rule: RepeatRule, cells: Record<string, unknown>): boolean {
  if (!rule.statusField) return false;
  const v = cells[rule.statusField];
  return rule.doneValue === undefined ? v === true : v === rule.doneValue;
}

/** When a repeating card next needs resetting. */
export function nextReset(rule: RepeatRule, cells: Record<string, unknown>): string | null {
  if (rule.when === 'done') return isRowDone(rule, cells) ? today() : null;
  const current = rule.dateField ? cells[rule.dateField] : null;
  if (!isDate(current)) return rule.start;
  return nextAfter(rule, current);
}

async function replaceRefs(table: string, column: string, pageId: string, row: string, ids: string[], ownerTable: string) {
  await query(`delete from ${table} where page_id = $1 and row_id = $2 and not (${column} = any($3::uuid[]))`, [pageId, row, ids]);
  if (!ids.length) return;
  await query(
    `insert into ${table} (${column}, page_id, row_id)
     select o.id, $1, $2 from ${ownerTable} o
      where o.id = any($3::uuid[]) and o.workspace_id = (select workspace_id from pages where id = $1)
     on conflict do nothing`,
    [pageId, row, ids],
  );
}

/** Status names that mean a card is finished. */
export const DONE_STATUS = /\b(done|complete|completed|finished|closed|resolved)\b/i;

export interface IndexOptions {
  /** Who made the change (for "finished today"). */
  editor?: string | null;
  /** Record tasks that became done (off when rebuilding the index). */
  log?: boolean;
}

/** Notes tasks that were just finished (or un-finished) today. */
async function logCompletions(pageId: string, changes: { key: string; title: string; done: boolean }[], editor: string | null) {
  if (!changes.length) return;
  const ws = await one<{ workspace_id: string }>('select workspace_id from pages where id = $1', [pageId]);
  if (!ws) return;
  const day = today();
  for (const ch of changes) {
    if (ch.done) {
      await query(
        `insert into task_completions (workspace_id, key, title, user_id, completed_on) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, key, completed_on) do update set title = excluded.title, user_id = coalesce(excluded.user_id, task_completions.user_id)`,
        [ws.workspace_id, ch.key, ch.title.slice(0, 300), editor, day],
      );
    } else {
      await query('delete from task_completions where workspace_id = $1 and key = $2 and completed_on = $3', [ws.workspace_id, ch.key, day]);
    }
  }
}

/** Replaces everything recorded for one document. */
export async function updateDocIndex(pageId: string, rowId: string | null, doc: Y.Doc, opts: IndexOptions = {}) {
  // Card templates' bodies (row ids starting "tpl_") aren't real cards: nothing in them is listed.
  if (rowId?.startsWith('tpl_')) return;
  // Synced blocks ("sync_") keep their attachments, events and whiteboards listed, but not dates or mentions.
  const synced = !!rowId?.startsWith('sync_');
  const log = opts.log ?? true;
  const editor = opts.editor ?? null;
  const row = rowId ?? '';
  const c = contentsOf(doc);
  await replaceRefs('file_refs', 'file_id', pageId, row, [...c.files], 'files');
  await replaceRefs('event_refs', 'event_id', pageId, row, [...c.events], 'events');
  for (const [eventId, blockId] of c.eventBlocks) {
    await query('update event_refs set block_id = $4 where event_id = $1 and page_id = $2 and row_id = $3 and block_id is distinct from $4', [eventId, pageId, row, blockId]);
  }
  await replaceRefs('board_refs', 'board_id', pageId, row, [...c.boards], 'whiteboards');
  await query('delete from page_links where source_page = $1 and source_row = $2', [pageId, row]);
  if (c.links.size) {
    await query(
      `insert into page_links (source_page, source_row, target_page)
       select $1, $2, p.id from pages p where p.id = any($3::uuid[]) and p.id <> $1 on conflict do nothing`,
      [pageId, row, [...c.links]],
    );
  }
  if (synced) return;

  const before = new Map(
    (await query<{ block_id: string; done: boolean | null }>('select block_id, bool_or(done) as done from block_dates where page_id = $1 and row_id = $2 group by block_id', [pageId, row])).map(
      (r) => [r.block_id, r.done],
    ),
  );
  await query('delete from block_dates where page_id = $1 and row_id = $2', [pageId, row]);
  // Dated to-do items that were ticked or unticked since the last save.
  const changes = new Map<string, { key: string; title: string; done: boolean }>();
  for (const d of c.dates) {
    const was = before.get(d.blockId);
    if (d.done === null || was === undefined || was === null || was === d.done) continue;
    changes.set(d.blockId, { key: `block:${pageId}:${row}:${d.blockId}`, title: d.text, done: d.done });
  }
  if (log) await logCompletions(pageId, [...changes.values()], editor);
  const seen = new Set<string>();
  for (const d of c.dates) {
    const key = `${d.blockId}|${d.date}`;
    if (!d.blockId || seen.has(key)) continue;
    seen.add(key);
    await query(
      `insert into block_dates (page_id, row_id, block_id, date, text, done, time, remind, remind_by)
       select $1, $2, $3, $4, $5, $6, $7, $8, (select id from users where id = $9) on conflict do nothing`,
      [pageId, row, d.blockId, d.date, d.text, d.done, d.time, d.remind, d.remindBy],
    );
  }

  if (rowId === null) await indexDatabase(pageId, doc, log, editor);
  await noticeMentions(pageId, rowId, doc, { editor, log });
}

/** For a database page: each card's dates (for the calendar) and repeat rule (for resets). */
async function indexDatabase(pageId: string, doc: Y.Doc, log: boolean, editor: string | null) {
  const fields = fieldsOf(doc);
  const before = new Map(
    (await query<{ row_id: string; done: boolean | null }>('select row_id, bool_or(done) as done from row_dates where page_id = $1 group by row_id', [pageId])).map((r) => [
      r.row_id,
      r.done,
    ]),
  );
  const changes: { key: string; title: string; done: boolean }[] = [];
  await query('delete from row_dates where page_id = $1', [pageId]);
  if (!fields.length) {
    await query('delete from row_repeats where page_id = $1', [pageId]);
    await query('delete from row_people where page_id = $1', [pageId]);
    return;
  }
  const personFields = fields.filter((f) => f.type === 'person');
  const people: { rowId: string; userId: string; title: string; status: string | null; color: string | null; done: boolean | null; due: string | null }[] = [];
  const dateFields = fields.filter((f) => f.type === 'date');
  const primary = fields.find((f) => f.primary) ?? fields[0];
  const views = doc
    .getArray<Y.Map<unknown>>('views')
    .toArray()
    .filter((v) => v instanceof Y.Map)
    .map((v) => ({ dateField: v.get('dateField') as string | null, endField: v.get('endField') as string | null }));
  // A date used as another date's end (timeline) is shown as part of that span, not on its own.
  const endFor = new Map<string, string>();
  for (const v of views) if (v.dateField && v.endField) endFor.set(v.dateField, v.endField);
  const ends = new Set(endFor.values());
  const statusField = statusFieldOf(fields);

  const repeats: { rowId: string; rule: RepeatRule; next: string | null }[] = [];
  for (const r of doc.getArray<Y.Map<unknown>>('rows').toArray()) {
    if (!(r instanceof Y.Map)) continue;
    const rowId = String(r.get('id'));
    const cellsMap = r.get('cells');
    const cells = cellsMap instanceof Y.Map ? (cellsMap.toJSON() as Record<string, unknown>) : {};
    const rule = r.get('repeat');
    const title = typeof cells[primary.id] === 'string' ? (cells[primary.id] as string).trim() : '';
    const statusId = statusField ? cells[statusField.id] : null;
    const option = statusField?.options?.find((o) => o.id === statusId);
    const done = validRule(rule) && rule.statusField ? isRowDone(rule, cells) : option && statusField ? isDoneOption(statusField, option) : null;
    const was = before.get(rowId);
    if (done !== null && was !== undefined && was !== null && was !== done) changes.push({ key: `card:${pageId}:${rowId}`, title, done });
    for (const f of dateFields) {
      if (ends.has(f.id) || !isDate(cells[f.id])) continue;
      const endId = endFor.get(f.id);
      const end = endId && isDate(cells[endId]) && (cells[endId] as string) >= (cells[f.id] as string) ? (cells[endId] as string) : null;
      await query(
        `insert into row_dates (page_id, row_id, field_id, field_name, date, end_date, title, status, status_color, done) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict do nothing`,
        [pageId, rowId, f.id, f.name, cells[f.id], end, title.slice(0, 300), option?.name ?? null, option?.color ?? null, done],
      );
    }
    if (validRule(rule)) repeats.push({ rowId, rule, next: nextReset(rule, cells) });
    const assigned = new Set(personFields.flatMap((f) => (Array.isArray(cells[f.id]) ? (cells[f.id] as unknown[]).map(String) : [])).filter((id) => UUID_RE.test(id)));
    const due = dateFields.map((f) => cells[f.id]).find(isDate) ?? null;
    for (const userId of assigned) people.push({ rowId, userId, title, status: option?.name ?? null, color: option?.color ?? null, done, due });
  }

  await pruneRowRefs(pageId, liveRowIds(doc));
  if (log) await logCompletions(pageId, changes, editor);
  await indexPeople(pageId, people, log, editor);
  await runAutomations(pageId, doc, fields, log, editor).catch((err) => console.error('Automations failed', pageId, err));

  const ids = repeats.map((r) => r.rowId);
  await query('delete from row_repeats where page_id = $1 and not (row_id = any($2::text[]))', [pageId, ids]);
  for (const r of repeats) {
    await query(
      `insert into row_repeats (page_id, row_id, rule, next_reset) values ($1, $2, $3, $4)
       on conflict (page_id, row_id) do update set rule = excluded.rule, next_reset = excluded.next_reset`,
      [pageId, r.rowId, JSON.stringify(r.rule), r.next],
    );
  }
}

function liveRowIds(doc: Y.Doc): string[] {
  return doc
    .getArray<Y.Map<unknown>>('rows')
    .toArray()
    .filter((r) => r instanceof Y.Map)
    .map((r) => String(r.get('id')));
}

/**
 * Forgets the events, files and whiteboards listed for cards that were deleted from a database, so
 * they no longer count as "in a page" (templates and synced blocks aren't cards and are kept).
 */
async function pruneRowRefs(pageId: string, rowIds: string[]) {
  for (const table of ['event_refs', 'file_refs', 'board_refs']) {
    await query(
      `delete from ${table} where page_id = $1 and row_id <> '' and row_id not like 'tpl\\_%' and row_id not like 'sync\\_%'
          and not (row_id = any($2::text[]))`,
      [pageId, rowIds],
    );
  }
}

/** Checks every database in a workspace for cards that were deleted but are still listed. */
export async function pruneWorkspaceRowRefs(workspaceId: string) {
  const pages = await query<{ id: string }>(
    `select distinct r.page_id as id from event_refs r join pages p on p.id = r.page_id
      where p.workspace_id = $1 and r.row_id <> ''`,
    [workspaceId],
  );
  for (const p of pages) {
    const ids = await readDoc(p.id, null, (doc) => (doc.getArray('rows').length || doc.getArray('fields').length ? liveRowIds(doc) : null));
    if (ids) await pruneRowRefs(p.id, ids);
  }
}

/** Who each card is assigned to; people newly assigned are told. */
async function indexPeople(
  pageId: string,
  people: { rowId: string; userId: string; title: string; status: string | null; color: string | null; done: boolean | null; due: string | null }[],
  log: boolean,
  editor: string | null,
) {
  const before = new Set((await query<{ key: string }>(`select row_id || ':' || user_id as key from row_people where page_id = $1`, [pageId])).map((r) => r.key));
  await query('delete from row_people where page_id = $1', [pageId]);
  const fresh: typeof people = [];
  for (const p of people) {
    const added = await query(
      `insert into row_people (page_id, row_id, user_id, title, status, status_color, done, due)
       select $1, $2, u.id, $4, $5, $6, $7, $8 from users u where u.id = $3 on conflict do nothing returning user_id`,
      [pageId, p.rowId, p.userId, p.title.slice(0, 300), p.status, p.color, p.done, p.due],
    );
    if (added.length && !before.has(`${p.rowId}:${p.userId}`)) fresh.push(p);
  }
  if (!log || !fresh.length) return;
  const page = await one<{ workspace_id: string; title: string }>('select workspace_id, title from pages where id = $1', [pageId]);
  if (!page) return;
  const by = editor ? (await one<{ name: string }>('select name from users where id = $1', [editor]))?.name : null;
  for (const p of fresh) {
    if (p.userId === editor) continue;
    await notify(p.userId, {
      kind: 'assigned',
      title: `${by ?? 'Someone'} assigned you to “${p.title || 'Untitled'}”`,
      body: `In ${page.title || 'Untitled'}${p.due ? ` · due ${p.due}` : ''}`,
      link: `/w/${page.workspace_id}/p/${pageId}?row=${pageId}:${p.rowId}`,
    });
  }
}

/**
 * Bump when what the index records changes, so the next start-up rebuilds all of it. Saving a document
 * always updates its index, so otherwise start-up only needs the documents changed since the last run
 * (by an import, a restore, a script): usually none.
 */
const INDEX_VERSION = 1;

/** Brings the indexes up to date at start-up: everything after an upgrade, otherwise only what changed. */
export async function backfillDocIndex() {
  const started = (await one<{ now: string }>('select now()::text as now'))!.now;
  const last = await one<{ value: { version?: number; at?: string } }>(`select value from settings where key = 'doc_index'`);
  const since = last?.value?.version === INDEX_VERSION && last.value.at ? last.value.at : null;
  const count = await rebuildDocIndex(since);
  await query(
    `insert into settings (key, value) values ('doc_index', $1::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify({ version: INDEX_VERSION, at: started })],
  );
  return count;
}

/** Indexes every document changed after `since` (all of them when null); returns how many. */
async function rebuildDocIndex(since: string | null) {
  const after = since ? 'where updated_at > $1' : '';
  const args = since ? [since] : [];
  const pages = await query<{ page_id: string; state: Buffer }>(`select page_id, state from page_content ${after}`, args);
  const rows = await query<{ page_id: string; row_id: string; state: Buffer }>(`select page_id, row_id, state from row_documents ${after}`, args);
  const all = [...pages.map((p) => ({ ...p, row_id: null as string | null })), ...rows];
  for (const r of all) {
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(r.state));
      await updateDocIndex(r.page_id, r.row_id, doc, { log: false });
      doc.destroy();
    } catch {
      // A corrupt or foreign document; skip it.
    }
  }
  return all.length;
}
