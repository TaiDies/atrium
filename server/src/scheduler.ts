import * as Y from 'yjs';
import { editDoc } from './blocks.js';
import { runRepeatingTemplates } from './routes/templates.js';
import { runDigests } from './digest.js';
import { query } from './db.js';
import { fieldsOf, isRowDone } from './docIndex.js';
import { keepsMissedDays, type Paths } from './paths.js';
import { addDays, daysBetween, isDate, latestOnOrBefore, nextAfter, type RepeatRule, today, validRule } from './repeat.js';

// Repeating cards and events. On each new date of the pattern (or, for "when done" rules, as soon
// as they're marked done) they move to the new date and their status goes back to the chosen one.

/** The date a repeating item should move to now, or null if it stays where it is. */
export function resetTarget(rule: RepeatRule, current: string | null, done: boolean, day: string): string | null {
  if (rule.when === 'date') {
    const target = latestOnOrBefore(rule, day);
    return target && (!current || target > current) ? target : null;
  }
  if (!done) return null;
  // Done early: the next date after this one. Done late: the next date from today on.
  const base = current && current > addDays(day, -1) ? current : addDays(day, -1);
  return nextAfter(rule, base);
}

/** Moves one card to its next date and resets it. Returns false when nothing needed doing. */
export function resetRow(doc: Y.Doc, rowId: string, day: string): boolean {
  const row = doc.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === rowId);
  const rule = row?.get('repeat');
  const cells = row?.get('cells');
  if (!row || !validRule(rule) || !rule.dateField || !(cells instanceof Y.Map)) return false;
  const current = cells.get(rule.dateField);
  const target = resetTarget(rule, isDate(current) ? current : null, isRowDone(rule, cells.toJSON()), day);
  if (!target) return false;

  if (rule.endField && isDate(current) && isDate(cells.get(rule.endField))) {
    // Keep the card's length the same (e.g. a two-day timeline bar).
    cells.set(rule.endField, addDays(cells.get(rule.endField) as string, daysBetween(current, target)));
  }
  cells.set(rule.dateField, target);
  if (rule.statusField) {
    if (rule.resetTo === undefined || rule.resetTo === null) cells.delete(rule.statusField);
    else cells.set(rule.statusField, rule.resetTo);
  }
  if (rule.untick) {
    for (const f of fieldsOf(doc)) {
      const v = cells.get(f.id);
      if (f.type === 'checklist' && Array.isArray(v)) cells.set(f.id, v.map((item) => ({ ...item, done: false })));
      if (f.type === 'checkbox' && f.id !== rule.statusField && v === true) cells.set(f.id, false);
    }
  }
  row.set('updatedAt', Date.now());
  row.set('repeatLastReset', day);
  return true;
}

async function resetCards(day: string) {
  const due = await query<{ page_id: string; row_id: string }>('select page_id, row_id from row_repeats where next_reset <= $1', [day]);
  for (const r of due) {
    try {
      const changed = await editDoc(r.page_id, null, (doc) => resetRow(doc, r.row_id, day), { log: false });
      // Nothing to do (e.g. the pattern has ended): stop checking until the card changes again.
      if (!changed) await query('update row_repeats set next_reset = null where page_id = $1 and row_id = $2 and next_reset <= $3', [r.page_id, r.row_id, day]);
    } catch (err) {
      console.error('Could not reset a repeating card', r, err);
    }
  }
}

async function resetEvents(day: string) {
  const events = await query<{ id: string; start: string; end: string | null; status: string | null; repeat: unknown; paths: Paths | null }>(
    `select id, to_char(start_date, 'YYYY-MM-DD') as start, to_char(end_date, 'YYYY-MM-DD') as "end", status, repeat, paths from events where repeat is not null`,
  );
  for (const e of events) {
    if (!validRule(e.repeat)) continue;
    // Tasks with paths that keep missed days stay on the first day not done; ticking moves them on.
    if (keepsMissedDays(e)) continue;
    const target = resetTarget(e.repeat, e.start, e.status === 'done', day);
    if (!target) continue;
    const end = e.end ? addDays(e.end, daysBetween(e.start, target)) : null;
    const status = e.status === null ? null : (e.repeat.resetStatus ?? 'todo');
    await query('update events set start_date = $2, end_date = $3, status = $4, updated_at = now() where id = $1', [e.id, target, end, status]);
  }
}

let running = false;

export async function runResets() {
  if (running) return;
  running = true;
  try {
    const day = today();
    await resetCards(day);
    await resetEvents(day);
    await runRepeatingTemplates(day);
    await runDigests().catch((err) => console.error('Daily emails failed', err));
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setTimeout(() => runResets().catch((err) => console.error(err)), 5_000);
  setInterval(() => runResets().catch((err) => console.error(err)), 60_000).unref();
}
