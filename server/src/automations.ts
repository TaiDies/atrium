import * as Y from 'yjs';
import { editDoc } from './blocks.js';
import { one, query } from './db.js';
import type { FieldInfo } from './docIndex.js';
import { notify } from './notify.js';
import { today } from './repeat.js';

// Database automations: "when a card is added" or "when a property changes (to a value)", then set
// properties or notify people. They run on the server each time the database is saved, so cards added
// from forms, the API or the AI count too.

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { type: 'added' } | { type: 'changed'; fieldId: string; value?: unknown };
  actions: ({ type: 'set'; fieldId: string; value: unknown } | { type: 'notify'; userIds: string[]; personField?: string | null; message: string })[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether a changed value is the one a trigger waits for (a select option, a ticked box, a person…). */
function reached(value: unknown, wanted: unknown): boolean {
  if (wanted === undefined || wanted === null || wanted === '') return true;
  if (Array.isArray(value)) return Array.isArray(wanted) ? wanted.every((w) => value.includes(w)) : value.includes(wanted);
  return same(value, wanted);
}

/** Values an action fills in when it runs. */
function fill(value: unknown, field: FieldInfo | undefined, editor: string | null): unknown {
  if (value === '@today' || value === '@now') return today();
  if (value === '@me') return field?.type === 'person' ? (editor ? [editor] : []) : editor;
  return value;
}

export async function runAutomations(pageId: string, doc: Y.Doc, fields: FieldInfo[], log: boolean, editor: string | null) {
  const settings = doc.getMap<unknown>('dbSettings');
  const rules = ((settings.get('automations') as Automation[] | undefined) ?? []).filter((r) => r && r.enabled && Array.isArray(r.actions) && r.actions.length);
  if (!rules.length) {
    await query('delete from automation_snapshots where page_id = $1', [pageId]);
    return;
  }

  const rows = doc
    .getArray<Y.Map<unknown>>('rows')
    .toArray()
    .filter((r) => r instanceof Y.Map)
    .map((r) => ({ id: String(r.get('id')), cells: (r.get('cells') instanceof Y.Map ? (r.get('cells') as Y.Map<unknown>).toJSON() : {}) as Record<string, unknown> }));
  const stored = await query<{ row_id: string; cells: Record<string, unknown> }>('select row_id, cells from automation_snapshots where page_id = $1', [pageId]);
  const set_up = stored.some((s) => s.row_id === '');
  const before = new Map(stored.filter((s) => s.row_id !== '').map((s) => [s.row_id, s.cells]));

  // What each card gets set to, and who to tell.
  const patches = new Map<string, Record<string, unknown>>();
  const messages: { userId: string; title: string; body: string; rowId: string }[] = [];
  const primary = fields.find((f) => f.primary) ?? fields[0];
  const titleOf = (cells: Record<string, unknown>) => (primary && typeof cells[primary.id] === 'string' ? (cells[primary.id] as string).trim() : '') || 'Untitled';

  if (set_up && log) {
    for (const row of rows) {
      const prev = before.get(row.id);
      for (const rule of rules) {
        let fires = false;
        if (rule.trigger.type === 'added') fires = !prev;
        else if (prev) {
          const fieldId = rule.trigger.fieldId;
          fires = !same(prev[fieldId], row.cells[fieldId]) && reached(row.cells[fieldId], rule.trigger.value);
        }
        if (!fires) continue;
        for (const action of rule.actions) {
          if (action.type === 'set') {
            // A rule never changes the property that set it off (that would go round in circles).
            if (rule.trigger.type === 'changed' && action.fieldId === rule.trigger.fieldId) continue;
            const field = fields.find((f) => f.id === action.fieldId);
            if (!field) continue;
            patches.set(row.id, { ...(patches.get(row.id) ?? {}), [action.fieldId]: fill(action.value, field, editor) });
          } else if (action.type === 'notify') {
            const people = new Set((action.userIds ?? []).filter((id) => UUID_RE.test(id)));
            if (action.personField && Array.isArray(row.cells[action.personField])) {
              for (const id of row.cells[action.personField] as unknown[]) if (UUID_RE.test(String(id))) people.add(String(id));
            }
            for (const userId of people) {
              messages.push({ userId, rowId: row.id, title: action.message?.trim() || rule.name || 'Automation', body: titleOf(row.cells) });
            }
          }
        }
      }
    }
  }

  // Remember what was seen (including the automations' own changes, so they don't set anything off again).
  await query('delete from automation_snapshots where page_id = $1', [pageId]);
  await query(
    `insert into automation_snapshots (page_id, row_id, cells)
     select $1, r.row_id, r.cells from jsonb_to_recordset($2::jsonb) as r(row_id text, cells jsonb)`,
    [pageId, JSON.stringify([{ row_id: '', cells: {} }, ...rows.map((r) => ({ row_id: r.id, cells: { ...r.cells, ...(patches.get(r.id) ?? {}) } }))])],
  );

  if (patches.size) {
    // Changed after this save finishes, through the live document, so everyone sees it.
    setImmediate(() => {
      editDoc(
        pageId,
        null,
        (d) => {
          let changed = false;
          for (const r of d.getArray<Y.Map<unknown>>('rows').toArray()) {
            const patch = r instanceof Y.Map ? patches.get(String(r.get('id'))) : undefined;
            const cells = patch && r.get('cells');
            if (!(cells instanceof Y.Map)) continue;
            for (const [k, v] of Object.entries(patch!)) if (!same(cells.get(k), v)) cells.set(k, v);
            r.set('updatedAt', Date.now());
            changed = true;
          }
          return changed;
        },
        { log: false },
      ).catch((err) => console.error('Automation could not update cards', err));
    });
  }

  if (messages.length) {
    const page = await one<{ workspace_id: string; title: string }>('select workspace_id, title from pages where id = $1', [pageId]);
    if (!page) return;
    for (const m of messages) {
      const member = await one('select 1 from workspace_members where workspace_id = $1 and user_id = $2', [page.workspace_id, m.userId]);
      if (!member) continue;
      await notify(m.userId, {
        kind: 'automation',
        title: m.title,
        body: `${m.body} · ${page.title || 'Untitled'}`,
        link: `/w/${page.workspace_id}/p/${pageId}?row=${pageId}:${m.rowId}`,
      });
    }
  }
}
