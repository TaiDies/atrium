import * as Y from 'yjs';
import { z } from 'zod';
import { accessMap } from './access.js';
import { editDoc, readDoc } from './blocks.js';
import { one, query } from './db.js';
import { type FieldInfo, fieldsOf, isDoneOption, isRowDone, statusFieldOf } from './docIndex.js';
import { validRule } from './repeat.js';
import { setCardDone } from './routes/tasks.js';
import { HttpError } from './util.js';

// Tasks with paths: a task can ask a question ("Psychology or geography?"), each answer can ask
// another ("Book 1 or book 2?"), and the last answer leads to steps worked through in order — typed
// steps, or the cards of a database (filtered and sorted). Each day you pick a path and get its next
// unfinished step; ticking the task off finishes that step (a card is set to done, its own tasks are
// ticked and, if chosen, the day is written into one of its dates). Unticking puts it all back.

export interface PathSource {
  /** The database whose cards are the steps. */
  pageId: string;
  /** Only cards whose property has one of these values (select options, or exact text). */
  filters: { fieldId: string; values: string[] }[];
  /** The property to put the cards in order by (the database's own order if none). */
  sortField: string | null;
  /** A date property to fill with the day each card was finished. */
  dateField: string | null;
}

export interface PathOption {
  id: string;
  label: string;
  /** With options: the question asked once this answer is picked. */
  question?: string;
  options?: PathOption[];
  /** Without options: the steps of this path, typed in… */
  steps?: { id: string; title: string }[];
  /** …or the cards of a database. */
  source?: PathSource | null;
}

export interface Paths {
  question: string;
  options: PathOption[];
}

export type PathStep = { kind: 'step'; id: string; title: string } | { kind: 'card'; pageId: string; rowId: string; title: string };

export interface PathChoice {
  /** The task's date this choice is for: a new day (a repeat) asks again. */
  date: string;
  trail: string[];
  labels: string[];
  step: PathStep | null;
  /** What ticking the task off changed, to put back if it's unticked. */
  applied?: { events: string[]; status: boolean; dateField: string | null; prevDate: unknown } | null;
}

export interface PathState {
  /** Typed steps that are finished, and cards finished in databases with no status. */
  done: string[];
  today: PathChoice | null;
}

const id = z.string().min(1).max(64);
const source = z.object({
  pageId: z.uuid(),
  filters: z.array(z.object({ fieldId: id, values: z.array(z.string().max(500)).max(50) })).max(10),
  sortField: id.nullable(),
  dateField: id.nullable(),
});
const option: z.ZodType<PathOption> = z.lazy(() =>
  z.object({
    id,
    label: z.string().max(200),
    question: z.string().max(300).optional(),
    options: z.array(option).max(20).optional(),
    steps: z.array(z.object({ id, title: z.string().max(500) })).max(1000).optional(),
    source: source.nullable().optional(),
  }),
);
export const pathsSchema = z.object({ question: z.string().max(300), options: z.array(option).min(1).max(20) }).nullable();

function depth(o: PathOption): number {
  return 1 + Math.max(0, ...(o.options ?? []).map(depth));
}

export function checkPaths(paths: Paths | null) {
  if (paths && Math.max(...paths.options.map(depth)) > 6) throw new HttpError(400, 'Paths can be at most 6 questions deep');
}

/** The answers along a trail of option ids, or null if one no longer exists. */
function walk(paths: Paths, trail: string[]): PathOption[] | null {
  const out: PathOption[] = [];
  let options = paths.options;
  for (const step of trail) {
    const o = options.find((x) => x.id === step);
    if (!o) return null;
    out.push(o);
    options = o.options ?? [];
  }
  return out;
}

const isLeaf = (o: PathOption) => !o.options?.length;

function leaves(options: PathOption[], out: PathOption[] = []): PathOption[] {
  for (const o of options) {
    if (isLeaf(o)) out.push(o);
    else leaves(o.options!, out);
  }
  return out;
}

const cardKey = (pageId: string, rowId: string) => `${pageId}:${rowId}`;

function sortValue(field: FieldInfo | undefined, v: unknown): number | string {
  if (v === undefined || v === null || v === '') return '￿';
  if (typeof v === 'number') return v;
  if (field?.options && typeof v === 'string') {
    const i = field.options.findIndex((o) => o.id === v);
    if (i >= 0) return i;
  }
  return typeof v === 'string' ? v.toLowerCase() : JSON.stringify(v);
}

function matches(field: FieldInfo | undefined, v: unknown, values: string[]): boolean {
  if (!values.length) return true;
  const list = Array.isArray(v) ? v : [v];
  return list.some((x) => {
    if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') return false;
    const s = String(x);
    // Select values are option ids; the names work too, so a path written by hand or by the AI can use them.
    const name = field?.options?.find((o) => o.id === s)?.name;
    return values.some((want) => want === s || (name !== undefined && want.toLowerCase() === name.toLowerCase()));
  });
}

/** The cards of a source in order, each with whether it's finished. */
async function sourceCards(src: PathSource, done: Set<string>) {
  return readDoc(src.pageId, null, (doc) => {
    const fields = fieldsOf(doc);
    const primary = fields.find((f) => f.primary) ?? fields[0];
    const status = statusFieldOf(fields);
    const sortField = fields.find((f) => f.id === src.sortField);
    const cards: { rowId: string; title: string; done: boolean; sort: number | string; at: number }[] = [];
    doc
      .getArray<Y.Map<unknown>>('rows')
      .toArray()
      .forEach((r, at) => {
        if (!(r instanceof Y.Map)) return;
        const rowId = String(r.get('id'));
        const cellsMap = r.get('cells');
        const cells = cellsMap instanceof Y.Map ? (cellsMap.toJSON() as Record<string, unknown>) : {};
        if (!src.filters.every((f) => matches(fields.find((x) => x.id === f.fieldId), cells[f.fieldId], f.values))) return;
        const rule = r.get('repeat');
        const option = status?.options?.find((o) => o.id === cells[status.id]);
        const finished =
          validRule(rule) && rule.statusField ? isRowDone(rule, cells) : status?.options?.length ? !!option && isDoneOption(status, option) : done.has(cardKey(src.pageId, rowId));
        const title = primary && typeof cells[primary.id] === 'string' && (cells[primary.id] as string).trim() ? (cells[primary.id] as string).trim() : 'Untitled';
        cards.push({ rowId, title, done: finished, sort: src.sortField ? sortValue(sortField, cells[src.sortField]) : at, at });
      });
    return cards.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.at - b.at));
  });
}

/** How many steps are left on a path, and the next one. */
async function leafProgress(o: PathOption, state: PathState): Promise<{ total: number; left: number; next: PathStep | null }> {
  const done = new Set(state.done);
  if (o.source) {
    const page = await one<{ id: string }>(`select id from pages where id = $1 and deleted_at is null`, [o.source.pageId]);
    if (!page) return { total: 0, left: 0, next: null };
    const cards = await sourceCards(o.source, done);
    const open = cards.filter((c) => !c.done);
    return { total: cards.length, left: open.length, next: open[0] ? { kind: 'card', pageId: o.source.pageId, rowId: open[0].rowId, title: open[0].title } : null };
  }
  const steps = o.steps ?? [];
  const open = steps.filter((s) => !done.has(s.id));
  return { total: steps.length, left: open.length, next: open[0] ? { kind: 'step', id: open[0].id, title: open[0].title || 'Untitled step' } : null };
}

export const emptyState = (): PathState => ({ done: [], today: null });

interface EventPaths {
  id: string;
  workspaceId: string;
  startDate: string;
  status: string | null;
  paths: Paths | null;
  pathState: PathState | null;
}

async function loadEvent(eventId: string) {
  const e = await one<EventPaths>(
    `select id, workspace_id as "workspaceId", to_char(start_date, 'YYYY-MM-DD') as "startDate", status, paths, path_state as "pathState" from events where id = $1`,
    [eventId],
  );
  if (!e) throw new HttpError(404, 'Task not found');
  return e;
}

/** Today's choice, if it was made for the task's current date. */
export const currentChoice = (state: PathState | null, date: string) => (state?.today && state.today.date === date ? state.today : null);

/** The task's paths, today's choice and the progress of every path (counts, next step), for the picker. */
export async function pathsView(userId: string, eventId: string) {
  const e = await loadEvent(eventId);
  if (!e.paths) return { paths: null, choice: null, progress: {} };
  const state = e.pathState ?? emptyState();
  const access = await accessMap(userId, e.workspaceId);
  const progress: Record<string, { total: number; left: number; next: PathStep | null; hidden?: boolean }> = {};
  for (const leaf of leaves(e.paths.options)) {
    if (leaf.source && (access.get(leaf.source.pageId) ?? 'none') === 'none') {
      progress[leaf.id] = { total: 0, left: 0, next: null, hidden: true };
      continue;
    }
    progress[leaf.id] = await leafProgress(leaf, state).catch(() => ({ total: 0, left: 0, next: null }));
  }
  return { paths: e.paths, choice: currentChoice(state, e.startDate), progress };
}

/** Picks today's path (or clears the choice with null). */
export async function choosePath(userId: string, eventId: string, trail: string[] | null) {
  const e = await loadEvent(eventId);
  if (!e.paths) throw new HttpError(400, 'This task has no paths');
  if (e.status === 'done') throw new HttpError(400, 'This task is already done today. Untick it to choose again.');
  const state = e.pathState ?? emptyState();
  if (trail === null) state.today = null;
  else {
    const answers = walk(e.paths, trail);
    if (!answers?.length || !isLeaf(answers[answers.length - 1])) throw new HttpError(400, 'Choose an answer for every question');
    const leaf = answers[answers.length - 1];
    if (leaf.source) {
      const access = await accessMap(userId, e.workspaceId);
      if ((access.get(leaf.source.pageId) ?? 'none') === 'none') throw new HttpError(403, "You can't open this path's database");
    }
    const { next } = await leafProgress(leaf, state);
    state.today = { date: e.startDate, trail, labels: answers.map((a) => a.label), step: next, applied: null };
  }
  await query('update events set path_state = $2, updated_at = now() where id = $1', [eventId, JSON.stringify(state)]);
  return pathsView(userId, eventId);
}

/**
 * The task was ticked off or reopened: finish today's step, or put it back. Errors here (a deleted
 * card, a database with no status) don't stop the task itself from being ticked.
 */
export async function applyPathStep(eventId: string, done: boolean, editor: string) {
  const e = await loadEvent(eventId);
  const state = e.pathState;
  const choice = currentChoice(state, e.startDate);
  if (!e.paths || !state || !choice?.step) return;
  const step = choice.step;
  const leaf = walk(e.paths, choice.trail)?.at(-1);
  const key = step.kind === 'card' ? cardKey(step.pageId, step.rowId) : step.id;
  if (done && !choice.applied) {
    const applied: NonNullable<PathChoice['applied']> = { events: [], status: false, dateField: null, prevDate: null };
    if (step.kind === 'card') {
      // The card's own tasks are ticked too (not this one, if it sits in the card).
      const own = await query<{ id: string }>(
        `select e.id from event_refs r join events e on e.id = r.event_id
          where r.page_id = $1 and r.row_id = $2 and e.status is not null and e.status <> 'done' and e.id <> $3`,
        [step.pageId, step.rowId, eventId],
      );
      if (own.length) await query(`update events set status = 'done', updated_at = now() where id = any($1::uuid[])`, [own.map((x) => x.id)]);
      applied.events = own.map((x) => x.id);
      const dateField = leaf?.source?.pageId === step.pageId ? leaf.source.dateField : null;
      await editDoc(
        step.pageId,
        null,
        (doc) => {
          const row = doc.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === step.rowId);
          const cells = row?.get('cells');
          if (!(cells instanceof Y.Map)) return;
          if (dateField && fieldsOf(doc).some((f) => f.id === dateField && f.type === 'date')) {
            applied.dateField = dateField;
            applied.prevDate = cells.get(dateField) ?? null;
            cells.set(dateField, e.startDate);
          }
          try {
            applied.status = setCardDone(doc, step.rowId, true);
          } catch {
            // No status property: the path remembers it's finished instead.
          }
          row!.set('updatedAt', Date.now());
        },
        { editor },
      ).catch((err) => console.error('Could not finish a path card', err));
    }
    if (!state.done.includes(key)) state.done.push(key);
    choice.applied = applied;
  } else if (!done && choice.applied) {
    const applied = choice.applied;
    if (step.kind === 'card') {
      if (applied.events.length) await query(`update events set status = 'todo', updated_at = now() where id = any($1::uuid[]) and status = 'done'`, [applied.events]);
      await editDoc(
        step.pageId,
        null,
        (doc) => {
          const row = doc.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === step.rowId);
          const cells = row?.get('cells');
          if (!(cells instanceof Y.Map)) return;
          if (applied.dateField) {
            if (applied.prevDate === null) cells.delete(applied.dateField);
            else cells.set(applied.dateField, applied.prevDate);
          }
          if (applied.status) {
            try {
              setCardDone(doc, step.rowId, false);
            } catch {
              // Nothing to put back.
            }
          }
        },
        { editor },
      ).catch((err) => console.error('Could not reopen a path card', err));
    }
    state.done = state.done.filter((k) => k !== key);
    choice.applied = null;
  } else return;
  await query('update events set path_state = $2 where id = $1', [eventId, JSON.stringify(state)]);
}

/**
 * Every card that's a step of a path in the workspace ("pageId:rowId"). These show up through their
 * path's task, so the day's list doesn't also list them (or their own tasks) by their dates.
 */
export async function pathCards(workspaceId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const rows = await query<{ paths: Paths }>(`select paths from events where workspace_id = $1 and paths is not null and status is not null`, [workspaceId]);
  const seen = new Set<string>();
  for (const { paths } of rows) {
    for (const leaf of leaves(paths.options ?? [])) {
      if (!leaf.source) continue;
      const k = JSON.stringify(leaf.source);
      if (seen.has(k)) continue;
      seen.add(k);
      const page = await one<{ id: string }>(`select id from pages where id = $1 and deleted_at is null`, [leaf.source.pageId]);
      if (!page) continue;
      const cards = await sourceCards(leaf.source, new Set()).catch(() => []);
      for (const c of cards) out.add(cardKey(leaf.source.pageId, c.rowId));
    }
  }
  return out;
}
