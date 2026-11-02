import type { Access } from './access.js';
import { databaseRows, readDoc } from './blocks.js';
import { query } from './db.js';

export interface Location {
  pageId: string;
  rowId: string | null;
  pageTitle: string;
  pageType: string;
  rowTitle: string | null;
  access: Access;
}

/** Where each file, event or whiteboard is used (from one of the *_refs tables), limited to pages the user can see. */
export async function locationsFor(
  table: 'file_refs' | 'event_refs' | 'board_refs',
  column: 'file_id' | 'event_id' | 'board_id',
  ids: string[],
  access: Map<string, Access>,
): Promise<Map<string, Location[]>> {
  const out = new Map<string, Location[]>();
  if (!ids.length) return out;
  const refs = await query<{ id: string; page_id: string; row_id: string; title: string; type: string }>(
    `select r.${column} as id, r.page_id, r.row_id, p.title, p.type
       from ${table} r join pages p on p.id = r.page_id and p.deleted_at is null
      where r.${column} = any($1::uuid[])`,
    [ids],
  );
  const rowTitles = new Map<string, Map<string, string>>();
  for (const r of refs) {
    const level = access.get(r.page_id) ?? 'none';
    if (level === 'none') continue;
    let rowTitle: string | null = null;
    if (r.row_id) {
      if (!rowTitles.has(r.page_id)) {
        rowTitles.set(r.page_id, new Map((await readDoc(r.page_id, null, databaseRows)).map((row) => [row.id, row.title])));
      }
      rowTitle = rowTitles.get(r.page_id)!.get(r.row_id) ?? null;
      if (rowTitle === null) continue; // the card was deleted
    }
    const list = out.get(r.id) ?? [];
    list.push({ pageId: r.page_id, rowId: r.row_id || null, pageTitle: r.title || 'Untitled', pageType: r.type, rowTitle, access: level });
    out.set(r.id, list);
  }
  return out;
}
