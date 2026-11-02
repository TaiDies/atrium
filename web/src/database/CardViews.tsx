import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight, FileText, Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { CellDisplay } from './cells';
import { useDb } from './context';
import { type Field, formatDate, isEmptyValue, type MediaItem, primaryField, type Row, rowTitle, type View, viewRows } from './model';

function useCardData(view: View) {
  const { db } = useDb();
  const rows = viewRows(db, view);
  const fields = db.fields.filter((f) => !f.primary && !view.hidden.includes(f.id));
  return { rows, fields };
}

const shown = (fields: Field[], row: Row) => fields.filter((f) => f.type === 'created_time' || f.type === 'last_edited' || !isEmptyValue(row.cells[f.id]));

function NewButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  const { readOnly } = useDb();
  if (readOnly) return null;
  return (
    <button onClick={onClick} className={clsx('flex items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-fg', className)}>
      <Plus size={15} /> {label}
    </button>
  );
}

// ---------- List ----------

export function ListView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, openRow } = useDb();
  const { rows, fields } = useCardData(view);
  return (
    <div className={clsx('pt-2 pb-8', !embedded && 'px-6 sm:px-[54px]')}>
      <div className="divide-y divide-line border-y border-line">
        {rows.map((row) => {
          const title = rowTitle(db.fields, row);
          return (
            <button key={row.id} onClick={() => openRow(row.id)} className="flex w-full items-center gap-3 px-2 py-2 text-start hover:bg-hover">
              <FileText size={16} className="shrink-0 text-muted" />
              <span className={clsx('min-w-0 flex-1 truncate text-sm font-medium', !title && 'text-faint')}>{title || 'Untitled'}</span>
              <span className="hidden min-w-0 shrink items-center justify-end gap-3 overflow-hidden sm:flex">
                {shown(fields, row)
                  .slice(0, 4)
                  .map((f) => (
                    <span key={f.id} className="flex max-w-[200px] min-w-0 items-center">
                      <CellDisplay field={f} row={row} />
                    </span>
                  ))}
              </span>
            </button>
          );
        })}
        {rows.length === 0 && <div className="px-2 py-6 text-center text-sm text-faint">No rows</div>}
      </div>
      <NewButton label="New" className="mt-1 h-8" onClick={() => openRow(actions.addRow())} />
    </div>
  );
}

// ---------- Gallery ----------

const GRADIENTS = [
  'linear-gradient(135deg, #a78bfa, #60a5fa)',
  'linear-gradient(135deg, #f472b6, #fb923c)',
  'linear-gradient(135deg, #34d399, #22d3ee)',
  'linear-gradient(135deg, #fbbf24, #f87171)',
  'linear-gradient(135deg, #818cf8, #c084fc)',
  'linear-gradient(135deg, #2dd4bf, #a3e635)',
];

function coverFor(view: View, fields: Field[], row: Row): string | null {
  const candidates = [fields.find((f) => f.id === view.coverField), ...fields.filter((f) => f.type === 'media')].filter(Boolean) as Field[];
  for (const f of candidates) {
    const items = row.cells[f.id];
    const img = Array.isArray(items) ? (items as MediaItem[]).find((m) => m.type.startsWith('image/')) : undefined;
    if (img) return img.url;
  }
  return null;
}

export function GalleryView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, openRow } = useDb();
  const { rows, fields } = useCardData(view);
  return (
    <div className={clsx('pt-3 pb-8', !embedded && 'px-6 sm:px-[54px]')}>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {rows.map((row) => {
          const title = rowTitle(db.fields, row);
          const cover = coverFor(view, db.fields, row);
          const hash = [...row.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
          return (
            <button
              key={row.id}
              onClick={() => openRow(row.id)}
              className="group overflow-hidden rounded-xl border border-line bg-card text-start transition-shadow hover:shadow-pop"
            >
              <div className="relative h-36 w-full overflow-hidden bg-sidebar" style={cover ? undefined : { background: GRADIENTS[hash % GRADIENTS.length] }}>
                {cover ? (
                  <img src={cover} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-4xl font-bold text-white/80">{(title || '?').charAt(0).toUpperCase()}</span>
                )}
              </div>
              <div className="px-3 py-2.5">
                <div className={clsx('truncate text-sm font-medium', !title && 'text-faint')}>{title || 'Untitled'}</div>
                <div className="mt-1.5 flex flex-col gap-1">
                  {shown(fields, row)
                    .filter((f) => f.type !== 'media')
                    .slice(0, 3)
                    .map((f) => (
                      <div key={f.id} className="flex min-w-0">
                        <CellDisplay field={f} row={row} />
                      </div>
                    ))}
                </div>
              </div>
            </button>
          );
        })}
        <NewButton label="New card" className="min-h-[120px] justify-center rounded-xl border border-dashed border-line" onClick={() => openRow(actions.addRow())} />
      </div>
    </div>
  );
}

// ---------- Feed ----------

export function FeedView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, openRow, pageId, readOnly } = useDb();
  const { rows, fields } = useCardData(view);
  const [draft, setDraft] = useState('');
  const previews = useQuery({
    queryKey: ['row-previews', pageId],
    queryFn: async () => (await api<{ previews: Record<string, string> }>(`/api/pages/${pageId}/rows/previews`)).previews,
    refetchInterval: 15_000,
  });
  const pf = primaryField(db.fields);
  const dateField = fields.find((f) => f.type === 'date');
  // Newest first, unless the view has its own sort.
  const ordered = view.sorts.length ? rows : [...rows].sort((a, b) => b.createdAt - a.createdAt);

  const post = () => {
    if (!draft.trim() || !pf) return;
    openRow(actions.addRow({ [pf.id]: draft.trim() }));
    setDraft('');
  };

  return (
    <div className={clsx('pt-4 pb-10', !embedded && 'px-6 sm:px-[54px]')}>
      <div className="mx-auto max-w-[720px] space-y-3">
        {!readOnly && (
          <div className="flex gap-2 rounded-xl border border-line bg-card p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && post()}
              placeholder="Write a new post title, then add the details…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
            <button onClick={post} disabled={!draft.trim()} className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-40">
              Post
            </button>
          </div>
        )}
        {ordered.map((row) => {
          const title = rowTitle(db.fields, row);
          const preview = previews.data?.[row.id];
          return (
            <article key={row.id} className="rounded-xl border border-line bg-card p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <button onClick={() => openRow(row.id)} className={clsx('text-start text-base font-semibold hover:underline', !title && 'text-faint')}>
                    {title || 'Untitled'}
                  </button>
                  <div className="mt-0.5 text-xs text-faint">{formatDate(dateField ? row.cells[dateField.id] || row.createdAt : row.createdAt)}</div>
                </div>
                <button onClick={() => openRow(row.id)} className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg" title="Open">
                  <ArrowUpRight size={16} />
                </button>
              </div>
              {preview && <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-fg/85">{preview}</p>}
              {shown(fields, row).filter((f) => f.id !== dateField?.id).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {shown(fields, row)
                    .filter((f) => f.id !== dateField?.id)
                    .slice(0, 5)
                    .map((f) => (
                      <span key={f.id} className="flex max-w-[240px] min-w-0">
                        <CellDisplay field={f} row={row} />
                      </span>
                    ))}
                </div>
              )}
            </article>
          );
        })}
        {ordered.length === 0 && <div className="py-10 text-center text-sm text-faint">Nothing posted yet.</div>}
      </div>
    </div>
  );
}
