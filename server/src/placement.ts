import { z } from 'zod';
import { type Access, atLeast, requirePage } from './access.js';
import { type BlockMatch, type BlockTemplate, databaseRows, editDoc, insertBlock, readDoc, removeBlocks } from './blocks.js';
import { DATABASE_TYPES } from './collab.js';
import { query } from './db.js';
import { HttpError } from './util.js';

// Putting an attachment, event or whiteboard block on a page or a card: at the start, at the end,
// after a block or nested inside one. Used by the Files, Calendar and Whiteboards screens.

export const placeTarget = z
  .object({
    pageId: z.uuid(),
    rowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
    anchorId: z.string().max(100).nullable().optional(),
    position: z.enum(['start', 'end', 'after', 'inside']).default('end'),
  })
  .nullable();

export const placeBody = z.object({ target: placeTarget, keepExisting: z.boolean().default(false) });

export type PlaceTarget = z.infer<typeof placeTarget>;

const isDatabase = (type: string) => (DATABASE_TYPES as readonly string[]).includes(type);

/**
 * Removes the item's blocks from every page and card it's on (unless `keepExisting`), then adds one
 * at `target`. A null target just removes it everywhere. Only pages the user can edit are changed.
 */
export async function placeBlock(opts: {
  userId: string;
  workspaceId: string;
  access: Map<string, Access>;
  refs: { table: 'file_refs' | 'event_refs' | 'board_refs'; column: 'file_id' | 'event_id' | 'board_id'; id: string };
  match: BlockMatch;
  /** The block to add when there isn't an existing one to move. */
  fresh: BlockTemplate;
  target: PlaceTarget;
  keepExisting: boolean;
}) {
  const dest = opts.target;
  if (dest) {
    const page = await requirePage(opts.userId, dest.pageId, 'edit');
    if (page.workspace_id !== opts.workspaceId) throw new HttpError(400, 'That page is in another workspace');
    if (isDatabase(page.type) && !dest.rowId) throw new HttpError(400, 'Choose a card in this database');
    if (!isDatabase(page.type) && dest.rowId) throw new HttpError(400, 'Only database pages have cards');
    if (dest.rowId) {
      const rows = await readDoc(dest.pageId, null, databaseRows);
      if (!rows.some((r) => r.id === dest.rowId)) throw new HttpError(404, 'Card not found');
    }
  }

  let template: BlockTemplate | null = null;
  if (!opts.keepExisting) {
    const refs = await query<{ page_id: string; row_id: string }>(`select page_id, row_id from ${opts.refs.table} where ${opts.refs.column} = $1`, [opts.refs.id]);
    for (const r of refs) {
      if (!atLeast(opts.access.get(r.page_id) ?? 'none', 'edit')) continue;
      const removed = await editDoc(r.page_id, r.row_id || null, (doc) => removeBlocks(doc, opts.match));
      template ??= removed;
    }
  }

  if (dest) {
    const ok = await editDoc(dest.pageId, dest.rowId ?? null, (doc) => insertBlock(doc, template ?? opts.fresh, dest.anchorId ?? null, dest.position));
    if (!ok) throw new HttpError(404, 'That block no longer exists');
  }
}

/** Removes the item's blocks from every page and card (for deleting it); fails if one can't be edited. */
export async function removeEverywhere(access: Map<string, Access>, refs: { table: string; column: string; id: string }, match: BlockMatch) {
  const rows = await query<{ page_id: string; row_id: string }>(`select page_id, row_id from ${refs.table} where ${refs.column} = $1`, [refs.id]);
  if (rows.some((r) => !atLeast(access.get(r.page_id) ?? 'none', 'edit'))) throw new HttpError(403, "It's used on a page you can't edit");
  for (const r of rows) await editDoc(r.page_id, r.row_id || null, (doc) => removeBlocks(doc, match));
}
