import { useQuery } from '@tanstack/react-query';
import { DayPlan, PLAN_DRAG, type PlanDrop } from './DayPlan';
import { ReviewDialog, useDueCount } from '../study/Flashcards';
import { getLocal, setLocal } from '../lib/storage';
import clsx from 'clsx';
import { CalendarClock, CalendarDays, Layers, Check, ChevronLeft, ChevronRight, FileText, ListChecks, PartyPopper, Plus, Sparkles, Table2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../app/context';
import type { CalendarCard } from '../calendar/api';
import { COLOR_HEX, createEvent, type EventColor, updateEvent } from '../calendar/api';
import { CardDialog } from '../calendar/CardDialog';
import { EventDialog } from '../calendar/EventDialog';
import { ChoosePathDialog, type LastDay, type PathChoice, PathLine, undoLastDay } from '../calendar/paths';
import { IconButton, toastError } from '../components/ui';
import { api, type PageType } from '../lib/api';
import { OPTION_COLORS } from '../database/model';
import { locationPath } from '../lib/placement';
import { CardDoneQuestions } from '../database/DoneQuestions';
import { queryClient } from '../lib/queries';
import { notificationsKey, SidebarIcon } from '../notifications/Notifications';

// The day's to-do list: calendar tasks, dated cards with a status, and to-do items with a date, with
// what's overdue on top. Once things are ticked off, it shows what was finished and cheers you on.

interface Task {
  key: string;
  kind: 'event' | 'card' | 'block';
  title: string;
  date: string;
  endDate: string | null;
  time: string | null;
  done: boolean;
  overdue: boolean;
  status: string | null;
  color: string | null;
  eventId?: string;
  pageId?: string;
  rowId?: string | null;
  blockId?: string;
  pageTitle?: string;
  pageIcon?: string;
  pageType?: PageType;
  rowTitle?: string | null;
  fieldId?: string;
  fieldName?: string;
  paths?: boolean;
  choice?: Pick<PathChoice, 'labels' | 'step'> | null;
  /** Keeps missed days and is done up to today: it's on a day ahead. */
  ahead?: boolean;
  canUndo?: boolean;
  last?: LastDay | null;
}

interface Finished {
  key: string;
  title: string;
  userId: string | null;
  userName: string | null;
  completedAt: string;
}

interface TaskDay {
  date: string;
  tasks: Task[];
  finished: Finished[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => isoOf(new Date());
function shift(day: string, n: number) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
const longDate = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
const shortDate = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

const tasksKey = (ws: string, day: string) => ['tasks', ws, day] as const;

// ---------- encouragement ----------

const ALL_DONE = [
  'Everything for today is done. Enjoy the rest of your day — you earned it.',
  'Clean sweep! Every task ticked off. That’s what steady progress looks like.',
  'All done. Future you is very grateful right now.',
  'Nothing left on the list. Take a moment to notice how much you got through.',
  'You finished everything you set out to do. Rest well — tomorrow starts from a good place.',
];
const SOME_DONE = [
  'Nice momentum — every finished task makes the next one easier.',
  'Good progress. Keep the streak going, one task at a time.',
  'You’re moving. Small steps add up faster than they seem.',
  'That’s real progress. Pick the next one and keep rolling.',
  'Well done so far — the hardest part is starting, and you already have.',
];
const MANY_DONE = [
  'You’re on a roll today. Remember to take a short break too.',
  'Impressive day so far — that’s a lot of finished work.',
  'Look at that list! Keep the energy, but don’t forget to rest.',
];

/** A sentence that stays the same through the day but changes as you finish more. */
function encouragement(finished: number, open: number, day: string) {
  const list = open === 0 ? ALL_DONE : finished >= 5 ? MANY_DONE : SOME_DONE;
  let h = finished * 31;
  for (const ch of day) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

// ---------- page ----------

export function TodayPage() {
  const { workspace, sidebarOpen, toggleSidebar } = useApp();
  const navigate = useNavigate();
  const [day, setDay] = useState(() => {
    const d = new URLSearchParams(window.location.search).get('date');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayIso();
  });
  const isToday = day === todayIso();
  const { data, isPending } = useQuery({
    queryKey: tasksKey(workspace.id, day),
    queryFn: () => api<TaskDay>(`/api/workspaces/${workspace.id}/tasks?date=${day}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const [eventDialog, setEventDialog] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<Task | null>(null);
  const [asking, setAsking] = useState<{ task: Task; pageId: string; rowId: string } | null>(null);
  const [cardDialog, setCardDialog] = useState<CalendarCard | null>(null);
  const [adding, setAdding] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // "Plan my day": the hours of the day beside the list, to drag tasks into (remembered on this device).
  const dueCards = useDueCount(workspace.id);
  const [reviewing, setReviewing] = useState(false);
  const [planning, setPlanning] = useState(() => getLocal<boolean>('atrium-today-plan', false));
  const togglePlan = () =>
    setPlanning((p) => {
      setLocal('atrium-today-plan', !p);
      return !p;
    });

  const tasks = useMemo(() => (data?.tasks ?? []).map((t) => (t.key in pending ? { ...t, done: pending[t.key] } : t)), [data, pending]);
  const overdue = tasks.filter((t) => t.overdue && !t.done);
  const dueToday = tasks.filter((t) => !t.overdue && !t.done);
  const doneToday = tasks.filter((t) => t.done && !t.overdue);
  const finishedKeys = new Set((data?.finished ?? []).map((f) => f.key));
  // Finished today: what was ticked off today, plus today's tasks that were already done.
  const finished = [
    ...(data?.finished ?? []).map((f) => ({
      key: f.key,
      title: f.title,
      by: f.userName,
      at: f.completedAt,
    })),
    ...doneToday
      .filter((t) => !finishedKeys.has(t.key))
      .map((t) => ({
        key: t.key,
        title: t.title,
        by: null as string | null,
        at: null as string | null,
      })),
  ];
  // A task that's caught up and on a day ahead can go on, but isn't left to do today.
  const open = overdue.length + dueToday.filter((t) => !t.ahead).length;
  const total = open + finished.length;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tasks', workspace.id] });
    queryClient.invalidateQueries({ queryKey: notificationsKey });
    queryClient.invalidateQueries({ queryKey: ['calendar', workspace.id] });
  };

  const toggle = async (t: Task, answered = false) => {
    // A task with paths asks which one first.
    if (t.paths && !t.choice && !t.done) return setChoosing(t);
    // Finishing a card (the card itself, or today's step of a paths task) asks its database's questions first.
    if (!t.done && !answered) {
      const card = t.kind === 'card' && t.pageId && t.rowId ? { pageId: t.pageId, rowId: t.rowId } : t.choice?.step?.kind === 'card' ? t.choice.step : null;
      if (card) return setAsking({ task: t, pageId: card.pageId, rowId: card.rowId });
    }
    const done = !t.done;
    setPending((p) => ({ ...p, [t.key]: done }));
    try {
      if (t.kind === 'event')
        await updateEvent(workspace.id, t.eventId!, {
          status: done ? 'done' : 'todo',
        });
      else
        await api(`/api/workspaces/${workspace.id}/tasks/done`, {
          method: 'POST',
          body: { key: t.key, done },
        });
      await queryClient.invalidateQueries({
        queryKey: ['tasks', workspace.id],
      });
    } catch (err) {
      toastError(err);
    } finally {
      setPending(({ [t.key]: _, ...rest }) => rest);
      refresh();
    }
  };

  const openTask = (t: Task) => {
    // An event placed in a page or card opens there, at its block; one that's only on the calendar opens its details.
    if (t.kind === 'event' && t.pageId) navigate(locationPath(workspace.id, { pageId: t.pageId, rowId: t.rowId ?? null }, t.blockId));
    else if (t.kind === 'event') setEventDialog(t.eventId!);
    else if (t.kind === 'card')
      setCardDialog({
        pageId: t.pageId!,
        rowId: t.rowId!,
        fieldId: t.fieldId ?? '',
        fieldName: t.fieldName ?? '',
        date: t.date,
        endDate: t.endDate,
        title: t.title,
        status: t.status,
        statusColor: t.color,
        pageTitle: t.pageTitle ?? '',
        pageIcon: t.pageIcon ?? '',
        pageType: t.pageType ?? 'grid',
        repeat: null,
      });
    else navigate(locationPath(workspace.id, { pageId: t.pageId!, rowId: t.rowId ?? null }, t.blockId));
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const title = adding.trim();
    if (!title) return;
    setAdding('');
    try {
      await createEvent(workspace.id, {
        title,
        startDate: day,
        status: 'todo',
        color: 'blue',
      });
      refresh();
    } catch (err) {
      setAdding(title);
      toastError(err);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        {!sidebarOpen && (
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        )}
        <h1 className="me-1 flex items-center gap-2 text-lg font-semibold">
          <ListChecks size={19} className="text-muted" /> {isToday ? 'Today' : shortDate(day)}
        </h1>
        <div className="flex-1" />
        <button
          onClick={togglePlan}
          className={clsx(
            'flex h-8 items-center gap-1.5 rounded-lg border px-3 text-sm',
            planning ? 'border-accent bg-accent/10 text-accent' : 'border-line hover:bg-hover',
          )}
          title="Show the day's hours to drag tasks into"
        >
          <CalendarClock size={15} /> <span className="hidden sm:inline">Plan my day</span>
        </button>
        {!isToday && (
          <button onClick={() => setDay(todayIso())} className="h-8 rounded-lg border border-line px-3 text-sm hover:bg-hover">
            Today
          </button>
        )}
        <IconButton onClick={() => setDay((d) => shift(d, -1))} title="Previous day">
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton onClick={() => setDay((d) => shift(d, 1))} title="Next day">
          <ChevronRight size={18} />
        </IconButton>
      </header>

      <div className={clsx('min-h-0 flex-1', planning ? 'flex flex-col overflow-y-auto lg:flex-row lg:overflow-hidden' : 'overflow-y-auto')}>
        <div className={clsx(planning && 'lg:min-h-0 lg:flex-1 lg:overflow-y-auto')}>
          <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-8">
            <div className="text-sm text-muted">{longDate(day)}</div>
            <div className="mt-1 flex items-end gap-3">
              <div className="text-2xl font-bold tracking-tight">
                {isPending ? 'Loading…' : total === 0 ? 'Nothing planned' : open === 0 ? 'All done' : `${open} to do`}
              </div>
              {total > 0 && (
                <div className="pb-1 text-sm text-muted">
                  {finished.length} of {total} finished
                </div>
              )}
            </div>
            {total > 0 && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-hover">
                <div className="h-full rounded-full bg-green-500 transition-[width] duration-500" style={{ width: `${(finished.length / total) * 100}%` }} />
              </div>
            )}

            {finished.length > 0 && (
              <div className={clsx('mt-5 flex items-start gap-3 rounded-xl px-4 py-3', open === 0 ? 'bg-green-500/10' : 'bg-accent/5')}>
                {open === 0 ? (
                  <PartyPopper size={20} className="mt-0.5 shrink-0 text-green-600" />
                ) : (
                  <Sparkles size={18} className="mt-0.5 shrink-0 text-accent" />
                )}
                <p className="text-sm">{encouragement(finished.length, open, day)}</p>
              </div>
            )}

            {dueCards > 0 && isToday && (
              <button
                onClick={() => setReviewing(true)}
                className="mt-5 flex w-full items-center gap-3 rounded-xl border border-line px-4 py-3 text-start text-sm hover:bg-hover"
              >
                <Layers size={18} className="shrink-0 text-accent" />
                <span className="flex-1">
                  <span className="font-medium">
                    Review {dueCards} flashcard{dueCards === 1 ? '' : 's'}
                  </span>
                  <span className="block text-xs text-muted">Cards from your pages that are due today</span>
                </span>
              </button>
            )}

            <form onSubmit={add} className="mt-6 flex items-center gap-2 rounded-lg border border-line px-3 focus-within:border-accent">
              <Plus size={16} className="text-faint" />
              <input
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                placeholder={isToday ? 'Add a task for today' : `Add a task for ${shortDate(day)}`}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </form>

            {overdue.length > 0 && (
              <TaskSection title="Overdue" tone="danger">
                {overdue.map((t) => (
                  <TaskRow
                    key={t.key}
                    task={t}
                    onToggle={() => toggle(t)}
                    onOpen={() => openTask(t)}
                    onChoose={() => setChoosing(t)}
                    today={day}
                    workspaceId={workspace.id}
                  />
                ))}
              </TaskSection>
            )}

            {dueToday.length > 0 && (
              <TaskSection title={isToday ? 'Due today' : 'Due'}>
                {dueToday.map((t) => (
                  <TaskRow
                    key={t.key}
                    task={t}
                    onToggle={() => toggle(t)}
                    onOpen={() => openTask(t)}
                    onChoose={() => setChoosing(t)}
                    today={day}
                    workspaceId={workspace.id}
                  />
                ))}
              </TaskSection>
            )}

            <AssignedToMe hide={new Set(tasks.map((t) => t.key))} onChanged={refresh} />

            {!isPending && total === 0 && (
              <div className="mt-10 rounded-xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
                <p className="font-medium text-fg">Nothing due {isToday ? 'today' : 'on this day'}.</p>
                <p className="mx-auto mt-2 max-w-md">
                  Tasks come from calendar events marked as tasks, dated cards that have a status, and to-do items with a date in them (type @ in a to-do to add
                  one). Or add one above.
                </p>
              </div>
            )}

            {finished.length > 0 && (
              <TaskSection title={isToday ? 'Finished today' : 'Finished'} tone="done">
                {finished.map((f) => {
                  const task = tasks.find((t) => t.key === f.key);
                  return (
                    <div key={f.key} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
                      <button
                        onClick={() => task && (task.paths && !task.done && task.canUndo ? undoLastDay(task.eventId!, refresh) : toggle(task))}
                        disabled={!task}
                        title={task ? 'Mark as not done' : undefined}
                        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-green-500 text-white"
                      >
                        <Check size={13} strokeWidth={3} />
                      </button>
                      <button onClick={() => task && openTask(task)} className="min-w-0 flex-1 text-start">
                        <span className="block truncate text-sm text-muted line-through decoration-faint">{f.title || 'Untitled'}</span>
                      </button>
                      <span className="shrink-0 text-xs text-faint">
                        {f.by ? `${f.by} · ` : ''}
                        {f.at
                          ? new Date(f.at).toLocaleTimeString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit',
                            })
                          : ''}
                      </span>
                    </div>
                  );
                })}
              </TaskSection>
            )}
          </div>
        </div>
        {planning && (
          <aside className="h-[640px] shrink-0 px-4 pb-6 lg:h-auto lg:w-[340px] lg:border-s lg:border-line lg:py-6">
            <DayPlan workspaceId={workspace.id} day={day} onOpen={(id) => setEventDialog(id)} onChanged={refresh} />
          </aside>
        )}
      </div>

      {asking && (
        <CardDoneQuestions
          key={asking.task.key}
          pageId={asking.pageId}
          rowId={asking.rowId}
          onCancel={() => setAsking(null)}
          onFinish={() => {
            setAsking(null);
            toggle(asking.task, true);
          }}
        />
      )}
      {choosing && <ChoosePathDialog eventId={choosing.eventId!} title={choosing.title} onClose={() => setChoosing(null)} onChosen={refresh} />}
      {reviewing && <ReviewDialog workspaceId={workspace.id} onClose={() => setReviewing(false)} />}
      {eventDialog && (
        <EventDialog
          eventId={eventDialog}
          onClose={() => {
            setEventDialog(null);
            refresh();
          }}
        />
      )}
      {cardDialog && (
        <CardDialog
          card={cardDialog}
          onClose={() => {
            setCardDialog(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

interface AssignedTask {
  key: string;
  pageId: string;
  rowId: string;
  title: string;
  status: string | null;
  statusColor: string | null;
  done: boolean | null;
  due: string | null;
  database: string;
  icon: string;
}

/** Cards that name this person in a person property (open ones), other than those already listed above. */
function AssignedToMe({ hide, onChanged }: { hide: Set<string>; onChanged: () => void }) {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const key = ['my-tasks', workspace.id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<{ tasks: AssignedTask[] }>(`/api/workspaces/${workspace.id}/my-tasks`),
    refetchInterval: 60_000,
  });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const open = (data?.tasks ?? []).filter((t) => !t.done && !hide.has(t.key));
  if (!open.length) return null;

  const tick = async (t: AssignedTask) => {
    setTicked((s) => new Set(s).add(t.key));
    try {
      await api(`/api/workspaces/${workspace.id}/tasks/done`, {
        method: 'POST',
        body: { key: t.key, done: true },
      });
      await queryClient.invalidateQueries({ queryKey: key });
      onChanged();
    } catch (err) {
      toastError(err);
      setTicked((s) => {
        const next = new Set(s);
        next.delete(t.key);
        return next;
      });
    }
  };

  return (
    <TaskSection title="Assigned to me">
      {open.map((t) => (
        <div key={t.key} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
          <button
            onClick={() => tick(t)}
            title="Mark as done"
            className={clsx(
              'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
              ticked.has(t.key) ? 'border-green-500 bg-green-500 text-white' : 'border-faint hover:border-green-500',
            )}
          >
            {ticked.has(t.key) && <Check size={13} strokeWidth={3} />}
          </button>
          <button onClick={() => navigate(`/w/${workspace.id}/p/${t.pageId}?row=${t.pageId}:${t.rowId}`)} className="min-w-0 flex-1 text-start">
            <span className="block truncate text-sm">{t.title || 'Untitled'}</span>
            <span className="block truncate text-xs text-muted">
              {t.icon ? `${t.icon} ` : ''}
              {t.database || 'Untitled'}
              {t.due ? ` · due ${shortDate(t.due)}` : ''}
            </span>
          </button>
          {t.status && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-xs"
              style={{
                background: OPTION_COLORS[t.statusColor ?? 'gray'] ?? OPTION_COLORS.gray,
              }}
            >
              {t.status}
            </span>
          )}
        </div>
      ))}
    </TaskSection>
  );
}

function TaskSection({ title, tone, children }: { title: string; tone?: 'danger' | 'done'; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2
        className={clsx(
          'mb-1 px-2 text-xs font-semibold tracking-wide uppercase',
          tone === 'danger' ? 'text-red-500' : tone === 'done' ? 'text-green-600' : 'text-faint',
        )}
      >
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function TaskRow({
  task: t,
  onToggle,
  onOpen,
  onChoose,
  today,
  workspaceId,
}: {
  task: Task;
  onToggle: () => void;
  onOpen: () => void;
  onChoose: () => void;
  today: string;
  workspaceId: string;
}) {
  const color = t.kind === 'event' ? COLOR_HEX[(t.color as EventColor) ?? 'blue'] : null;
  const where =
    t.kind === 'event' && !t.pageId
      ? 'Calendar'
      : t.kind === 'card'
        ? `${t.pageIcon ? `${t.pageIcon} ` : ''}${t.pageTitle || 'Untitled'}`
        : `${t.pageIcon ? `${t.pageIcon} ` : ''}${t.rowTitle ?? t.pageTitle ?? 'Untitled'}`;
  return (
    <div
      draggable
      onDragStart={(e) => {
        const drop: PlanDrop = {
          kind: t.kind,
          eventId: t.eventId,
          title: t.title,
        };
        e.dataTransfer.setData(PLAN_DRAG, JSON.stringify(drop));
        e.dataTransfer.effectAllowed = 'move';
      }}
      title={t.kind === 'event' ? undefined : 'Drag onto “Plan my day” to block time for it'}
      className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover"
    >
      <button
        onClick={onToggle}
        title="Mark as done"
        className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-faint text-transparent transition-colors hover:border-green-500 hover:text-green-500"
      >
        <Check size={12} strokeWidth={3} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0">
          <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-start">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{t.title}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                {t.kind === 'event' ? <CalendarDays size={12} /> : t.kind === 'card' ? <Table2 size={12} /> : <FileText size={12} />}
                <span className="truncate">{where}</span>
                {t.overdue && <span className="shrink-0 text-red-500">· due {shortDate(t.endDate && t.endDate < today ? t.endDate : t.date)}</span>}
                {t.status && t.kind === 'card' && <span className="shrink-0">· {t.status}</span>}
              </span>
            </span>
            {t.time && <span className="shrink-0 text-xs text-muted">{t.time}</span>}
            {color && <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />}
          </button>
        </div>
        {t.paths && <PathLine workspaceId={workspaceId} eventId={t.eventId!} choice={t.choice ?? null} done={t.done} ahead={t.ahead} date={t.date} canUndo={t.canUndo} last={t.last} onChoose={onChoose} />}
      </div>
    </div>
  );
}
