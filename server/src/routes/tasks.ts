import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import { accessMap, atLeast, hiddenEvents, requireMember, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { databaseRows, editDoc, readDoc } from '../blocks.js';
import { query } from '../db.js';
import { DONE_STATUS, fieldsOf, isRowDone, statusFieldOf } from '../docIndex.js';
import { addDays, isDate, today, validRule } from '../repeat.js';
import { currentChoice, keepsMissedDays, lastDay, type PathChoice, pathCards, type Paths, type PathState } from '../paths.js';
import { HttpError, idParams, parse } from '../util.js';

// The daily task list: everything with a done/not-done state that falls on a day — calendar events
// marked as tasks, dated cards that have a status, and to-do items with a date typed in them — plus
// what was finished that day.

/** How far back unfinished tasks are still listed as overdue. */
const OVERDUE_DAYS = 30;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');

export interface Task {
  key: string;
  kind: 'event' | 'card' | 'block';
  title: string;
  /** The day it's due (the start of a span). */
  date: string;
  endDate: string | null;
  time: string | null;
  done: boolean;
  overdue: boolean;
  status: string | null;
  color: string | null;
  eventId?: string;
  pageId?: string;
  rowId?: string | null;
  blockId?: string;
  pageTitle?: string;
  pageIcon?: string;
  pageType?: string;
  rowTitle?: string | null;
  /** Cards: the date property the task comes from. */
  fieldId?: string;
  fieldName?: string;
  /** Events with paths: whether there's a choice to make, and today's (null until chosen). */
  paths?: boolean;
  choice?: Pick<PathChoice, 'labels' | 'step'> | null;
  /** A task that keeps missed days and is done up to today: it's on a day ahead, and can go on. */
  ahead?: boolean;
  /** Its last finished day can be taken back. */
  canUndo?: boolean;
  /** The path of the last day ticked off. */
  last?: { date: string; labels: string[]; step: PathChoice['step'] } | null;
}

function choiceOf(state: PathState | null, date: string) {
  const c = currentChoice(state, date);
  return c ? { labels: c.labels, step: c.step } : null;
}

/** Every task due on `day` (and the unfinished ones from before it) that this person can see. */
export async function tasksFor(userId: string, workspaceId: string, day: string): Promise<Task[]> {
  const access = await accessMap(userId, workspaceId);
  const visible = (pageId: string) => (access.get(pageId) ?? 'none') !== 'none';
  const since = addDays(day, -OVERDUE_DAYS);
  const tasks: Task[] = [];
  const inPath = await pathCards(workspaceId);
  const pathCard = (pageId: string, rowId: string | null | undefined) => !!rowId && inPath.has(`${pageId}:${rowId}`);

  const events = await query<{ id: string; title: string; start: string; end: string | null; time: string | null; status: string; color: string; hasPaths: boolean; pathState: PathState | null; paths: Paths | null; repeat: unknown }>(
    `select id, title, to_char(start_date, 'YYYY-MM-DD') as start, to_char(end_date, 'YYYY-MM-DD') as "end", start_time as time, status, color,
            paths is not null as "hasPaths", path_state as "pathState", paths, repeat
       from events
      where workspace_id = $1 and status is not null
        and ((start_date <= $2 and coalesce(end_date, start_date) >= $2)
          or (status <> 'done' and coalesce(end_date, start_date) between $3 and $2)
          -- Repeating tasks with paths stay listed however many days behind or ahead they are.
          or (paths is not null and repeat is not null))
      order by start_time nulls first, title`,
    [workspaceId, day, since],
  );
  // Where each event sits in a page or card (the first place this person can see), to jump straight to it.
  const placed = new Map<string, { pageId: string; rowId: string; blockId: string | null; pageTitle: string; pageIcon: string; pageType: string }>();
  const hidden = new Set<string>();
  if (events.length) {
    const refs = await query<{ eventId: string; pageId: string; rowId: string; blockId: string | null; pageTitle: string; pageIcon: string; pageType: string }>(
      `select r.event_id as "eventId", r.page_id as "pageId", r.row_id as "rowId", r.block_id as "blockId", p.title as "pageTitle", p.icon as "pageIcon", p.type as "pageType"
         from event_refs r join pages p on p.id = r.page_id and p.deleted_at is null
        where r.event_id = any($1::uuid[])
        order by r.block_id is null, p.created_at`,
      [events.map((e) => e.id)],
    );
    for (const r of refs) if (visible(r.pageId) && !placed.has(r.eventId)) placed.set(r.eventId, r);
    // Tasks inside a card that's a step of a path come up through the path instead.
    for (const r of refs) if (pathCard(r.pageId, r.rowId)) hidden.add(r.eventId);
  }
  const rowTitles = new Map<string, Map<string, string>>();
  const rowTitle = async (pageId: string, rowId: string) => {
    if (!rowTitles.has(pageId)) rowTitles.set(pageId, new Map((await readDoc(pageId, null, databaseRows)).map((r) => [r.id, r.title])));
    return rowTitles.get(pageId)!.get(rowId) ?? null;
  };
  // Events placed only on pages this person can't open aren't theirs to see.
  const restricted = await hiddenEvents(userId, workspaceId, events.map((e) => e.id), access);
  for (const e of events) {
    if (restricted.has(e.id)) continue;
    if (hidden.has(e.id) && !e.hasPaths) continue;
    const catchUp = keepsMissedDays(e);
    const ahead = catchUp && e.start > day;
    const usual = (e.start <= day && (e.end ?? e.start) >= day) || (e.status !== 'done' && (e.end ?? e.start) >= since && (e.end ?? e.start) <= day);
    // A task that keeps missed days is listed however far behind it is, and ahead once it's caught up.
    if (!usual && !(catchUp && (ahead ? !!e.pathState?.history?.length : e.status !== 'done'))) continue;
    const last = e.end ?? e.start;
    const at = placed.get(e.id);
    tasks.push({
      ...(at
        ? {
            pageId: at.pageId,
            rowId: at.rowId || null,
            blockId: at.blockId ?? undefined,
            pageTitle: at.pageTitle,
            pageIcon: at.pageIcon,
            pageType: at.pageType,
            rowTitle: at.rowId ? await rowTitle(at.pageId, at.rowId) : null,
          }
        : {}),
      key: `event:${e.id}`,
      kind: 'event',
      title: e.title || 'Untitled task',
      date: e.start,
      endDate: e.end,
      time: e.time,
      done: e.status === 'done',
      overdue: e.status !== 'done' && last < day,
      status: e.status,
      color: e.color,
      eventId: e.id,
      ...(e.hasPaths ? { paths: true, choice: choiceOf(e.pathState, e.start), ahead, canUndo: !!e.pathState?.history?.length, last: lastDay(e.pathState) } : {}),
    });
  }

  const cards = await query<{ pageId: string; rowId: string; fieldId: string; fieldName: string; title: string; date: string; end: string | null; status: string | null; color: string | null; done: boolean; pageTitle: string; pageIcon: string; pageType: string }>(
    `select d.page_id as "pageId", d.row_id as "rowId", d.field_id as "fieldId", d.field_name as "fieldName", d.title, to_char(d.date, 'YYYY-MM-DD') as date, to_char(d.end_date, 'YYYY-MM-DD') as "end",
            d.status, d.status_color as color, d.done, p.title as "pageTitle", p.icon as "pageIcon", p.type as "pageType"
       from row_dates d join pages p on p.id = d.page_id and p.deleted_at is null and p.workspace_id = $1
      where d.done is not null
        and ((d.date <= $2 and coalesce(d.end_date, d.date) >= $2)
          or (not d.done and coalesce(d.end_date, d.date) between $3 and $2))`,
    [workspaceId, day, since],
  );
  // A card with several dates is one task.
  const seenCards = new Set<string>();
  for (const c of cards) {
    const key = `card:${c.pageId}:${c.rowId}`;
    if (!visible(c.pageId) || seenCards.has(key) || pathCard(c.pageId, c.rowId)) continue;
    seenCards.add(key);
    const last = c.end ?? c.date;
    tasks.push({
      key,
      kind: 'card',
      title: c.title || 'Untitled card',
      date: c.date,
      endDate: c.end,
      time: null,
      done: c.done,
      overdue: !c.done && last < day,
      status: c.status,
      color: c.color,
      pageId: c.pageId,
      rowId: c.rowId,
      fieldId: c.fieldId,
      fieldName: c.fieldName,
      pageTitle: c.pageTitle,
      pageIcon: c.pageIcon,
      pageType: c.pageType,
    });
  }

  const blocks = await query<{ pageId: string; rowId: string; blockId: string; text: string; date: string; done: boolean; pageTitle: string; pageIcon: string; pageType: string }>(
    `select b.page_id as "pageId", b.row_id as "rowId", b.block_id as "blockId", b.text, to_char(min(b.date), 'YYYY-MM-DD') as date, bool_or(b.done) as done,
            p.title as "pageTitle", p.icon as "pageIcon", p.type as "pageType"
       from block_dates b join pages p on p.id = b.page_id and p.deleted_at is null and p.workspace_id = $1
      where b.done is not null and (b.date = $2 or (not b.done and b.date between $3 and $2))
      group by b.page_id, b.row_id, b.block_id, b.text, p.title, p.icon, p.type`,
    [workspaceId, day, since],
  );
  for (const b of blocks) {
    if (!visible(b.pageId) || pathCard(b.pageId, b.rowId)) continue;
    let rowTitle: string | null = null;
    if (b.rowId) {
      if (!rowTitles.has(b.pageId)) rowTitles.set(b.pageId, new Map((await readDoc(b.pageId, null, databaseRows)).map((r) => [r.id, r.title])));
      rowTitle = rowTitles.get(b.pageId)!.get(b.rowId) ?? null;
      if (rowTitle === null) continue; // the card was deleted
    }
    tasks.push({
      key: `block:${b.pageId}:${b.rowId}:${b.blockId}`,
      kind: 'block',
      title: b.text || 'Untitled to-do',
      date: b.date,
      endDate: null,
      time: null,
      done: b.done,
      overdue: !b.done && b.date < day,
      status: null,
      color: null,
      pageId: b.pageId,
      rowId: b.rowId || null,
      blockId: b.blockId,
      pageTitle: b.pageTitle,
      pageIcon: b.pageIcon,
      pageType: b.pageType,
      rowTitle,
    });
  }

  // Overdue first (oldest first), then today's by time.
  return tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title));
}

/** Ticks a card off (sets its status to a "done" option) or reopens it. */
export function setCardDone(doc: Y.Doc, rowId: string, done: boolean): boolean {
  const row = doc.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === rowId);
  const cells = row?.get('cells');
  if (!row || !(cells instanceof Y.Map)) return false;
  const fields = fieldsOf(doc);
  const rule = row.get('repeat');
  // A repeating card says which value means done and what to go back to.
  if (validRule(rule) && rule.statusField) {
    if (done) cells.set(rule.statusField, rule.doneValue ?? true);
    else if (rule.resetTo === undefined || rule.resetTo === null) cells.delete(rule.statusField);
    else cells.set(rule.statusField, rule.resetTo);
    if (isRowDone(rule, cells.toJSON()) !== done) return false;
  } else {
    const field = statusFieldOf(fields);
    if (!field?.options?.length) throw new HttpError(400, 'This card has no status to change');
    const option = field.status
      ? field.options.find((o) => (done ? o.group === 'done' : (o.group ?? 'todo') === 'todo'))
      : done
      ? field.options.find((o) => DONE_STATUS.test(o.name))
      : (field.options.find((o) => /\b(to ?do|not started|open|backlog)\b/i.test(o.name)) ?? field.options.find((o) => !DONE_STATUS.test(o.name)));
    if (!option) throw new HttpError(400, done ? 'Add a “Done” status to this database to tick cards off' : 'This card has no status to go back to');
    cells.set(field.id, option.id);
  }
  row.set('updatedAt', Date.now());
  return true;
}

/** Ticks a to-do item off or reopens it. */
function setBlockDone(doc: Y.Doc, blockId: string, done: boolean): boolean {
  const find = (node: Y.XmlElement | Y.XmlFragment): Y.XmlElement | null => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'blockContainer' && child.getAttribute('id') === blockId) {
        const content = child.get(0);
        return content instanceof Y.XmlElement && content.nodeName === 'checkListItem' ? content : null;
      }
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const item = find(doc.getXmlFragment('document-store'));
  if (!item) return false;
  item.setAttribute('checked', done as unknown as string);
  return true;
}

export async function taskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** The day's tasks, plus everything finished that day. `date` is the person's own today. */
  app.get('/workspaces/:id/tasks', async (req) => {
    const { id } = parse(idParams, req.params);
    const { date: day } = parse(z.object({ date: date.optional() }), req.query);
    await requireMember(req.user.id, id);
    const on = day && isDate(day) ? day : today();
    const tasks = await tasksFor(req.user.id, id, on);
    const finished = await query<{ key: string; title: string; userId: string | null; userName: string | null; completedAt: string }>(
      `select c.key, c.title, c.user_id as "userId", u.name as "userName", c.completed_at as "completedAt"
         from task_completions c left join users u on u.id = c.user_id
        where c.workspace_id = $1 and c.completed_on = $2
        order by c.completed_at`,
      [id, on],
    );
    // Only list finished things this person can still see.
    const access = await accessMap(req.user.id, id);
    const canSee = (key: string) => {
      const [kind, pageId] = key.split(':');
      return kind === 'event' || (access.get(pageId) ?? 'none') !== 'none';
    };
    return { date: on, tasks, finished: finished.filter((f) => canSee(f.key)) };
  });

  /** Cards assigned to this person (person properties) in the workspace, open ones first. */
  app.get('/workspaces/:id/my-tasks', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const rows = await query<{ pageId: string; rowId: string; title: string; status: string | null; statusColor: string | null; done: boolean | null; due: string | null; database: string; icon: string }>(
      `select r.page_id as "pageId", r.row_id as "rowId", r.title, r.status, r.status_color as "statusColor", r.done,
              to_char(r.due, 'YYYY-MM-DD') as due, p.title as database, p.icon
         from row_people r join pages p on p.id = r.page_id
        where r.user_id = $1 and p.workspace_id = $2 and p.deleted_at is null
        order by coalesce(r.done, false), r.due nulls last, r.title`,
      [req.user.id, id],
    );
    const access = await accessMap(req.user.id, id);
    return { tasks: rows.filter((r) => (access.get(r.pageId) ?? 'none') !== 'none').map((r) => ({ ...r, key: `card:${r.pageId}:${r.rowId}` })) };
  });

  /** Ticks a card or to-do item off (events are changed through their own route). */
  app.post('/workspaces/:id/tasks/done', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ key: z.string().max(300), done: z.boolean() }), req.body);
    await requireMember(req.user.id, id);
    const [kind, pageId, rowId = '', blockId] = body.key.split(':');
    if (!z.uuid().safeParse(pageId).success || (kind !== 'card' && kind !== 'block')) throw new HttpError(400, 'Unknown task');
    const page = await requirePage(req.user.id, pageId, 'edit');
    if (page.workspace_id !== id) throw new HttpError(404, 'Task not found');
    if (!atLeast(page.access, 'edit')) throw new HttpError(403, "You can't change this page");
    const ok =
      kind === 'card'
        ? await editDoc(pageId, null, (doc) => setCardDone(doc, rowId, body.done), { editor: req.user.id })
        : await editDoc(pageId, rowId || null, (doc) => setBlockDone(doc, blockId ?? '', body.done), { editor: req.user.id });
    if (!ok) throw new HttpError(404, 'Task not found');
    return { ok: true };
  });
}
