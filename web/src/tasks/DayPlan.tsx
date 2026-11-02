import clsx from 'clsx';
import { Repeat } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toastError } from '../components/ui';
import { type CalendarEvent, COLOR_HEX, createEvent, updateEvent, useCalendar } from '../calendar/api';
import { occurrencesBetween } from '../calendar/repeat';

// Time blocking: the day as a column of hours. Tasks from the list are dragged onto it to give them a
// time; blocks are dragged to move them and by their bottom edge to change how long they take.

/** What the task list puts on a drag, so the plan knows what was dropped. */
export const PLAN_DRAG = 'application/x-af-plan-task';
export interface PlanDrop {
  kind: 'event' | 'card' | 'block';
  eventId?: string;
  title: string;
}

const START_HOUR = 6;
const END_HOUR = 24;
const HOUR_PX = 48;
const SNAP = 15;

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const toTime = (min: number) => {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const snap = (min: number) => Math.round(min / SNAP) * SNAP;
const label = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

interface Block {
  event: CalendarEvent;
  start: number;
  end: number;
  /** Repeating events are shown but moved from the calendar (moving one would move them all). */
  fixed: boolean;
}

export function DayPlan({ workspaceId, day, onOpen, onChanged }: { workspaceId: string; day: string; onOpen: (eventId: string) => void; onChanged: () => void }) {
  const cal = useCalendar(workspaceId, day, day);
  const grid = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<number | null>(null);
  // While a block is being moved or stretched: its new start and end (minutes).
  const [drag, setDrag] = useState<{ id: string; start: number; end: number } | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Scroll to the morning (or the current hour) the first time.
  useEffect(() => {
    const el = grid.current?.parentElement;
    if (!el) return;
    const h = Math.max(START_HOUR, Math.min(now.getHours() - 1, 20));
    el.scrollTop = (h - START_HOUR) * HOUR_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blocks = useMemo<Block[]>(() => {
    const list: Block[] = [];
    for (const e of cal.data?.events ?? []) {
      if (!e.startTime) continue;
      const onDay = e.repeat ? occurrencesBetween(e.repeat, day, day).length > 0 : e.startDate === day || (e.startDate < day && (e.endDate ?? e.startDate) >= day);
      if (!onDay) continue;
      const start = e.startDate === day || e.repeat ? toMin(e.startTime) : 0;
      const end = e.endTime && (!e.endDate || e.endDate === day || e.repeat) ? toMin(e.endTime) : e.endDate && e.endDate > day ? 24 * 60 : start + 60;
      list.push({ event: e, start, end: Math.max(end, start + SNAP), fixed: !!e.repeat });
    }
    return list.sort((a, b) => a.start - b.start);
  }, [cal.data, day]);

  // Side by side when they overlap.
  const placed = useMemo(() => {
    const cols: { block: Block; col: number; cols: number }[] = [];
    let group: typeof cols = [];
    let groupEnd = -1;
    const flush = () => {
      const n = Math.max(1, ...group.map((g) => g.col + 1));
      for (const g of group) g.cols = n;
      group = [];
    };
    for (const b of blocks) {
      if (b.start >= groupEnd) {
        flush();
        groupEnd = -1;
      }
      const used = new Set(group.filter((g) => g.block.end > b.start).map((g) => g.col));
      let col = 0;
      while (used.has(col)) col++;
      const item = { block: b, col, cols: 1 };
      group.push(item);
      cols.push(item);
      groupEnd = Math.max(groupEnd, b.end);
    }
    flush();
    return cols;
  }, [blocks]);

  const minuteAt = (clientY: number) => {
    const box = grid.current!.getBoundingClientRect();
    return START_HOUR * 60 + ((clientY - box.top) / HOUR_PX) * 60;
  };

  const save = async (id: string, start: number, end: number) => {
    try {
      await updateEvent(workspaceId, id, { startDate: day, startTime: toTime(start), endDate: null, endTime: toTime(Math.min(end, 24 * 60 - 1)) });
      onChanged();
    } catch (err) {
      toastError(err);
    }
  };

  // A task dropped on the plan gets that time: calendar tasks move there; cards and dated to-dos get a
  // time block on the calendar with their name.
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const raw = e.dataTransfer.getData(PLAN_DRAG);
    if (!raw) return;
    const task = JSON.parse(raw) as PlanDrop;
    const start = snap(minuteAt(e.clientY));
    try {
      if (task.kind === 'event' && task.eventId) {
        const existing = cal.data?.events.find((x) => x.id === task.eventId);
        const length = existing?.startTime && existing.endTime && !existing.endDate ? Math.max(SNAP, toMin(existing.endTime) - toMin(existing.startTime)) : 60;
        await updateEvent(workspaceId, task.eventId, { startDate: day, startTime: toTime(start), endDate: null, endTime: toTime(start + length) });
      } else {
        await createEvent(workspaceId, { title: task.title, startDate: day, startTime: toTime(start), endTime: toTime(start + 60), color: 'purple' });
      }
      onChanged();
    } catch (err) {
      toastError(err);
    }
  };

  // Clicking an empty slot adds a block there and opens it to name it.
  const addAt = async (clientY: number) => {
    const start = snap(minuteAt(clientY) - 15);
    try {
      const ev = await createEvent(workspaceId, { title: 'Focus time', startDate: day, startTime: toTime(start), endTime: toTime(start + 60), color: 'purple' });
      onChanged();
      onOpen(ev.id);
    } catch (err) {
      toastError(err);
    }
  };

  const beginDrag = (e: React.PointerEvent, b: Block, mode: 'move' | 'resize') => {
    if (b.fixed || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = minuteAt(e.clientY);
    let moved = false;
    let current = { id: b.event.id, start: b.start, end: b.end };
    const onMove = (ev: PointerEvent) => {
      const delta = snap(minuteAt(ev.clientY) - from);
      if (Math.abs(ev.clientY - e.clientY) > 3) moved = true;
      if (!moved) return;
      current =
        mode === 'move'
          ? { id: b.event.id, start: Math.max(0, b.start + delta), end: Math.max(0, b.start + delta) + (b.end - b.start) }
          : { id: b.event.id, start: b.start, end: Math.max(b.start + SNAP, b.end + delta) };
      setDrag(current);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDrag(null);
      if (!moved) return onOpen(b.event.id);
      if (current.start !== b.start || current.end !== b.end) void save(b.event.id, current.start, current.end);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
  const isToday = day === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-1 pb-2 text-xs text-muted">Drag tasks here to give them a time. Drag a block to move it, or its bottom edge to change how long it takes.</div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-line bg-surface">
        <div
          ref={grid}
          className="relative ms-12 border-s border-line"
          style={{ height: hours.length * HOUR_PX }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PLAN_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOver(snap(minuteAt(e.clientY)));
          }}
          onDragLeave={() => setOver(null)}
          onDrop={onDrop}
          onClick={(e) => e.target === e.currentTarget && void addAt(e.clientY)}
        >
          {hours.map((h, i) => (
            <div key={h} className="pointer-events-none absolute end-0 start-0 border-t border-line/70" style={{ top: i * HOUR_PX }}>
              <span className="absolute -top-2 -start-12 w-10 pe-1 text-end text-[10px] text-faint">{label(h)}</span>
            </div>
          ))}
          {isToday && nowMin >= START_HOUR * 60 && (
            <div className="pointer-events-none absolute end-0 start-0 z-20 border-t-2 border-red-500" style={{ top: ((nowMin - START_HOUR * 60) / 60) * HOUR_PX }}>
              <span className="absolute -top-[5px] -start-[5px] size-2 rounded-full bg-red-500" />
            </div>
          )}
          {over !== null && (
            <div
              className="pointer-events-none absolute end-1 start-1 z-10 rounded-md border-2 border-dashed border-accent bg-accent/10 text-[11px] text-accent"
              style={{ top: ((over - START_HOUR * 60) / 60) * HOUR_PX, height: HOUR_PX }}
            >
              <span className="px-1.5">{toTime(over)}</span>
            </div>
          )}
          {placed.map(({ block: b, col, cols }) => {
            const live = drag?.id === b.event.id ? drag : null;
            const start = live?.start ?? b.start;
            const end = live?.end ?? b.end;
            const top = ((Math.max(start, START_HOUR * 60) - START_HOUR * 60) / 60) * HOUR_PX;
            const height = Math.max(18, ((end - Math.max(start, START_HOUR * 60)) / 60) * HOUR_PX - 2);
            const color = COLOR_HEX[b.event.color] ?? COLOR_HEX.blue;
            const done = b.event.status === 'done';
            return (
              <div
                key={b.event.id}
                onPointerDown={(e) => beginDrag(e, b, 'move')}
                onClick={() => b.fixed && onOpen(b.event.id)}
                className={clsx(
                  'absolute overflow-hidden rounded-md border-s-[3px] px-1.5 py-0.5 text-xs shadow-sm select-none',
                  b.fixed ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
                  live && 'z-30 opacity-90 shadow-pop',
                  done && 'opacity-60',
                )}
                style={{
                  top,
                  height,
                  left: `calc(${(col / cols) * 100}% + 2px)`,
                  width: `calc(${100 / cols}% - 4px)`,
                  background: `color-mix(in srgb, ${color} 18%, var(--surface))`,
                  borderColor: color,
                }}
                title={b.fixed ? 'Repeats — change it from the calendar' : undefined}
              >
                <div className={clsx('flex items-center gap-1 truncate font-medium', done && 'line-through')}>
                  {b.event.status && <span>{done ? '✓' : '☐'}</span>}
                  <span className="truncate">{b.event.title || 'Untitled'}</span>
                  {b.fixed && <Repeat size={10} className="shrink-0 text-muted" />}
                </div>
                {height > 30 && (
                  <div className="text-[10px] text-muted">
                    {toTime(start)}–{toTime(end)}
                  </div>
                )}
                {!b.fixed && <div onPointerDown={(e) => beginDrag(e, b, 'resize')} className="absolute end-0 bottom-0 start-0 h-2 cursor-ns-resize" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
