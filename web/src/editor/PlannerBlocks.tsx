import clsx from 'clsx';
import { BellRing, CalendarCheck2, CalendarDays, Check, ExternalLink, PenTool, Repeat } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type CalendarEvent, COLOR_HEX, STATUS_LABELS, updateEvent, useEvent } from '../calendar/api';
import { EventDialog } from '../calendar/EventDialog';
import { ChoosePathDialog, choiceOf, keepsMissedDays, PathLine } from '../calendar/paths';
import { today as todayDate } from '../calendar/repeat';
import { describeRepeat } from '../calendar/RepeatEditor';
import { Popover, toastError } from '../components/ui';
import { useDirectory } from '../lib/directory';
import { BoardThumbnail } from '../whiteboards/BoardThumbnail';
import { useWhiteboard } from '../whiteboards/api';

// Blocks that tie pages to the Calendar and Whiteboards screens.

/** Event ids just made from the "/" menu, whose details dialog opens straight away. */
export const openOnMount = new Set<string>();

function when(e: Pick<CalendarEvent, 'startDate' | 'startTime' | 'endDate' | 'endTime'>) {
  const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };
  let s = day(e.startDate);
  if (e.startTime) s += `, ${time(e.startTime)}`;
  if (e.endDate && e.endDate !== e.startDate) s += ` – ${day(e.endDate)}${e.endTime ? `, ${time(e.endTime)}` : ''}`;
  else if (e.endTime) s += ` – ${time(e.endTime)}`;
  return s;
}

/** An event or task in a page: its date, status and repeat, opening its details on click. */
export function EventBlockView({ eventId, editable }: { eventId: string; editable: boolean }) {
  const event = useEvent(eventId || null);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const dir = useDirectory();

  useEffect(() => {
    if (openOnMount.delete(eventId)) setOpen(true);
  }, [eventId]);

  const e = event.data;
  if (event.isError) return <div className="w-full rounded-lg border border-dashed border-line px-3 py-2 text-sm text-faint italic">This event was deleted.</div>;
  const color = e ? COLOR_HEX[e.color] : '#8a8f98';
  const isTask = e?.status != null;
  const done = e?.status === 'done';

  return (
    <div contentEditable={false} className="w-full select-none">
      <div
        onClick={() => e && setOpen(true)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 hover:bg-hover"
        style={{ borderLeft: `4px solid ${color}` }}
      >
        {isTask ? (
          <button
            onClick={(ev) => {
              ev.stopPropagation();
              if (e?.paths && !done && !choiceOf(e)) return setChoosing(true);
              if (e && dir && editable) updateEvent(dir.workspaceId, e.id, { status: done ? 'todo' : 'done' }).catch(toastError);
            }}
            className="flex size-[18px] shrink-0 items-center justify-center rounded border-2"
            style={{ borderColor: color, background: done ? color : 'transparent' }}
            aria-label={done ? 'Mark as not done' : 'Mark as done'}
          >
            {done && <Check size={12} className="text-white" strokeWidth={3} />}
          </button>
        ) : (
          <CalendarDays size={18} className="shrink-0" style={{ color }} />
        )}
        <div className="min-w-0 flex-1">
          <div className={clsx('truncate text-sm font-medium', done && 'line-through opacity-60')}>{e ? e.title || 'Untitled' : 'Loading…'}</div>
          {e && (
            <div className="truncate text-xs text-muted">
              {when(e)}
              {isTask && ` · ${STATUS_LABELS[e.status!]}`}
            </div>
          )}
          {e?.paths && isTask && dir && <PathLine
              workspaceId={dir.workspaceId}
              eventId={e.id}
              choice={choiceOf(e)}
              done={done}
              ahead={keepsMissedDays(e) && e.startDate > todayDate()}
              date={e.startDate}
              canUndo={!!e.pathState?.history?.length}
              onChoose={() => setChoosing(true)}
            />}
        </div>
        {e?.repeat && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-faint" title={describeRepeat(e.repeat)}>
            <Repeat size={13} />
          </span>
        )}
        {isTask ? <CalendarCheck2 size={15} className="shrink-0 text-faint" /> : null}
      </div>
      {open && e && <EventDialog eventId={e.id} onClose={() => setOpen(false)} />}
      {choosing && e && <ChoosePathDialog eventId={e.id} title={e.title} onClose={() => setChoosing(false)} />}
    </div>
  );
}

/** A whiteboard in a page: a live preview that opens the board. */
export function WhiteboardBlockView({ boardId }: { boardId: string }) {
  const board = useWhiteboard(boardId || null);
  const dir = useDirectory();
  const open = () => dir && dir.navigate(`/w/${dir.workspaceId}/whiteboards/${boardId}`);
  if (board.isError) return <div className="w-full rounded-lg border border-dashed border-line px-3 py-2 text-sm text-faint italic">This whiteboard was deleted.</div>;
  return (
    <div contentEditable={false} className="w-full select-none">
      <div onClick={open} className="group w-full cursor-pointer overflow-hidden rounded-xl border border-line bg-surface hover:shadow-pop">
        <BoardThumbnail boardId={boardId} empty={board.data?.elementCount === 0} className="h-56 w-full bg-sidebar/40" />
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <PenTool size={15} className="text-muted" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{board.data?.title || 'Untitled whiteboard'}</span>
          <span className="flex items-center gap-1 text-xs text-muted opacity-0 group-hover:opacity-100">
            Open <ExternalLink size={12} />
          </span>
        </div>
      </div>
    </div>
  );
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const REMINDERS: { value: string; label: string }[] = [
  { value: '', label: 'No reminder' },
  { value: '0', label: 'At the time' },
  { value: '15', label: '15 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
  { value: '2880', label: '2 days before' },
  { value: '10080', label: '1 week before' },
];

/**
 * A date typed into text. Any block with one shows on the calendar. Click to change it, add a time,
 * or set a reminder (sent to whoever sets it).
 */
export function DateMentionChip({
  date,
  time = '',
  remind = '',
  editable,
  onChange,
}: {
  date: string;
  time?: string;
  remind?: string;
  editable: boolean;
  onChange: (patch: { date?: string; time?: string; remind?: string }) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const days = Math.round((new Date(`${date}T00:00:00`).getTime() - new Date(`${todayStr}T00:00:00`).getTime()) / 86_400_000);
  const label =
    Math.abs(days) <= 1
      ? relative.format(days, 'day').replace(/^./, (c) => c.toUpperCase())
      : new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 || days < -300 ? 'numeric' : undefined });
  const timeLabel = time ? new Date(`2000-01-01T${time}:00`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <span
      ref={ref}
      contentEditable={false}
      onClick={() => editable && setAnchor(ref.current!.getBoundingClientRect())}
      className={clsx(
        'inline-flex cursor-pointer items-center gap-1 rounded px-1 align-baseline text-[0.95em]',
        days < 0 ? 'text-danger' : days === 0 ? 'text-accent' : 'text-fg',
        'bg-hover hover:bg-active',
      )}
      title={`${new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'full' })}${timeLabel ? ` ${timeLabel}` : ''}${remind ? ' · reminder set' : ''}`}
    >
      <CalendarDays size={12} className="opacity-70" />
      {label}
      {timeLabel && <span className="opacity-80">{timeLabel}</span>}
      {remind && <BellRing size={11} className="opacity-70" />}
      <Popover anchor={anchor} onClose={() => setAnchor(null)}>
        <div className="space-y-2 p-2" onMouseDown={(e) => e.stopPropagation()}>
          <input
            type="date"
            autoFocus
            defaultValue={date}
            onChange={(e) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange({ date: e.target.value });
            }}
            className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm"
          />
          <div className="flex items-center gap-2">
            <input type="time" defaultValue={time} onChange={(e) => onChange({ time: e.target.value })} className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-sm" />
            {time && (
              <button onClick={() => onChange({ time: '' })} className="text-xs text-muted hover:text-fg">
                All day
              </button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <BellRing size={14} className="shrink-0 text-muted" />
            <select value={remind} onChange={(e) => onChange({ remind: e.target.value })} className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-sm">
              {REMINDERS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {remind && !time && <p className="text-xs text-faint">All-day dates remind you counting from 9:00.</p>}
        </div>
      </Popover>
    </span>
  );
}
