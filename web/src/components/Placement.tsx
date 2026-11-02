import { ExternalLink, Link2Off, MapPin } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../app/context';
import { PageIcon } from '../app/PageIcon';
import { canEdit, type PageSummary, pageTitle } from '../lib/api';
import { type BlockPosition, type Location, locationLabel, locationPath, type OutlineBlock, type PlaceTarget, useOutline } from '../lib/placement';
import { Button } from './ui';

// Shared by Files, Calendar and Whiteboards: where an item is used, and putting it on a page or card.

const DATABASE = new Set(['grid', 'board', 'calendar', 'timeline', 'chart', 'form', 'list', 'gallery', 'feed']);

/** Pages in sidebar order, each with its depth, for an indented picker. */
function flattenTree(pages: PageSummary[]) {
  const children = new Map<string | null, PageSummary[]>();
  for (const p of pages) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p]);
  for (const list of children.values()) list.sort((a, b) => a.position - b.position);
  const ids = new Set(pages.map((p) => p.id));
  const out: { page: PageSummary; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of children.get(parent) ?? []) {
      out.push({ page: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  // Pages whose parent is hidden from this user still get listed, at the top level.
  for (const p of pages)
    if (p.parentId && !ids.has(p.parentId) && !out.some((o) => o.page.id === p.id)) {
      out.push({ page: p, depth: 0 });
      walk(p.id, 1);
    }
  return out;
}

const BLOCK_LABELS: Record<string, string> = {
  paragraph: 'Text',
  heading: 'Heading',
  bulletListItem: 'Bullet',
  numberedListItem: 'Numbered',
  checkListItem: 'To-do',
  toggleListItem: 'Toggle',
  quote: 'Quote',
  codeBlock: 'Code',
  table: 'Table',
  image: 'Image',
  file: 'File',
  video: 'Video',
  audio: 'Audio',
  subpage: 'Page link',
  database: 'Database',
  divider: 'Divider',
  event: 'Event',
  whiteboard: 'Whiteboard',
};

/** "Used in": every page and card the item is on, each opening it. */
export function LocationList({ locations, empty, onRemoveAll, onOpen }: { locations: Location[]; empty: string; onRemoveAll?: () => void; onOpen?: () => void }) {
  const { workspace, pages } = useApp();
  const navigate = useNavigate();
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Used in</span>
        {onRemoveAll && locations.some((l) => canEdit(l.access)) && (
          <button onClick={onRemoveAll} className="flex items-center gap-1 text-xs text-muted hover:text-danger">
            <Link2Off size={13} /> Remove from all pages
          </button>
        )}
      </div>
      {locations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted">{empty}</div>
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line">
          {locations.map((l) => {
            const page = pages.find((p) => p.id === l.pageId);
            return (
              <button
                key={`${l.pageId}:${l.rowId ?? ''}`}
                onClick={() => {
                  onOpen?.();
                  navigate(locationPath(workspace.id, l));
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-hover"
              >
                {page ? <PageIcon page={page} size={16} /> : <MapPin size={16} className="text-muted" />}
                <span className="min-w-0 flex-1 truncate">{locationLabel(l)}</span>
                <ExternalLink size={14} className="shrink-0 text-faint" />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Choosing a page (or a card of a database), then where on it: at the top, at the end, right after a
 * block or nested under one (e.g. inside a to-do item).
 */
export function PlacePicker({
  title,
  hasLocations,
  hideBlock,
  onPlace,
}: {
  title: string;
  hasLocations: boolean;
  /** Leave the item's own block out of the list of blocks to put it next to. */
  hideBlock?: (b: OutlineBlock) => boolean;
  onPlace: (target: PlaceTarget, keepExisting: boolean) => Promise<void>;
}) {
  const { pages } = useApp();
  const [pageId, setPageId] = useState('');
  const [rowId, setRowId] = useState('');
  const [anchor, setAnchor] = useState('end');
  const [position, setPosition] = useState<'after' | 'inside'>('inside');
  const [keepExisting, setKeepExisting] = useState(false);
  const [saving, setSaving] = useState(false);

  const editable = useMemo(() => flattenTree(pages).filter(({ page }) => canEdit(page.access)), [pages]);
  const target = pages.find((p) => p.id === pageId) ?? null;
  const isDb = !!target && DATABASE.has(target.type);
  const outline = useOutline(pageId || null, isDb ? rowId || null : null);
  const cards = useOutline(isDb ? pageId : null, null);
  const cardRows = cards.data?.rows ?? [];
  const blocks = (!isDb || rowId ? (outline.data?.blocks ?? []) : []).filter((b) => !(hideBlock?.(b) && !keepExisting));

  useEffect(() => {
    setRowId('');
    setAnchor('end');
  }, [pageId]);
  useEffect(() => setAnchor('end'), [rowId]);

  const ready = !!pageId && (!isDb || !!rowId);
  const place = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const pos: BlockPosition = anchor === 'start' || anchor === 'end' ? anchor : position;
      await onPlace({ pageId, rowId: isDb ? rowId : null, anchorId: anchor === 'start' || anchor === 'end' ? null : anchor, position: pos }, keepExisting);
      setPageId('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-line p-4">
      <div className="mb-3 text-sm font-medium">{title}</div>
      <label className="mb-1 block text-xs text-muted">Page</label>
      <select value={pageId} onChange={(e) => setPageId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm">
        <option value="">Choose a page…</option>
        {editable.map(({ page, depth }) => (
          <option key={page.id} value={page.id}>
            {'  '.repeat(depth)}
            {page.icon ? `${page.icon} ` : ''}
            {pageTitle(page)}
            {DATABASE.has(page.type) ? ' (database)' : ''}
          </option>
        ))}
      </select>

      {isDb && (
        <>
          <label className="mt-3 mb-1 block text-xs text-muted">Card</label>
          <select value={rowId} onChange={(e) => setRowId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm">
            <option value="">Choose a card…</option>
            {cardRows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
          {cardRows.length === 0 && !cards.isPending && <div className="mt-1 text-xs text-faint">This database has no cards yet.</div>}
        </>
      )}

      {ready && (
        <>
          <label className="mt-3 mb-1 block text-xs text-muted">Where on the page</label>
          <select value={anchor} onChange={(e) => setAnchor(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm">
            <option value="end">At the end</option>
            <option value="start">At the top</option>
            {blocks.length > 0 && (
              <optgroup label="Next to a block">
                {blocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {'  '.repeat(b.depth)}
                    {BLOCK_LABELS[b.type] ?? b.type}: {b.text || '(empty)'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {anchor !== 'start' && anchor !== 'end' && (
            <div className="mt-2 flex gap-2">
              {(['inside', 'after'] as const).map((p) => (
                <label key={p} className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                  <input type="radio" name="position" checked={position === p} onChange={() => setPosition(p)} />
                  {p === 'inside' ? 'Nested under it' : 'Right after it'}
                </label>
              ))}
            </div>
          )}
        </>
      )}

      {hasLocations && (
        <label className="mt-3 flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={keepExisting} onChange={(e) => setKeepExisting(e.target.checked)} />
          Also keep it where it is now
        </label>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" disabled={!ready || saving} onClick={place}>
          {saving ? 'Saving…' : hasLocations && !keepExisting ? 'Move here' : 'Add here'}
        </Button>
      </div>
    </section>
  );
}
