import clsx from 'clsx';
import {
  CalendarCheck2,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  ListFilter,
  Plus,
  Repeat,
  MoreHorizontal,
  Trash2,
  FileUp,
  Rss,
} from 'lucide-react';
import { type DragEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApp } from '../app/context';
import { PageIcon } from '../app/PageIcon';
import { FeedDialog, importIcs } from './FeedDialog';
import { type Anchor, confirmDialog, IconButton, Menu, MenuDivider, MenuItem, Popover, toast, toastError } from '../components/ui';
import { api, pageTitle } from '../lib/api';
import { queryClient } from '../lib/queries';
import { locationPath } from '../lib/placement';
import { getLocal, setLocal } from '../lib/storage';
import { type CalendarBlock, type CalendarCard, type CalendarEvent, COLOR_HEX, type EventColor, setCardCells, updateEvent, useCalendar } from './api';
import { CardDialog } from './CardDialog';
import { type EventDraft, EventDialog } from './EventDialog';
import { addDays, daysBetween, occurrencesBetween } from './repeat';
import { SidebarIcon } from '../notifications/Notifications';

type View = 'month' | 'week' | 'day' | 'agenda';

const OPTION_HEX: Record<string, string> = { ...COLOR_HEX, default: '#8a8f98' };
const HOUR = 48; // pixels per hour in the week and day views

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayStr = () => ymd(new Date());
const toDate = (s: string) => new Date(`${s}T00:00:00`);

function startOfWeek(d: string, weekStart: 0 | 1) {
  const day = toDate(d).getDay();
  return addDays(d, -((day - weekStart + 7) % 7));
}

function minutes(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function hhmm(min: number) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function timeLabel(t: string) {
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** One thing shown on the calendar: an event (or one of its repeats), a dated card, or a dated block. */
interface Item {
  key: string;
  kind: 'event' | 'card' | 'block';
  title: string;
  date: string;
  end: string; // inclusive last day
  startTime: string | null;
  endTime: string | null;
  color: string;
  done: boolean | null;
  /** A future repeat, shown faintly; it becomes real when the item resets. */
  projected: boolean;
  repeats: boolean;
  subtitle: string;
  event?: CalendarEvent;
  card?: CalendarCard;
  block?: CalendarBlock;
}

function buildItems(data: { events: CalendarEvent[]; cards: CalendarCard[]; blocks: CalendarBlock[] } | undefined, from: string, to: string): Item[] {
  if (!data) return [];
  const out: Item[] = [];
  for (const e of data.events) {
    const span = e.endDate ? daysBetween(e.startDate, e.endDate) : 0;
    const base: Omit<Item, 'key' | 'date' | 'end' | 'projected'> = {
      kind: 'event',
      title: e.title || 'Untitled',
      startTime: e.startTime,
      endTime: e.endTime,
      color: COLOR_HEX[e.color as EventColor] ?? COLOR_HEX.blue,
      done: e.status === null ? null : e.status === 'done',
      repeats: !!e.repeat,
      subtitle: e.locations[0] ? (e.locations[0].rowTitle ?? e.locations[0].pageTitle) : '',
      event: e,
    };
    out.push({ ...base, key: `e:${e.id}`, date: e.startDate, end: addDays(e.startDate, span), projected: false });
    if (e.repeat) {
      for (const d of occurrencesBetween(e.repeat, from, to)) {
        if (d <= e.startDate) continue;
        out.push({ ...base, key: `e:${e.id}:${d}`, date: d, end: addDays(d, span), projected: true, done: e.status === null ? null : false });
      }
    }
  }
  for (const c of data.cards) {
    const span = c.endDate ? daysBetween(c.date, c.endDate) : 0;
    const base: Omit<Item, 'key' | 'date' | 'end' | 'projected'> = {
      kind: 'card',
      title: c.title || 'Untitled',
      startTime: null,
      endTime: null,
      color: OPTION_HEX[c.statusColor ?? 'default'] ?? OPTION_HEX.default,
      done: null,
      repeats: !!c.repeat,
      subtitle: `${c.pageTitle || 'Untitled'}${c.status ? ` · ${c.status}` : ''}`,
      card: c,
    };
    out.push({ ...base, key: `c:${c.pageId}:${c.rowId}:${c.fieldId}`, date: c.date, end: addDays(c.date, span), projected: false });
    if (c.repeat) {
      for (const d of occurrencesBetween(c.repeat, from, to)) {
        if (d <= c.date) continue;
        out.push({ ...base, key: `c:${c.pageId}:${c.rowId}:${c.fieldId}:${d}`, date: d, end: addDays(d, span), projected: true });
      }
    }
  }
  for (const b of data.blocks) {
    out.push({
      key: `b:${b.pageId}:${b.rowId ?? ''}:${b.blockId}:${b.date}`,
      kind: 'block',
      title: b.text || 'Untitled block',
      date: b.date,
      end: b.date,
      startTime: null,
      endTime: null,
      color: '#8a8f98',
      done: b.done,
      projected: false,
      repeats: false,
      subtitle: b.rowTitle ? `${b.pageTitle} › ${b.rowTitle}` : b.pageTitle || 'Untitled',
      block: b,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.title.localeCompare(b.title));
}

interface Filters {
  events: boolean;
  tasks: boolean;
  cards: boolean;
  blocks: boolean;
  repeats: boolean;
  hideDone: boolean;
  hiddenDatabases: string[];
}

const DEFAULT_FILTERS: Filters = { events: true, tasks: true, cards: true, blocks: true, repeats: true, hideDone: false, hiddenDatabases: [] };

/** The Calendar screen: every event, task, dated card and dated block in the workspace. */
export function CalendarPage() {
  const { workspace, sidebarOpen, toggleSidebar, pages } = useApp();
  const navigate = useNavigate();
  const [view, setView] = useState<View>(() => getLocal<View>('atrium-cal-view', window.innerWidth < 640 ? 'agenda' : 'month'));
  const [params] = useSearchParams();
  // Links from reminders open the calendar on the event's day (?date=YYYY-MM-DD).
  const [cursor, setCursor] = useState(() => {
    const d = params.get('date');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayStr();
  });
  const [weekStart, setWeekStart] = useState<0 | 1>(() => getLocal<0 | 1>('atrium-cal-week-start', 1));
  const [filters, setFilters] = useState<Filters>(() => ({ ...DEFAULT_FILTERS, ...getLocal<Partial<Filters>>('atrium-cal-filters', {}) }));
  const [filterAnchor, setFilterAnchor] = useState<Anchor | null>(null);
  const [newMenu, setNewMenu] = useState<Anchor | null>(null);
  const [moreMenu, setMoreMenu] = useState<Anchor | null>(null);
  const [feedOpen, setFeedOpen] = useState(false);
  // Clearing out events and tasks that only live on the calendar (not in any page or card).
  const deleteUnplaced = async () => {
    try {
      const { count, everyone } = await api<{ count: number; everyone: boolean }>(`/api/workspaces/${workspace.id}/events/unplaced`);
      if (!count) return toast('Every event and task is in a page — nothing to delete');
      const ok = await confirmDialog({
        title: `Delete ${count} event${count === 1 ? '' : 's'} and task${count === 1 ? '' : 's'}?`,
        message: `${everyone ? 'All' : 'Your'} events and tasks that aren't in any page or card (counting pages in the trash as gone) will be deleted. Ones placed in pages stay. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const { deleted } = await api<{ deleted: number }>(`/api/workspaces/${workspace.id}/events/unplaced`, { method: 'DELETE' });
      toast(`Deleted ${deleted} event${deleted === 1 ? '' : 's'} and task${deleted === 1 ? '' : 's'}`);
      queryClient.invalidateQueries({ queryKey: ['calendar', workspace.id] });
      queryClient.invalidateQueries({ queryKey: ['tasks', workspace.id] });
    } catch (err) {
      toastError(err);
    }
  };
  const [eventDialog, setEventDialog] = useState<{ id: string | null; draft?: EventDraft } | null>(null);
  const [cardDialog, setCardDialog] = useState<CalendarCard | null>(null);

  useEffect(() => setLocal('atrium-cal-view', view), [view]);
  useEffect(() => setLocal('atrium-cal-week-start', weekStart), [weekStart]);
  useEffect(() => setLocal('atrium-cal-filters', filters), [filters]);
  useEffect(() => {
    document.title = `Calendar · ${workspace.name}`;
  }, [workspace.name]);

  // The dates on screen.
  const range = useMemo(() => {
    if (view === 'month') {
      const first = `${cursor.slice(0, 7)}-01`;
      const from = startOfWeek(first, weekStart);
      return { from, to: addDays(from, 41) };
    }
    if (view === 'week') {
      const from = startOfWeek(cursor, weekStart);
      return { from, to: addDays(from, 6) };
    }
    if (view === 'day') return { from: cursor, to: cursor };
    return { from: cursor, to: addDays(cursor, 59) };
  }, [view, cursor, weekStart]);

  const data = useCalendar(workspace.id, range.from, range.to);
  const databases = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of data.data?.cards ?? []) seen.set(c.pageId, c.pageTitle || 'Untitled');
    return [...seen.entries()];
  }, [data.data]);

  const items = useMemo(
    () =>
      buildItems(data.data, range.from, range.to).filter((i) => {
        if (i.projected && !filters.repeats) return false;
        if (filters.hideDone && i.done) return false;
        if (i.kind === 'event') return i.event!.status === null ? filters.events : filters.tasks;
        if (i.kind === 'card') return filters.cards && !filters.hiddenDatabases.includes(i.card!.pageId);
        return filters.blocks;
      }),
    [data.data, range, filters],
  );

  const move = (delta: number) => {
    if (view === 'month') {
      const d = toDate(`${cursor.slice(0, 7)}-01`);
      d.setMonth(d.getMonth() + delta);
      setCursor(ymd(d));
    } else setCursor(addDays(cursor, delta * (view === 'week' ? 7 : view === 'day' ? 1 : 30)));
  };

  const title = useMemo(() => {
    const d = toDate(cursor);
    if (view === 'month') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (view === 'day') return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const a = toDate(range.from);
    const b = toDate(range.to);
    const sameMonth = a.getMonth() === b.getMonth();
    return `${a.toLocaleDateString(undefined, { day: 'numeric', month: sameMonth ? undefined : 'short' })} – ${b.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }, [cursor, view, range]);

  const open = (i: Item) => {
    if (i.kind === 'event') setEventDialog({ id: i.event!.id });
    else if (i.kind === 'card') setCardDialog(i.card!);
    else navigate(locationPath(workspace.id, { pageId: i.block!.pageId, rowId: i.block!.rowId }, i.block!.blockId));
  };

  /** Drag-and-drop rescheduling: moves the event or card (keeping its length) to another day or time. */
  const reschedule = async (i: Item, date: string, startTime?: string | null) => {
    if (i.projected) return;
    try {
      if (i.kind === 'event') {
        const e = i.event!;
        const shift = daysBetween(e.startDate, date);
        const patch: Parameters<typeof updateEvent>[2] = { startDate: date, endDate: e.endDate ? addDays(e.endDate, shift) : null };
        if (startTime !== undefined && e.startTime && startTime) {
          const length = e.endTime ? minutes(e.endTime) - minutes(e.startTime) : 60;
          patch.startTime = startTime;
          patch.endTime = hhmm(minutes(startTime) + length);
        }
        if (shift === 0 && patch.startTime === undefined) return;
        await updateEvent(workspace.id, e.id, patch);
      } else if (i.kind === 'card') {
        const c = i.card!;
        if (c.date === date) return;
        await setCardCells(workspace.id, c.pageId, c.rowId, { [c.fieldId]: date });
      }
    } catch (err) {
      toastError(err);
    }
  };

  const toggleDone = async (i: Item) => {
    if (i.kind !== 'event' || i.projected) return;
    try {
      await updateEvent(workspace.id, i.event!.id, { status: i.event!.status === 'done' ? 'todo' : 'done' });
    } catch (err) {
      toastError(err);
    }
  };

  const newAt = (draft: EventDraft) => setEventDialog({ id: null, draft });
  const ctx: CalendarCtx = { items, open, reschedule, toggleDone, newAt, weekStart };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        {!sidebarOpen && (
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        )}
        <h1 className="me-2 flex items-center gap-2 text-lg font-semibold">
          <CalendarDays size={19} className="text-muted" /> Calendar
        </h1>
        <button onClick={() => setCursor(todayStr())} className="h-8 rounded-lg border border-line px-3 text-sm hover:bg-hover">
          Today
        </button>
        <div className="flex">
          <IconButton onClick={() => move(-1)} title="Previous">
            <ChevronLeft size={18} />
          </IconButton>
          <IconButton onClick={() => move(1)} title="Next">
            <ChevronRight size={18} />
          </IconButton>
        </div>
        <div className="min-w-0 flex-1 truncate text-[15px] font-medium">{title}</div>
        <div className="inline-flex rounded-lg border border-line p-0.5">
          {(['month', 'week', 'day', 'agenda'] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)} className={clsx('h-7 rounded-md px-2.5 text-sm capitalize sm:px-3', view === v ? 'bg-active font-medium' : 'text-muted hover:text-fg')}>
              {v}
            </button>
          ))}
        </div>
        <IconButton onClick={(e) => setFilterAnchor(e.currentTarget.getBoundingClientRect())} title="Show and hide">
          <ListFilter size={17} />
        </IconButton>
        <IconButton onClick={(e) => setMoreMenu(e.currentTarget.getBoundingClientRect())} title="More">
          <MoreHorizontal size={17} />
        </IconButton>
        <Menu anchor={moreMenu} onClose={() => setMoreMenu(null)} align="end">
          <MenuItem icon={<Rss size={15} />} label="Subscribe in another calendar app…" onClick={() => setFeedOpen(true)} />
          <MenuItem icon={<FileUp size={15} />} label="Import a calendar file (.ics)…" onClick={() => importIcs(workspace.id)} />
          <MenuDivider />
          <MenuItem icon={<Trash2 size={15} />} label="Delete events and tasks not in any page…" danger onClick={deleteUnplaced} />
        </Menu>
        {feedOpen && <FeedDialog workspaceId={workspace.id} onClose={() => setFeedOpen(false)} />}
        <button
          onClick={(e) => setNewMenu(e.currentTarget.getBoundingClientRect())}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-white hover:brightness-110"
        >
          <Plus size={16} /> New
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'month' && <MonthView ctx={ctx} from={range.from} month={cursor.slice(0, 7)} />}
        {(view === 'week' || view === 'day') && <TimeView ctx={ctx} days={view === 'day' ? [cursor] : Array.from({ length: 7 }, (_, i) => addDays(range.from, i))} />}
        {view === 'agenda' && <AgendaView ctx={ctx} from={range.from} to={range.to} loading={data.isPending} />}
      </div>

      <Menu anchor={newMenu} onClose={() => setNewMenu(null)} align="end">
        <MenuItem icon={<CalendarDays size={15} />} label="Event" onClick={() => newAt({ startDate: cursor })} />
        <MenuItem icon={<CalendarCheck2 size={15} />} label="Task" onClick={() => newAt({ startDate: cursor, status: 'todo' })} />
      </Menu>

      <Popover anchor={filterAnchor} onClose={() => setFilterAnchor(null)} align="end">
        <div className="w-72 space-y-1 p-3 text-sm">
          <div className="mb-1 text-xs font-medium text-muted">Show</div>
          {(
            [
              ['events', 'Events'],
              ['tasks', 'Tasks'],
              ['cards', 'Database cards'],
              ['blocks', 'Dates in pages'],
              ['repeats', 'Upcoming repeats'],
            ] as const
          ).map(([k, label]) => (
            <Toggle key={k} label={label} checked={filters[k]} onChange={(v) => setFilters((f) => ({ ...f, [k]: v }))} />
          ))}
          <Toggle label="Hide done tasks" checked={filters.hideDone} onChange={(v) => setFilters((f) => ({ ...f, hideDone: v }))} />
          {filters.cards && databases.length > 0 && (
            <>
              <div className="mt-3 mb-1 text-xs font-medium text-muted">Databases</div>
              {databases.map(([id, name]) => {
                const page = pages.find((p) => p.id === id);
                return (
                  <Toggle
                    key={id}
                    label={
                      <span className="flex min-w-0 items-center gap-1.5">
                        {page && <PageIcon page={page} size={14} />}
                        <span className="truncate">{page ? pageTitle(page) : name}</span>
                      </span>
                    }
                    checked={!filters.hiddenDatabases.includes(id)}
                    onChange={(v) => setFilters((f) => ({ ...f, hiddenDatabases: v ? f.hiddenDatabases.filter((x) => x !== id) : [...f.hiddenDatabases, id] }))}
                  />
                );
              })}
            </>
          )}
          <div className="mt-3 mb-1 text-xs font-medium text-muted">Weeks start on</div>
          <div className="inline-flex rounded-lg border border-line p-0.5">
            {([1, 0] as const).map((d) => (
              <button key={d} onClick={() => setWeekStart(d)} className={clsx('h-7 rounded-md px-3 text-sm', weekStart === d ? 'bg-active font-medium' : 'text-muted')}>
                {d === 1 ? 'Monday' : 'Sunday'}
              </button>
            ))}
          </div>
        </div>
      </Popover>

      {eventDialog && <EventDialog eventId={eventDialog.id} draft={eventDialog.draft} onClose={() => setEventDialog(null)} />}
      {cardDialog && <CardDialog card={cardDialog} onClose={() => setCardDialog(null)} />}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: React.ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1">{label}</span>
    </label>
  );
}

interface CalendarCtx {
  items: Item[];
  open: (i: Item) => void;
  reschedule: (i: Item, date: string, startTime?: string | null) => void;
  toggleDone: (i: Item) => void;
  newAt: (draft: EventDraft) => void;
  weekStart: 0 | 1;
}

const DRAG_TYPE = 'application/x-calendar-item';

function itemsOn(items: Item[], day: string) {
  return items.filter((i) => i.date <= day && i.end >= day);
}

function KindIcon({ item, size = 12 }: { item: Item; size?: number }) {
  if (item.kind === 'block') return <FileText size={size} className="shrink-0 opacity-70" />;
  if (item.kind === 'card') return <span className="size-2 shrink-0 rounded-sm" style={{ background: item.color }} />;
  return null;
}

/** A compact item for month cells and all-day lanes. */
function Chip({ item, ctx, draggable = true }: { item: Item; ctx: CalendarCtx; draggable?: boolean }) {
  const movable = draggable && !item.projected && item.kind !== 'block';
  const isEvent = item.kind === 'event';
  return (
    <div
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, item.key);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => {
        e.stopPropagation();
        ctx.open(item);
      }}
      title={`${item.title}${item.subtitle ? ` — ${item.subtitle}` : ''}${item.projected ? ' (upcoming repeat)' : ''}`}
      className={clsx(
        'group/chip flex h-[22px] cursor-pointer items-center gap-1 truncate rounded px-1.5 text-xs leading-none',
        item.projected && 'border border-dashed opacity-60',
        item.done && 'line-through opacity-60',
      )}
      style={
        isEvent && !item.startTime
          ? { background: `${item.color}26`, color: 'var(--fg)', borderColor: item.color }
          : { borderColor: item.color }
      }
    >
      {isEvent && item.done !== null ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleDone(item);
          }}
          className="flex size-3 shrink-0 items-center justify-center rounded-sm border"
          style={{ borderColor: item.color, background: item.done ? item.color : 'transparent' }}
          aria-label={item.done ? 'Mark as not done' : 'Mark as done'}
        >
          {item.done && <Check size={9} className="text-white" strokeWidth={3} />}
        </button>
      ) : isEvent && item.startTime ? (
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: item.color }} />
      ) : (
        <KindIcon item={item} />
      )}
      {item.startTime && <span className="shrink-0 text-faint">{timeLabel(item.startTime)}</span>}
      <span className="truncate">{item.title}</span>
      {item.repeats && <Repeat size={10} className="ms-auto shrink-0 opacity-60" />}
    </div>
  );
}

function useDrop(ctx: CalendarCtx, onDrop: (item: Item, e: DragEvent) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        const key = e.dataTransfer.getData(DRAG_TYPE);
        const item = ctx.items.find((i) => i.key === key);
        if (item) {
          e.preventDefault();
          onDrop(item, e);
        }
      },
    },
  };
}

function MonthView({ ctx, from, month }: { ctx: CalendarCtx; from: string; month: string }) {
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const today = todayStr();
  const names = Array.from({ length: 7 }, (_, i) => toDate(addDays(from, i)).toLocaleDateString(undefined, { weekday: 'short' }));
  return (
    <div className="flex h-full flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-line text-xs text-muted">
        {names.map((n) => (
          <div key={n} className="px-2 py-1.5">
            {n}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((d) => (
          <MonthCell key={d} day={d} ctx={ctx} outside={d.slice(0, 7) !== month} today={d === today} />
        ))}
      </div>
    </div>
  );
}

function MonthCell({ day, ctx, outside, today }: { day: string; ctx: CalendarCtx; outside: boolean; today: boolean }) {
  const list = itemsOn(ctx.items, day);
  const [more, setMore] = useState<Anchor | null>(null);
  const drop = useDrop(ctx, (item) => ctx.reschedule(item, day));
  const cell = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(3);

  // As many items as fit in the cell; the rest go under "+N more".
  useEffect(() => {
    const el = cell.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit(Math.max(1, Math.floor((el.clientHeight - 28) / 24))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shown = list.length > fit ? list.slice(0, fit - 1) : list;

  return (
    <div
      ref={cell}
      {...drop.props}
      onClick={() => ctx.newAt({ startDate: day })}
      className={clsx('min-h-0 cursor-pointer overflow-hidden border-e border-b border-line p-1 transition-colors hover:bg-hover/50', outside && 'bg-sidebar/50', drop.over && 'bg-accent-soft')}
    >
      <div className="mb-0.5 flex justify-end">
        <span className={clsx('flex size-6 items-center justify-center rounded-full text-xs', today ? 'bg-accent font-semibold text-white' : outside ? 'text-faint' : 'text-muted')}>
          {Number(day.slice(8))}
        </span>
      </div>
      <div className="space-y-0.5">
        {shown.map((i) => (
          <Chip key={i.key} item={i} ctx={ctx} />
        ))}
        {list.length > shown.length && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMore(e.currentTarget.getBoundingClientRect());
            }}
            className="w-full rounded px-1.5 text-start text-xs text-muted hover:bg-active"
          >
            +{list.length - shown.length} more
          </button>
        )}
      </div>
      <Popover anchor={more} onClose={() => setMore(null)}>
        <div
          className="w-64 space-y-0.5 p-2"
          onClick={(e) => e.stopPropagation()}
          // Opening one of the items closes this list, so it doesn't sit on top of the item's window
          // (ticking a task's checkbox keeps it open).
          onClickCapture={(e) => {
            // (After the click is handled: closing now would remove the item before its own click runs.)
            if (!(e.target as Element).closest('button')) setTimeout(() => setMore(null));
          }}
        >
          <div className="mb-1 px-1 text-xs font-medium text-muted">{toDate(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          {list.map((i) => (
            <Chip key={i.key} item={i} ctx={ctx} />
          ))}
        </div>
      </Popover>
    </div>
  );
}

/** Side-by-side columns for overlapping timed items in one day. */
function layoutDay(items: Item[]) {
  const timed = items
    .filter((i) => i.startTime)
    .map((i) => {
      const start = minutes(i.startTime!);
      const end = Math.max(start + 20, i.endTime ? minutes(i.endTime) : start + 60);
      return { item: i, start, end, col: 0, cols: 1 };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let group: typeof timed = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1));
    for (const g of group) g.cols = cols;
    group = [];
  };
  for (const t of timed) {
    if (t.start >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    const used = new Set(group.filter((g) => g.end > t.start).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    t.col = col;
    group.push(t);
    groupEnd = Math.max(groupEnd, t.end);
  }
  flush();
  return timed;
}

function TimeView({ ctx, days }: { ctx: CalendarCtx; days: string[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const today = todayStr();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    scroller.current?.scrollTo({ top: HOUR * 7.5 });
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const allDay = (d: string) => itemsOn(ctx.items, d).filter((i) => !i.startTime || i.date !== d);
  const maxAllDay = Math.max(1, ...days.map((d) => allDay(d).length));

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-line">
        <div className="w-14 shrink-0" />
        {days.map((d) => (
          <div key={d} className="min-w-0 flex-1 border-s border-line px-1 py-1.5 text-center">
            <div className="text-xs text-muted">{toDate(d).toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div className={clsx('mx-auto flex size-7 items-center justify-center rounded-full text-sm', d === today && 'bg-accent font-semibold text-white')}>{Number(d.slice(8))}</div>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 border-b border-line">
        <div className="flex w-14 shrink-0 items-center justify-end pe-2 text-[10px] text-faint">all day</div>
        {days.map((d) => (
          <AllDayLane key={d} day={d} items={allDay(d)} ctx={ctx} rows={maxAllDay} />
        ))}
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="flex" style={{ height: HOUR * 24 }}>
          <div className="relative w-14 shrink-0">
            {Array.from({ length: 23 }, (_, h) => (
              <div key={h} className="absolute end-2 -translate-y-1/2 text-[10px] text-faint" style={{ top: (h + 1) * HOUR }}>
                {timeLabel(`${String(h + 1).padStart(2, '0')}:00`)}
              </div>
            ))}
          </div>
          {days.map((d) => (
            <DayColumn key={d} day={d} ctx={ctx} now={d === today ? now : null} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AllDayLane({ day, items, ctx, rows }: { day: string; items: Item[]; ctx: CalendarCtx; rows: number }) {
  const drop = useDrop(ctx, (item) => ctx.reschedule(item, day, null));
  return (
    <div
      {...drop.props}
      onClick={() => ctx.newAt({ startDate: day })}
      className={clsx('min-w-0 flex-1 cursor-pointer space-y-0.5 border-s border-line p-0.5', drop.over && 'bg-accent-soft')}
      style={{ minHeight: Math.min(rows, 4) * 24 + 4 }}
    >
      {items.map((i) => (
        <Chip key={i.key} item={i} ctx={ctx} />
      ))}
    </div>
  );
}

/** One day of the week/day view: drag on empty space to create, drag an event to move it, drag its bottom edge to resize. */
function DayColumn({ day, ctx, now }: { day: string; ctx: CalendarCtx; now: Date | null }) {
  const col = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const [drag, setDrag] = useState<{ key: string; mode: 'move' | 'resize'; offset: number; start: number; end: number; moved: boolean } | null>(null);
  const placed = layoutDay(itemsOn(ctx.items, day).filter((i) => i.date === day));
  const drop = useDrop(ctx, (item, e) => {
    const y = e.clientY - col.current!.getBoundingClientRect().top;
    ctx.reschedule(item, day, hhmm(Math.round(((y / HOUR) * 60) / 15) * 15));
  });

  const minuteAt = (clientY: number) => {
    const y = clientY - col.current!.getBoundingClientRect().top;
    return Math.max(0, Math.min(24 * 60, Math.round(((y / HOUR) * 60) / 15) * 15));
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const m = minuteAt(e.clientY);
    setDraft({ start: m, end: m + 60 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draft) {
      const m = minuteAt(e.clientY);
      setDraft((d) => d && { ...d, end: Math.max(d.start + 15, m) });
    }
    if (drag) {
      const m = minuteAt(e.clientY);
      setDrag((d) => {
        if (!d) return d;
        if (d.mode === 'resize') return { ...d, end: Math.max(d.start + 15, m), moved: true };
        const length = d.end - d.start;
        const start = Math.max(0, Math.min(24 * 60 - length, m - d.offset));
        return { ...d, start, end: start + length, moved: d.moved || start !== d.start };
      });
    }
  };
  const onUp = () => {
    if (draft) {
      ctx.newAt({ startDate: day, startTime: hhmm(draft.start), endTime: hhmm(draft.end), endDate: null });
      setDraft(null);
    }
    if (drag) {
      const item = ctx.items.find((i) => i.key === drag.key);
      if (item?.event && drag.moved) {
        updateEvent(item.event.workspaceId, item.event.id, { startTime: hhmm(drag.start), endTime: hhmm(drag.end) }).catch(toastError);
      } else if (item && !drag.moved) ctx.open(item);
      setDrag(null);
    }
  };

  return (
    <div
      ref={col}
      {...drop.props}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className={clsx('relative min-w-0 flex-1 touch-none border-s border-line select-none', drop.over && 'bg-accent-soft/40')}
      style={{ backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR - 1}px, var(--line) ${HOUR - 1}px, var(--line) ${HOUR}px)` }}
    >
      {placed.map(({ item, start, end, col: c, cols }) => {
        const live = drag?.key === item.key ? drag : null;
        const top = ((live?.start ?? start) / 60) * HOUR;
        const height = Math.max(18, (((live?.end ?? end) - (live?.start ?? start)) / 60) * HOUR - 2);
        const editable = item.kind === 'event' && !item.projected;
        return (
          <div
            key={item.key}
            draggable={false}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (!editable) return;
              col.current!.setPointerCapture(e.pointerId);
              setDrag({ key: item.key, mode: 'move', offset: minuteAt(e.clientY) - start, start, end, moved: false });
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (!editable) ctx.open(item);
            }}
            className={clsx('absolute cursor-pointer overflow-hidden rounded-md border-s-[3px] px-1.5 py-0.5 text-xs shadow-sm', item.projected && 'opacity-60', item.done && 'line-through opacity-60')}
            style={{
              top,
              height,
              left: `calc(${(c / cols) * 100}% + 2px)`,
              width: `calc(${100 / cols}% - 4px)`,
              background: `color-mix(in srgb, ${item.color} 18%, var(--surface))`,
              borderLeftColor: item.color,
            }}
            title={item.title}
          >
            <div className="truncate font-medium">{item.title}</div>
            <div className="truncate text-[10px] text-muted">
              {timeLabel(hhmm(live?.start ?? start))} – {timeLabel(hhmm(live?.end ?? end))}
            </div>
            {editable && (
              <div
                onPointerDown={(e) => {
                  e.stopPropagation();
                  col.current!.setPointerCapture(e.pointerId);
                  setDrag({ key: item.key, mode: 'resize', offset: 0, start, end, moved: false });
                }}
                className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize"
              />
            )}
          </div>
        );
      })}
      {draft && (
        <div className="pointer-events-none absolute inset-x-1 rounded-md border border-accent bg-accent-soft px-1.5 text-xs" style={{ top: (draft.start / 60) * HOUR, height: ((draft.end - draft.start) / 60) * HOUR }}>
          {timeLabel(hhmm(draft.start))} – {timeLabel(hhmm(draft.end))}
        </div>
      )}
      {now && (
        <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR }}>
          <span className="absolute -top-[5px] -start-[5px] size-2 rounded-full bg-danger" />
        </div>
      )}
    </div>
  );
}

function AgendaView({ ctx, from, to, loading }: { ctx: CalendarCtx; from: string; to: string; loading: boolean }) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const list = itemsOn(ctx.items, d);
    if (list.length) days.push({ d, list });
  }
  const today = todayStr();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-3 py-4 sm:px-6">
        {!loading && days.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center text-sm text-muted">
            Nothing in the next 60 days. Use <b>New</b> to add an event or task, give a card a date, or type a date into a page.
          </div>
        )}
        {days.map(({ d, list }) => (
          <div key={d} className="mb-5">
            <div className={clsx('mb-1.5 text-sm font-medium', d === today ? 'text-accent' : 'text-muted')}>
              {d === today ? 'Today · ' : ''}
              {toDate(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {list.map((i) => (
                <div key={i.key} onClick={() => ctx.open(i)} className={clsx('flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-hover', i.projected && 'opacity-60')}>
                  {i.kind === 'event' && i.done !== null ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        ctx.toggleDone(i);
                      }}
                      className="flex size-[18px] shrink-0 items-center justify-center rounded border-2"
                      style={{ borderColor: i.color, background: i.done ? i.color : 'transparent' }}
                      aria-label={i.done ? 'Mark as not done' : 'Mark as done'}
                    >
                      {i.done && <Check size={12} className="text-white" strokeWidth={3} />}
                    </button>
                  ) : (
                    <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: i.color }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className={clsx('truncate text-sm font-medium', i.done && 'line-through opacity-60')}>{i.title}</div>
                    <div className="truncate text-xs text-muted">
                      {i.startTime ? `${timeLabel(i.startTime)}${i.endTime ? ` – ${timeLabel(i.endTime)}` : ''}` : 'All day'}
                      {i.subtitle ? ` · ${i.subtitle}` : ''}
                      {i.kind === 'block' ? ' · in a page' : ''}
                      {i.projected ? ' · upcoming repeat' : ''}
                    </div>
                  </div>
                  {i.repeats && <Repeat size={14} className="shrink-0 text-faint" />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
