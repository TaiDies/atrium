import clsx from 'clsx';
import { Check, Search, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { type Anchor, Popover, toastError } from '../components/ui';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';
import { relatedKey } from './computed';
import { useDb } from './context';
import { formatDate, type Field, primaryField, type Row } from './model';

// How relations, rollups and formulas look in a cell, and picking the cards a relation links to.

const isError = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && !Array.isArray(v) && 'error' in v;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A rollup or formula value: numbers, text, yes/no, dates or lists. */
export function ComputedValue({ value, compact }: { value: unknown; compact?: boolean }) {
  if (value === undefined || value === null || value === '') return null;
  if (isError(value)) {
    return (
      <span title={value.error} className="inline-flex min-w-0 items-center gap-1 text-xs text-red-500">
        <TriangleAlert size={12} className="shrink-0" />
        <span className="truncate">{value.error}</span>
      </span>
    );
  }
  if (typeof value === 'boolean') return value ? <Check size={15} className="text-accent" /> : <span className="text-xs text-faint">No</span>;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return (
      <span className={clsx('flex min-w-0 gap-1', compact ? 'overflow-hidden' : 'flex-wrap')}>
        {value.map((v, i) => (
          <span key={i} className="truncate rounded bg-active px-1.5 text-xs">
            {String(v)}
          </span>
        ))}
      </span>
    );
  }
  if (typeof value === 'string' && DATE.test(value)) return <span className="text-sm text-muted">{formatDate(value)}</span>;
  if (typeof value === 'number') return <span className="text-sm tabular-nums">{Math.round(value * 1e6) / 1e6}</span>;
  return <span className="text-sm break-words whitespace-pre-wrap">{String(value)}</span>;
}

/** Linked cards as chips; clicking one opens it in its own database. */
export function RelationValue({ field, value, compact }: { field: Field; value: unknown; compact?: boolean }) {
  const { workspaceId } = useDb();
  const ids = Array.isArray(value) ? (value as string[]) : [];
  if (!ids.length) return null;
  const pageId = field.relation?.pageId;
  return (
    <span className={clsx('flex min-w-0 gap-1', compact ? 'overflow-hidden' : 'flex-wrap')}>
      {ids.map((id) => (
        <a
          key={id}
          href={pageId ? `/w/${workspaceId}/p/${pageId}?row=${pageId}:${id}` : undefined}
          onClick={(e) => e.stopPropagation()}
          className="max-w-[180px] truncate rounded bg-active px-1.5 text-xs underline-offset-2 hover:underline"
        >
          ↗ {field.titles?.get(id) ?? 'Untitled'}
        </a>
      ))}
    </span>
  );
}

/** Choosing which cards of the other database this card links to. */
export function RelationPicker({ field, row, anchor, onClose }: { field: Field; row: Row; anchor: Anchor | null; onClose: () => void }) {
  const { actions, related, pageId } = useDb();
  const [q, setQ] = useState('');
  const config = field.relation;
  const other = config ? related.get(config.pageId) : undefined;
  const selected = Array.isArray(row.cells[field.id]) ? (row.cells[field.id] as string[]) : [];
  const title = other ? primaryField(other.fields) : undefined;
  const nameOf = (r: { cells: Record<string, unknown> }) => (title && typeof r.cells[title.id] === 'string' && (r.cells[title.id] as string)) || 'Untitled';
  const rows = (other?.rows ?? []).filter((r) => nameOf(r).toLowerCase().includes(q.toLowerCase()));

  const toggle = async (id: string) => {
    if (!config) return;
    const on = !selected.includes(id);
    if (!config.reverse) {
      actions.updateCell(row.id, field.id, on ? [...selected, id] : selected.filter((x) => x !== id));
      // The other database's "linked from" side reads this database, so refresh it there too.
      queryClient.invalidateQueries({ queryKey: ['related-db'] });
      return;
    }
    // The "linked from" side: the link is kept on the other card, so change it there.
    const paired = config.pairedFieldId;
    const card = other?.rows.find((r) => r.id === id);
    if (!paired || !card) return;
    const current = Array.isArray(card.cells[paired]) ? (card.cells[paired] as string[]) : [];
    if (config.pageId === pageId) {
      actions.updateCell(id, paired, on ? [...current, row.id] : current.filter((x) => x !== row.id));
      return;
    }
    try {
      await api(`/api/pages/${config.pageId}/rows/${id}/cells`, {
        method: 'PATCH',
        body: { cells: { [paired]: on ? [...current, row.id] : current.filter((x) => x !== row.id) } },
      });
      await queryClient.invalidateQueries({ queryKey: relatedKey(config.pageId) });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} className="w-72 p-1.5">
      <div className="mb-1 flex items-center gap-2 rounded-md border border-line px-2">
        <Search size={13} className="text-faint" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find in ${other?.title ?? 'the other database'}`} className="h-8 flex-1 bg-transparent text-sm outline-none" />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {!other && <p className="px-2 py-3 text-xs text-muted">{config ? 'Loading…' : 'Choose a database for this relation first.'}</p>}
        {rows.map((r) => (
          <button key={r.id} onClick={() => toggle(r.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover">
            <span className={clsx('flex size-4 shrink-0 items-center justify-center rounded border', selected.includes(r.id) ? 'border-accent bg-accent text-white' : 'border-faint')}>
              {selected.includes(r.id) && <Check size={11} />}
            </span>
            <span className="truncate">{nameOf(r)}</span>
          </button>
        ))}
        {other && !rows.length && <p className="px-2 py-3 text-xs text-muted">No cards found.</p>}
      </div>
    </Popover>
  );
}
