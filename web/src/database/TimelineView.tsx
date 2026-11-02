import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useDb } from './context';
import { OPTION_COLORS, type Row, rowTitle, type View, viewRows } from './model';

type Scale = 'day' | 'week' | 'month';
const PX: Record<Scale, number> = { day: 44, week: 18, month: 6 };
const SPAN: Record<Scale, number> = { day: 45, week: 120, month: 365 };
const DAY = 86_400_000;
const ROW_H = 36;

const parse = (s: unknown): Date | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const diffDays = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const today = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

interface DragState {
  rowId: string;
  mode: 'move' | 'start' | 'end';
  x: number;
  delta: number;
}

export function TimelineView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, openRow, readOnly } = useDb();
  const [scale, setScale] = useState<Scale>('day');
  const [origin, setOrigin] = useState(() => addDays(today(), -7));
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const startField = db.fields.find((f) => f.id === view.dateField && f.type === 'date');
  const endField = db.fields.find((f) => f.id === view.endField && f.type === 'date');
  const colorField = db.fields.find((f) => f.type === 'select');
  const rows = viewRows(db, view);
  const deps = db.settings.dependencies && db.fields.some((f) => f.id === db.settings.dependencies!.blockedByField) ? db.settings.dependencies : null;
  const px = PX[scale];
  const span = SPAN[scale];
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(origin, i)), [origin, span]);

  if (!startField) {
    return <div className={clsx('py-12 text-center text-sm text-muted', !embedded && 'px-6')}>Choose a start date property using <b>Dates</b> in the toolbar.</div>;
  }

  const range = (row: Row) => {
    const s = parse(row.cells[startField.id]);
    if (!s) return null;
    const e = endField ? parse(row.cells[endField.id]) : null;
    return { start: s, end: e && e >= s ? e : s };
  };

  const preview = (row: Row) => {
    const r = range(row);
    if (!r || !drag || drag.rowId !== row.id) return r;
    let { start, end } = r;
    if (drag.mode === 'move') {
      start = addDays(start, drag.delta);
      end = addDays(end, drag.delta);
    } else if (drag.mode === 'start') start = addDays(start, Math.min(drag.delta, diffDays(start, end)));
    else end = addDays(end, Math.max(drag.delta, -diffDays(start, end)));
    return { start, end };
  };

  const beginDrag = (e: React.PointerEvent, row: Row, mode: DragState['mode']) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const state = { rowId: row.id, mode, x: e.clientX, delta: 0 };
    dragRef.current = state;
    setDrag(state);
    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      dragRef.current = { ...dragRef.current, delta: Math.round((ev.clientX - dragRef.current.x) / px) };
      setDrag(dragRef.current);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const final = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!final) return;
      if (final.delta === 0 && Math.abs(ev.clientX - final.x) < 4) {
        openRow(row.id);
        return;
      }
      const r = range(row);
      if (!r) return;
      const s = final.mode === 'end' ? r.start : addDays(r.start, final.mode === 'start' ? Math.min(final.delta, diffDays(r.start, r.end)) : final.delta);
      const en = final.mode === 'start' ? r.end : addDays(r.end, final.mode === 'end' ? Math.max(final.delta, -diffDays(r.start, r.end)) : final.delta);
      actions.updateCell(row.id, startField.id, iso(s));
      if (endField) actions.updateCell(row.id, endField.id, iso(en));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const t = today();
  const todayX = diffDays(origin, t) * px;
  const months: { label: string; x: number; width: number }[] = [];
  for (const d of days) {
    if (d.getDate() === 1 || months.length === 0) months.push({ label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), x: diffDays(origin, d) * px, width: 0 });
  }
  months.forEach((m, i) => (m.width = (months[i + 1]?.x ?? span * px) - m.x));

  return (
    // Dates run left to right in every language (bars are placed by measured positions).
    <div dir="ltr" className={clsx('pt-3 pb-8', !embedded && 'px-6 sm:px-[54px]')}>
      <div className="mb-2 flex items-center gap-1">
        <div className="flex rounded-md border border-line p-0.5 text-xs">
          {(['day', 'week', 'month'] as const).map((s) => (
            <button key={s} onClick={() => setScale(s)} className={clsx('rounded px-2 py-1 capitalize', scale === s ? 'bg-active font-medium' : 'text-muted hover:text-fg')}>
              {s}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setOrigin(addDays(origin, -Math.round(span / 3)))} className="rounded-md p-1.5 text-muted hover:bg-hover" aria-label="Earlier">
            <ChevronLeft size={16} />
          </button>
          <button onClick={() => setOrigin(addDays(today(), scale === 'day' ? -7 : scale === 'week' ? -21 : -60))} className="rounded-md px-2 py-1 text-sm hover:bg-hover">
            Today
          </button>
          <button onClick={() => setOrigin(addDays(origin, Math.round(span / 3)))} className="rounded-md p-1.5 text-muted hover:bg-hover" aria-label="Later">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="flex overflow-hidden rounded-lg border border-line">
        {/* Row titles */}
        <div className="w-52 shrink-0 border-r border-line bg-bg">
          <div className="flex h-[52px] items-end border-b border-line px-3 pb-1.5 text-xs font-medium text-faint">Name</div>
          {rows.map((row) => (
            <button key={row.id} onClick={() => openRow(row.id)} className="flex w-full items-center truncate border-b border-line px-3 text-left text-sm hover:bg-hover" style={{ height: ROW_H }}>
              <span className={clsx('truncate', !rowTitle(db.fields, row) && 'text-faint')}>{rowTitle(db.fields, row) || 'Untitled'}</span>
            </button>
          ))}
          {!readOnly && (
            <button
              onClick={() => openRow(actions.addRow({ [startField.id]: iso(t), ...(endField ? { [endField.id]: iso(addDays(t, 2)) } : {}) }))}
              className="flex w-full items-center gap-1.5 px-3 text-sm text-muted hover:bg-hover hover:text-fg"
              style={{ height: ROW_H }}
            >
              <Plus size={14} /> New
            </button>
          )}
        </div>

        {/* Time grid */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative" style={{ width: span * px }}>
            <div className="relative h-6 border-b border-line">
              {months.map((m) => (
                <div key={m.x} className="absolute top-0 truncate border-l border-line px-2 text-xs leading-6 font-medium" style={{ left: m.x, width: m.width }}>
                  {m.label}
                </div>
              ))}
            </div>
            <div className="relative h-[27px] border-b border-line">
              {days.map((d, i) =>
                scale === 'month' ? null : scale === 'week' && d.getDay() !== 1 ? null : (
                  <div key={i} className={clsx('absolute top-0 text-center text-[11px] leading-[27px]', iso(d) === iso(t) ? 'font-semibold text-accent' : 'text-faint')} style={{ left: i * px, width: scale === 'week' ? px * 7 : px }}>
                    {d.getDate()}
                  </div>
                ),
              )}
            </div>

            {/* Weekend shading and today line */}
            <div className="pointer-events-none absolute right-0 left-0" style={{ top: 52, bottom: 0 }}>
              {scale === 'day' && days.map((d, i) => (d.getDay() === 0 || d.getDay() === 6 ? <div key={i} className="absolute top-0 bottom-0 bg-hover" style={{ left: i * px, width: px }} /> : null))}
              {todayX >= 0 && todayX <= span * px && <div className="absolute top-0 bottom-0 w-0.5 bg-accent/70" style={{ left: todayX + px / 2 }} />}
            </div>

            {rows.map((row) => {
              const r = preview(row);
              const option = colorField ? colorField.options?.find((o) => o.id === row.cells[colorField.id]) : undefined;
              const bg = option ? OPTION_COLORS[option.color] : 'var(--accent-soft)';
              return (
                <div key={row.id} className="relative border-b border-line" style={{ height: ROW_H }}>
                  {r ? (
                    <div
                      onPointerDown={(e) => beginDrag(e, row, 'move')}
                      className={clsx(
                        'group absolute top-1.5 flex items-center overflow-hidden rounded-md border border-line px-2 text-xs font-medium shadow-sm select-none',
                        readOnly ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
                        drag?.rowId === row.id && 'ring-2 ring-accent',
                      )}
                      style={{ left: diffDays(origin, r.start) * px, width: Math.max(px, (diffDays(r.start, r.end) + 1) * px), height: ROW_H - 12, background: bg }}
                      title={`${rowTitle(db.fields, row) || 'Untitled'}: ${r.start.toLocaleDateString()} – ${r.end.toLocaleDateString()}`}
                      onClick={(e) => readOnly && (e.stopPropagation(), openRow(row.id))}
                    >
                      {!readOnly && (
                        <span onPointerDown={(e) => beginDrag(e, row, 'start')} className="absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize opacity-0 group-hover:bg-accent/50 group-hover:opacity-100" />
                      )}
                      <span className="truncate">{rowTitle(db.fields, row) || 'Untitled'}</span>
                      {!readOnly && endField && (
                        <span onPointerDown={(e) => beginDrag(e, row, 'end')} className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize opacity-0 group-hover:bg-accent/50 group-hover:opacity-100" />
                      )}
                    </div>
                  ) : (
                    !readOnly && (
                      <button
                        onClick={() => {
                          actions.updateCell(row.id, startField.id, iso(t));
                          if (endField) actions.updateCell(row.id, endField.id, iso(addDays(t, 2)));
                        }}
                        className="absolute top-2 rounded px-2 py-0.5 text-xs text-faint hover:bg-hover hover:text-fg"
                        style={{ left: Math.max(0, todayX) }}
                      >
                        + Schedule
                      </button>
                    )
                  )}
                </div>
              );
            })}
            {!readOnly && <div style={{ height: ROW_H }} />}
            {deps && <DependencyArrows rows={rows} range={preview} origin={origin} px={px} blockedBy={deps.blockedByField} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Arrows from each card to the cards it blocks: from the end of one bar to the start of the next (red when they overlap). */
function DependencyArrows({
  rows,
  range,
  origin,
  px,
  blockedBy,
}: {
  rows: Row[];
  range: (row: Row) => { start: Date; end: Date } | null;
  origin: Date;
  px: number;
  blockedBy: string;
}) {
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const lines: { d: string; late: boolean; key: string }[] = [];
  rows.forEach((row, i) => {
    const to = range(row);
    const ids = Array.isArray(row.cells[blockedBy]) ? (row.cells[blockedBy] as string[]) : [];
    if (!to) return;
    for (const id of ids) {
      const j = index.get(id);
      const blocker = j === undefined ? undefined : rows[j];
      const from = blocker && range(blocker);
      if (!from || j === undefined) continue;
      const x1 = (diffDays(origin, from.end) + 1) * px;
      const y1 = j * ROW_H + ROW_H / 2;
      const x2 = diffDays(origin, to.start) * px;
      const y2 = i * ROW_H + ROW_H / 2;
      const bend = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 16));
      lines.push({ key: `${id}-${row.id}`, late: to.start <= from.end, d: `M ${x1} ${y1} H ${bend} V ${y2} H ${x2 - 2}` });
    }
  });
  if (!lines.length) return null;
  return (
    <svg className="pointer-events-none absolute left-0 overflow-visible" style={{ top: 52, width: '100%', height: rows.length * ROW_H }}>
      <defs>
        <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" />
        </marker>
        <marker id="dep-arrow-late" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#ef4444" />
        </marker>
      </defs>
      {lines.map((l) => (
        <path key={l.key} d={l.d} fill="none" stroke={l.late ? '#ef4444' : 'var(--muted)'} strokeWidth={1.5} markerEnd={`url(#${l.late ? 'dep-arrow-late' : 'dep-arrow'})`} />
      ))}
    </svg>
  );
}
