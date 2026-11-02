import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type Anchor, Popover } from '../components/ui';
import { useDb } from './context';
import { type Row, rowTitle, todayISO, type View, viewRows } from './model';

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function CalendarView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, openRow } = useDb();
  const dateField = db.fields.find((f) => f.id === view.dateField && f.type === 'date');
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [unscheduled, setUnscheduled] = useState<Anchor | null>(null);

  const rows = viewRows(db, view);
  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    if (!dateField) return map;
    for (const r of rows) {
      const v = r.cells[dateField.id];
      if (typeof v !== 'string' || !v) continue;
      const key = v.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return map;
  }, [rows, dateField]);

  if (!dateField) {
    return (
      <div className={clsx('py-12 text-center text-sm text-muted', !embedded && 'px-6')}>
        Choose a date property to lay out rows, using <b>Date field</b> in the toolbar.
      </div>
    );
  }

  const undated = rows.filter((r) => !r.cells[dateField.id]);
  const start = new Date(month);
  start.setDate(1 - month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = todayISO();
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <div className={clsx('pt-3 pb-8', !embedded && 'px-6 sm:px-[54px]')}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        <div className="ms-auto flex items-center gap-1">
          {undated.length > 0 && (
            <button onClick={(e) => setUnscheduled(e.currentTarget.getBoundingClientRect())} className="me-2 rounded-md px-2 py-1 text-sm text-muted hover:bg-hover hover:text-fg">
              Unscheduled ({undated.length})
            </button>
          )}
          <button onClick={() => shift(-1)} className="rounded-md p-1.5 text-muted hover:bg-hover" aria-label="Previous month">
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => {
              const d = new Date();
              setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
            className="rounded-md px-2 py-1 text-sm hover:bg-hover"
          >
            Today
          </button>
          <button onClick={() => shift(1)} className="rounded-md p-1.5 text-muted hover:bg-hover" aria-label="Next month">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-t border-s border-line text-sm">
        {WEEKDAYS.map((d) => (
          <div key={d} className="border-e border-b border-line px-2 py-1.5 text-xs font-medium text-faint">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const key = iso(d);
          const inMonth = d.getMonth() === month.getMonth();
          const events = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              onDragOver={(e) => {
                if (!dragRow) return;
                e.preventDefault();
                setOverDay(key);
              }}
              onDrop={(e) => {
                if (!dragRow) return;
                e.preventDefault();
                actions.updateCell(dragRow, dateField.id, key);
                setDragRow(null);
                setOverDay(null);
              }}
              className={clsx(
                'group relative min-h-[110px] border-e border-b border-line p-1',
                !inMonth && 'bg-sidebar/60',
                overDay === key && 'bg-accent-soft',
              )}
            >
              <div className="mb-1 flex items-center justify-between px-0.5">
                <button
                  onClick={() => openRow(actions.addRow({ [dateField.id]: key }))}
                  className="rounded p-0.5 text-faint hover-reveal opacity-0 group-hover:opacity-100 hover:bg-active hover:text-fg"
                  title="New row on this day"
                >
                  <Plus size={13} />
                </button>
                <span
                  className={clsx(
                    'flex size-6 items-center justify-center rounded-full text-xs',
                    key === today ? 'bg-accent font-semibold text-white' : inMonth ? 'text-fg' : 'text-faint',
                  )}
                >
                  {d.getDate()}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                {events.map((r) => (
                  <button
                    key={r.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', r.id);
                      setDragRow(r.id);
                    }}
                    onDragEnd={() => {
                      setDragRow(null);
                      setOverDay(null);
                    }}
                    onClick={() => openRow(r.id)}
                    className={clsx(
                      'truncate rounded-md border border-line bg-card px-1.5 py-0.5 text-start text-xs shadow-[0_1px_1px_rgba(0,0,0,0.04)] hover:border-faint/60',
                      dragRow === r.id && 'opacity-40',
                    )}
                  >
                    {rowTitle(db.fields, r) || <span className="text-faint">Untitled</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Popover anchor={unscheduled} onClose={() => setUnscheduled(null)} align="end" className="max-h-80 w-64 overflow-y-auto p-1">
        <div className="px-2 pt-1 pb-1 text-xs font-medium text-faint">Rows without a {dateField.name.toLowerCase()}</div>
        {undated.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              setUnscheduled(null);
              openRow(r.id);
            }}
            className="block w-full truncate rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover"
          >
            {rowTitle(db.fields, r) || <span className="text-faint">Untitled</span>}
          </button>
        ))}
      </Popover>
    </div>
  );
}
