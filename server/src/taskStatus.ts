import * as Y from 'yjs';
import { editDoc, readDoc } from './blocks.js';
import { one, query } from './db.js';

type Group = 'todo' | 'doing' | 'done';

const CARD_REFS = `r.row_id <> '' and r.row_id not like 'tpl\_%' and r.row_id not like 'sync\_%'`;

/** The tasks inside each card of a database (for "Tasks" properties). */
export async function cardTasks(pageId: string) {
  const rows = await query<{ rowId: string; id: string; title: string; status: Group; startDate: string }>(
    `select r.row_id as "rowId", e.id, e.title, e.status, to_char(e.start_date, 'YYYY-MM-DD') as "startDate"
       from event_refs r join events e on e.id = r.event_id
      where r.page_id = $1 and ${CARD_REFS} and e.status is not null
      order by e.start_date, e.created_at`,
    [pageId],
  );
  const tasks: Record<string, { id: string; title: string; status: Group; startDate: string }[]> = {};
  for (const { rowId, ...t } of rows) (tasks[rowId] ??= []).push(t);
  return tasks;
}

/**
 * Status and single-select properties set to follow the card's tasks ("taskDone"): once every task in
 * the card is done, the card is set to the chosen option; if a task is reopened while it's on that
 * option, it goes to "taskUndone" (or stays, when none is chosen). Older properties set up with
 * "followTasks" move between the status groups instead: Complete, In progress and To-do.
 */
export async function syncCardStatuses(eventId: string) {
  const cards = await query<{ page_id: string; row_id: string }>(`select r.page_id, r.row_id from event_refs r where r.event_id = $1 and ${CARD_REFS}`, [eventId]);
  for (const card of cards) await syncCard(card.page_id, card.row_id).catch((err) => console.error('Task status sync failed', card, err));
}

async function syncCard(pageId: string, rowId: string) {
  const page = await one<{ id: string }>('select id from pages where id = $1 and deleted_at is null', [pageId]);
  if (!page) return;
  const following = await readDoc(pageId, null, (doc) =>
    doc
      .getArray<Y.Map<unknown>>('fields')
      .toArray()
      .some((f) => f instanceof Y.Map && (f.get('followTasks') === true || typeof f.get('taskDone') === 'string')),
  );
  if (!following) return;
  const tasks = await query<{ status: Group }>(
    `select e.status from event_refs r join events e on e.id = r.event_id where r.page_id = $1 and r.row_id = $2 and e.status is not null`,
    [pageId, rowId],
  );
  if (!tasks.length) return;
  const group: Group = tasks.every((t) => t.status === 'done') ? 'done' : tasks.some((t) => t.status !== 'todo') ? 'doing' : 'todo';
  await editDoc(pageId, null, (doc) => {
    const row = doc
      .getArray<Y.Map<unknown>>('rows')
      .toArray()
      .find((r) => r instanceof Y.Map && r.get('id') === rowId);
    const cells = row?.get('cells');
    if (!row || !(cells instanceof Y.Map)) return;
    for (const f of doc.getArray<Y.Map<unknown>>('fields').toArray()) {
      if (!(f instanceof Y.Map) || f.get('type') !== 'select') continue;
      const raw = f.get('options');
      const options = (raw instanceof Y.Array ? raw.toJSON() : Array.isArray(raw) ? raw : []) as { id: string; group?: Group }[];
      const fieldId = String(f.get('id'));
      const doneOption = f.get('taskDone');
      if (typeof doneOption === 'string') {
        if (!options.some((o) => o.id === doneOption)) continue;
        const undoOption = f.get('taskUndone');
        const value = cells.get(fieldId);
        let next: string | null = null;
        if (group === 'done') next = doneOption;
        else if (value === doneOption && typeof undoOption === 'string' && options.some((o) => o.id === undoOption)) next = undoOption;
        if (next && next !== value) {
          cells.set(fieldId, next);
          row.set('updatedAt', Date.now());
        }
        continue;
      }
      if (f.get('followTasks') !== true) continue;
      const current = options.find((o) => o.id === cells.get(fieldId));
      if ((current?.group ?? 'todo') === group && current) continue;
      const target = options.find((o) => (o.group ?? 'todo') === group);
      if (!target) continue;
      cells.set(String(f.get('id')), target.id);
      row.set('updatedAt', Date.now());
    }
  });
}
