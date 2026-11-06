import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { query } from '../db.js';
import { fieldsOf, isDoneOption, isRowDone, statusFieldOf } from '../docIndex.js';
import { keepsMissedDays, type Paths, type PathState } from '../paths.js';
import { addDays, isDate, occurrencesBetween, today, validRule } from '../repeat.js';
import { idParams, parse } from '../util.js';

// A page's stats, for its spreadsheet: everything on it that can be done — the cards of a database
// and the tasks and dated to-dos placed in the page or its cards — each with when it's due, whether
// it's done and when it was finished. Repeating tasks are listed once per day (up to today), so the
// sheet can show every day of a plan. The sheet itself groups them by day and works out early/late.

export interface StatItem {
  key: string;
  kind: 'card' | 'task' | 'todo';
  title: string;
  /** The day it's due (YYYY-MM-DD), if it has one. */
  date: string | null;
  time: string | null;
  done: boolean | null;
  /** When it was finished (ISO), when known. */
  doneAt: string | null;
  /** The card's status, as its option name. */
  status: string | null;
  /** For a day of a task with paths: the path taken and its step. */
  detail: string | null;
  /** A day of a task that repeats with no end. */
  forever: boolean;
}

export async function statsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/pages/:id/stats', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id);
    const day = today();
    const items: StatItem[] = [];
    const isDatabase = (DATABASE_TYPES as readonly string[]).includes(page.type);

    // When each thing was last finished, by its completion key.
    const finished = new Map<string, { at: string; on: string }[]>();
    const completions = await query<{ key: string; completed_at: Date; completed_on: string }>(
      `select key, completed_at, to_char(completed_on, 'YYYY-MM-DD') as completed_on from task_completions
        where workspace_id = $1 and (key like $2 or key like 'event:%') order by completed_at`,
      [page.workspace_id, `%${id}%`],
    );
    for (const c of completions) {
      const list = finished.get(c.key) ?? [];
      list.push({ at: c.completed_at.toISOString(), on: c.completed_on });
      finished.set(c.key, list);
    }
    const lastDone = (key: string) => finished.get(key)?.at(-1)?.at ?? null;

    if (isDatabase) {
      await readDoc(id, null, (doc) => {
        const fields = fieldsOf(doc);
        const primary = fields.find((f) => f.primary) ?? fields[0];
        const status = statusFieldOf(fields);
        // The first date that isn't another date's end (the one a calendar or timeline shows).
        const ends = new Set(
          doc
            .getArray<Y.Map<unknown>>('views')
            .toArray()
            .filter((v) => v instanceof Y.Map)
            .map((v) => v.get('endField') as string | null)
            .filter(Boolean),
        );
        const dateField = fields.find((f) => f.type === 'date' && !ends.has(f.id));
        for (const r of doc.getArray<Y.Map<unknown>>('rows').toArray()) {
          if (!(r instanceof Y.Map)) continue;
          const rowId = String(r.get('id'));
          const cellsMap = r.get('cells');
          const cells = cellsMap instanceof Y.Map ? (cellsMap.toJSON() as Record<string, unknown>) : {};
          const option = status?.options?.find((o) => o.id === cells[status.id]);
          const rule = r.get('repeat');
          const done = validRule(rule) && rule.statusField ? isRowDone(rule, cells) : option && status ? isDoneOption(status, option) : null;
          const key = `card:${id}:${rowId}`;
          const title = primary && typeof cells[primary.id] === 'string' ? (cells[primary.id] as string).trim() : '';
          items.push({
            key,
            kind: 'card',
            title: title || 'Untitled',
            date: dateField && isDate(cells[dateField.id]) ? (cells[dateField.id] as string) : null,
            time: null,
            done,
            doneAt: done ? lastDone(key) : null,
            status: option?.name ?? null,
            detail: null,
            forever: false,
          });
        }
      });
    }

    // Tasks placed in the page or its cards.
    const events = await query<{
      id: string;
      title: string;
      start: string;
      time: string | null;
      status: string;
      repeat: unknown;
      paths: Paths | null;
      pathState: PathState | null;
    }>(
      `select distinct e.id, e.title, to_char(e.start_date, 'YYYY-MM-DD') as start, e.start_time as time, e.status, e.repeat, e.paths, e.path_state as "pathState"
         from events e join event_refs r on r.event_id = e.id
        where r.page_id = $1 and e.status is not null`,
      [id],
    );
    for (const e of events) {
      const key = `event:${e.id}`;
      const base = { kind: 'task' as const, title: e.title || 'Untitled task', time: e.time, status: null };
      if (!validRule(e.repeat)) {
        items.push({ ...base, key, date: e.start, done: e.status === 'done', doneAt: e.status === 'done' ? lastDone(key) : null, detail: null, forever: false });
        continue;
      }
      const forever = !e.repeat.end;
      if (keepsMissedDays(e)) {
        // Every day ticked off (with the path taken), then the day it's on now.
        for (const h of e.pathState?.history ?? []) {
          const path = h.choice.labels.length ? `${h.choice.labels.join(' › ')}${h.choice.step ? ` · ${h.choice.step.title}` : ''}` : null;
          const at = h.at ?? finished.get(key)?.find((f) => f.on >= h.date)?.at ?? null;
          items.push({ ...base, key: `${key}:${h.date}`, date: h.date, done: true, doneAt: at, detail: path, forever });
        }
        // The day it's on now and the missed days after it, up to today, are all still to do.
        if (e.start <= day)
          for (const d of occurrencesBetween(e.repeat, e.start, day, 1000))
            items.push({ ...base, key: `${key}:${d}`, date: d, done: false, doneAt: null, detail: null, forever });
        continue;
      }
      // Other repeating tasks: one row a day up to today; a day counts as done if it was ticked that day.
      const until = e.repeat.end && e.repeat.end < day ? e.repeat.end : day;
      const doneOn = new Map((finished.get(key) ?? []).map((f) => [f.on, f.at]));
      for (const d of occurrencesBetween(e.repeat, e.repeat.start, until, 1000)) {
        const current = d === e.start;
        const done = current ? e.status === 'done' : doneOn.has(d);
        items.push({ ...base, key: `${key}:${d}`, date: d, done, doneAt: done ? (doneOn.get(d) ?? null) : null, detail: null, forever });
      }
    }

    // Dated to-dos written in the page (not in its cards, which are counted through the cards).
    const todos = await query<{ block_id: string; row_id: string; date: string; text: string; done: boolean }>(
      `select block_id, row_id, to_char(date, 'YYYY-MM-DD') as date, text, done from block_dates where page_id = $1 and done is not null and row_id = ''`,
      [id],
    );
    for (const t of todos) {
      const key = `block:${id}:${t.row_id}:${t.block_id}`;
      items.push({ key, kind: 'todo', title: t.text || 'To-do', date: t.date, time: null, done: t.done, doneAt: t.done ? lastDone(key) : null, status: null, detail: null, forever: false });
    }

    return { title: page.title, kind: isDatabase ? 'database' : 'document', today: day, tomorrow: addDays(day, 1), items };
  });
}
