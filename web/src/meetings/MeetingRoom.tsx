import clsx from 'clsx';
import {
  ArrowLeft,
  CalendarCheck,
  CalendarPlus,
  Check,
  CheckSquare,
  Copy,
  Crown,
  Flag,
  Link2,
  Lock,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  Pencil,
  PhoneOff,
  Pin,
  PinOff,
  Plus,
  ScreenShareOff,
  Trash2,
  UserPlus,
  Users,
  Video,
  VideoOff,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useApp } from '../app/context';
import { Avatar, Button, confirmDialog, IconButton, Input, Spinner, toast, toastError } from '../components/ui';
import { api } from '../lib/api';
import { usePhone } from '../lib/device';
import { queryClient, useMembers } from '../lib/queries';
import { type MeetingDetail, type MeetingPerms, type MeetingTask, meetingState, useMeeting } from '../chat/chatApi';
import { ChatView } from '../chat/ChatView';
import { PeoplePicker } from '../chat/PeoplePicker';
import { type Focus, MediaView, useCall, visible } from './CallContext';
import { DevicePicker } from './DevicePicker';

// A meeting: before it — details, the link, who's invited, tasks to prepare; during — the call (see
// CallContext: it keeps going on other pages) with microphone, camera and screen sharing as the host
// allows, a focus view, who's talking, its chat, tasks and people; after — its chat (kept, read-only)
// and the tasks.

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '');
const fmtShort = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const refresh = () => queryClient.invalidateQueries({ queryKey: ['meeting'] });
/** A time as the calendar keeps it: the local date and "HH:MM". */
const localParts = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
};
const toInput = (iso: string) => {
  const { date, time } = localParts(iso);
  return `${date}T${time}`;
};

export function MeetingRoom() {
  const { code } = useParams();
  const { workspace } = useApp();
  const navigate = useNavigate();
  const m = useMeeting(code);
  const { active } = useCall();

  if (m.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted">
        <Lock size={26} className="text-faint" />
        {(m.error as Error).message}
        <Button onClick={() => navigate(`/w/${workspace.id}/meetings`)}>All meetings</Button>
      </div>
    );
  }
  if (!m.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (active && active.detail.meeting.code === code && !m.data.meeting.endedAt) return <RoomView />;
  return <Lobby detail={m.data} />;
}

// ---------- before and after ----------

function Lobby({ detail }: { detail: MeetingDetail }) {
  const { workspace, user } = useApp();
  const navigate = useNavigate();
  const phone = usePhone();
  const { join, active } = useCall();
  const { meeting } = detail;
  const state = meetingState(meeting);
  const link = `${location.origin}/w/${workspace.id}/meet/${meeting.code}`;
  const [tab, setTab] = useState<'tasks' | 'people' | 'chat'>(state === 'ended' ? 'chat' : 'tasks');
  const canMedia = typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices;
  const busyElsewhere = active && active.detail.meeting.code !== meeting.code;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        <IconButton onClick={() => navigate(`/w/${workspace.id}/meetings`)} title="All meetings">
          <ArrowLeft size={17} className="rtl:rotate-180" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold" data-no-translate>
            {meeting.title}
          </h1>
          <div className="text-xs text-muted">
            {state === 'ended' ? `Ended · ${fmt(meeting.endedAt)}` : state === 'live' ? 'Happening now' : fmt(meeting.startsAt)} · host {meeting.hostName ?? '—'}
          </div>
        </div>
        {state !== 'ended' && (
          <Button variant="primary" onClick={() => join(detail, user.id)} title={busyElsewhere ? 'Leaves your other call' : undefined}>
            <Video size={15} /> {state === 'live' ? 'Join' : 'Start'}
          </Button>
        )}
      </header>
      <div className={clsx('flex min-h-0 flex-1', phone ? 'flex-col overflow-y-auto' : '')}>
        <div className={clsx('space-y-4 p-4 sm:p-6', phone ? '' : 'w-80 shrink-0 overflow-y-auto border-e border-line')}>
          {meeting.description && (
            <p className="text-sm whitespace-pre-wrap" data-no-translate>
              {meeting.description}
            </p>
          )}
          {state !== 'ended' && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted">Link</div>
              <div className="flex gap-1.5">
                <input readOnly value={link} onFocus={(e) => e.target.select()} className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-xs" dir="ltr" />
                <Button onClick={() => void navigator.clipboard.writeText(link).then(() => toast('Link copied'))} title="Copy link">
                  <Copy size={14} />
                </Button>
              </div>
            </div>
          )}
          {!canMedia && state !== 'ended' && (
            <p className="rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
              This browser can only use the microphone and camera over HTTPS (or in the desktop and phone apps). You can still join, chat and see others.
            </p>
          )}
          {state !== 'ended' && (
            <div className="text-xs text-muted">
              Everyone may:{' '}
              {(['talk', 'camera', 'screen', 'chat'] as const)
                .filter((k) => meeting.defaults[k])
                .map((k) => ({ talk: 'talk', camera: 'camera', screen: 'share screen', chat: 'chat' })[k])
                .join(', ') || 'only listen'}
              {detail.canManage && ' — you can change this per person.'}
            </div>
          )}
        </div>
        <div className="flex min-h-[420px] min-w-0 flex-1 flex-col">
          <div className="flex gap-1 border-b border-line px-3 pt-2">
            {(['tasks', 'people', 'chat'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={clsx('rounded-t-md px-3 py-1.5 text-sm', tab === t ? 'border-b-2 border-accent font-medium' : 'text-muted hover:text-fg')}>
                {t === 'tasks' ? `Tasks (${detail.tasks.length})` : t === 'people' ? `People (${detail.members.length})` : 'Chat'}
              </button>
            ))}
          </div>
          {tab === 'tasks' && <TasksPanel detail={detail} />}
          {tab === 'people' && <PeoplePanel detail={detail} />}
          {tab === 'chat' && <ChatView chatId={meeting.chatId} tasks={detail.tasks} bubbles />}
        </div>
      </div>
    </div>
  );
}

// ---------- tasks ----------

const PRIORITY: Record<MeetingTask['priority'], { label: string; cls: string }> = {
  high: { label: 'High', cls: 'text-red-500' },
  normal: { label: 'Normal', cls: 'text-faint' },
  low: { label: 'Low', cls: 'text-sky-500' },
};

/** Everyone who can be given a task: the host and the people in the meeting. */
function useMeetingPeople(detail: MeetingDetail) {
  const { workspace } = useApp();
  const members = useMembers(workspace.id);
  return useMemo(() => {
    const ids = new Set([...(detail.meeting.hostId ? [detail.meeting.hostId] : []), ...detail.members.filter((m) => m.status !== 'declined').map((m) => m.userId)]);
    return (members.data?.members ?? []).filter((m) => ids.has(m.id));
  }, [detail, members.data]);
}

function TaskEditor({ detail, task, onDone }: { detail: MeetingDetail; task?: MeetingTask; onDone: () => void }) {
  const people = useMeetingPeople(detail);
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [due, setDue] = useState(task?.dueAt ? toInput(task.dueAt) : '');
  const [priority, setPriority] = useState<MeetingTask['priority']>(task?.priority ?? 'normal');
  const [everyone, setEveryone] = useState(task ? task.forEveryone : true);
  const [who, setWho] = useState<string[]>(task && !task.forEveryone ? task.people.map((p) => p.userId) : []);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || (!everyone && !who.length)) return;
    setBusy(true);
    const body = { title: title.trim(), notes, dueAt: due ? new Date(due).toISOString() : null, priority, forEveryone: everyone, assigneeIds: everyone ? [] : who };
    try {
      if (task) await api(`/api/meeting-tasks/${task.id}`, { method: 'PATCH', body });
      else await api(`/api/meetings/${detail.meeting.code}/tasks`, { method: 'POST', body });
      await refresh();
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="space-y-2.5 rounded-xl border border-accent/40 bg-accent/5 p-3">
      <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Notes (optional)" className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Due
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg" />
        </label>
        <select value={priority} onChange={(e) => setPriority(e.target.value as MeetingTask['priority'])} className="h-8 rounded-md border border-line bg-surface px-2" title="Priority">
          <option value="high">High priority</option>
          <option value="normal">Normal priority</option>
          <option value="low">Low priority</option>
        </select>
      </div>
      <div>
        <div className="mb-1 flex items-center gap-3 text-xs">
          <span className="font-medium text-muted">For</span>
          <label className="flex items-center gap-1">
            <input type="radio" checked={everyone} onChange={() => setEveryone(true)} /> Everyone
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={!everyone} onChange={() => setEveryone(false)} /> Chosen people
          </label>
        </div>
        {!everyone && (
          <div className="flex flex-wrap gap-1.5">
            {people.map((p) => {
              const on = who.includes(p.id);
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => setWho(on ? who.filter((x) => x !== p.id) : [...who, p.id])}
                  className={clsx('flex items-center gap-1.5 rounded-full border py-0.5 ps-0.5 pe-2.5 text-xs', on ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:bg-hover')}
                >
                  <Avatar name={p.name} color={p.color} size={20} />
                  <span data-no-translate>{p.name}</span>
                  {on && <Check size={12} />}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-1 text-[11px] text-faint">Only the people it's for (and you) will see it, and only they can tick it.</p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!title.trim() || (!everyone && !who.length)}>
          {task ? 'Save' : 'Add task'}
        </Button>
      </div>
    </form>
  );
}

function CalendarForm({ detail, task, onDone }: { detail: MeetingDetail; task: MeetingTask; onDone: () => void }) {
  const start = detail.meeting.startsAt ?? detail.meeting.startedAt ?? new Date().toISOString();
  const fallbackEnd = new Date(new Date(start).getTime() + 7 * 86400_000).toISOString();
  const [end, setEnd] = useState(toInput(task.dueAt ?? fallbackEnd));
  const add = async () => {
    const s = localParts(start);
    const e = localParts(new Date(end).toISOString());
    try {
      await api(`/api/meeting-tasks/${task.id}/calendar`, { method: 'POST', body: { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time } });
      await refresh();
      toast('Added to the calendar');
      onDone();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-hover/60 p-2 text-xs">
      <CalendarPlus size={14} className="text-accent" />
      <span className="text-muted">From the meeting ({fmtShort(start)}) until</span>
      <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs" />
      <Button size="sm" variant="primary" onClick={() => void add()} disabled={!end}>
        Add
      </Button>
      <button onClick={onDone} className="text-muted hover:text-fg">
        Cancel
      </button>
    </div>
  );
}

function TaskCard({ detail, task }: { detail: MeetingDetail; task: MeetingTask }) {
  const { workspace, user } = useApp();
  const members = useMembers(workspace.id);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const [open, setOpen] = useState(false);
  const person = (id: string) => members.data?.members.find((m) => m.id === id);
  if (editing) return <TaskEditor detail={detail} task={task} onDone={() => setEditing(false)} />;
  const overdue = task.dueAt && !task.done && new Date(task.dueAt).getTime() < Date.now();
  const tick = () => api(`/api/meeting-tasks/${task.id}/done`, { method: 'POST', body: { done: !task.myDone } }).then(refresh, toastError);
  const remove = async () => {
    if (!(await confirmDialog({ title: `Remove “${task.title}”?`, confirmLabel: 'Remove', danger: true }))) return;
    await api(`/api/meeting-tasks/${task.id}`, { method: 'DELETE' }).then(refresh, toastError);
  };
  return (
    <div className={clsx('group rounded-xl border p-3 transition-colors', task.done ? 'border-line bg-hover/40' : 'border-line bg-surface hover:border-accent/40')}>
      <div className="flex items-start gap-2.5">
        <button
          onClick={() => void tick()}
          disabled={!task.mine}
          title={task.mine ? (task.myDone ? 'Untick your part' : 'Tick your part') : 'Only the people it is for can tick it'}
          className={clsx(
            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            task.mine && task.myDone ? 'border-accent bg-accent text-white' : 'border-line hover:border-accent',
          )}
        >
          {task.mine && task.myDone && <Check size={13} strokeWidth={3} />}
        </button>
        <div className="min-w-0 flex-1">
          <button onClick={() => setOpen(!open)} className={clsx('block text-start text-sm font-medium', task.done && 'text-muted line-through')} data-no-translate>
            {task.title}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            {task.priority !== 'normal' && (
              <span className={clsx('flex items-center gap-1', PRIORITY[task.priority].cls)}>
                <Flag size={11} /> {PRIORITY[task.priority].label}
              </span>
            )}
            {task.dueAt && <span className={clsx(overdue && 'font-medium text-red-500')}>Due {fmtShort(task.dueAt)}</span>}
            <span className="flex items-center gap-1">
              {task.forEveryone ? 'Everyone' : ''}
              <span className="flex -space-x-1.5 rtl:space-x-reverse">
                {task.people.slice(0, 6).map((p) => {
                  const m = person(p.userId);
                  return (
                    <span key={p.userId} className={clsx('relative rounded-full ring-2', p.doneAt ? 'ring-green-500' : 'ring-surface')} title={`${m?.name ?? ''}${p.doneAt ? ' — done' : ''}`}>
                      <Avatar name={m?.name ?? '?'} color={m?.color ?? '#888'} size={18} />
                    </span>
                  );
                })}
              </span>
              {task.total > 0 && (
                <span className={clsx(task.done && 'text-green-600')}>
                  {task.doneCount}/{task.total} done
                </span>
              )}
            </span>
            {task.myEventId && (
              <button onClick={() => navigate(`/w/${workspace.id}/calendar`)} className="flex items-center gap-1 text-accent hover:underline">
                <CalendarCheck size={11} /> In the calendar
              </button>
            )}
          </div>
          {open && task.notes && (
            <p className="mt-2 text-xs whitespace-pre-wrap text-muted" data-no-translate>
              {task.notes}
            </p>
          )}
          {calendar && <CalendarForm detail={detail} task={task} onDone={() => setCalendar(false)} />}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover:opacity-100">
          {task.mine && !task.myEventId && (
            <button onClick={() => setCalendar(!calendar)} title="Add to the calendar (from the meeting's start to the due date)" className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
              <CalendarPlus size={14} />
            </button>
          )}
          {task.canEdit && (
            <>
              <button onClick={() => setEditing(true)} title="Edit" className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                <Pencil size={14} />
              </button>
              <button onClick={() => void remove()} title="Remove" className="rounded p-1 text-muted hover:bg-hover hover:text-red-500">
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>
      {!task.mine && task.createdBy === user.id && <p className="mt-1.5 ps-7 text-[11px] text-faint">You made this for others — only they can tick it.</p>}
    </div>
  );
}

function TasksPanel({ detail }: { detail: MeetingDetail }) {
  const [adding, setAdding] = useState(false);
  const [show, setShow] = useState<'open' | 'all'>('open');
  const list = detail.tasks.filter((t) => show === 'all' || !t.done);
  const doneCount = detail.tasks.filter((t) => t.done).length;
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        {!adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> New task
          </Button>
        )}
        <span className="flex-1" />
        {doneCount > 0 && (
          <button onClick={() => setShow(show === 'open' ? 'all' : 'open')} className="text-xs text-muted hover:text-fg">
            {show === 'open' ? `Show finished (${doneCount})` : 'Hide finished'}
          </button>
        )}
      </div>
      {adding && <TaskEditor detail={detail} onDone={() => setAdding(false)} />}
      {detail.tasks.length === 0 && !adding && <p className="py-6 text-center text-sm text-muted">No tasks yet — add what this meeting should get through, and who it's for.</p>}
      {list.map((t) => (
        <TaskCard key={t.id} detail={detail} task={t} />
      ))}
    </div>
  );
}

// ---------- people ----------

const PERMS: { key: keyof MeetingPerms; label: string }[] = [
  { key: 'talk', label: 'Talk' },
  { key: 'camera', label: 'Camera' },
  { key: 'screen', label: 'Screen' },
  { key: 'chat', label: 'Chat' },
];

/** Who's in the meeting; the host's controls for what each person may do. */
function PeoplePanel({ detail, live, speaking }: { detail: MeetingDetail; live?: Set<string>; speaking?: Set<string> }) {
  const { user } = useApp();
  const [adding, setAdding] = useState<string[] | null>(null);
  const { meeting } = detail;
  const set = (userId: string, body: object) => api(`/api/meetings/${meeting.code}/members/${userId}`, { method: 'PATCH', body }).then(refresh, toastError);
  const people = useMemo(() => {
    const list = [...detail.members];
    if (meeting.hostId && !list.some((m) => m.userId === meeting.hostId)) list.unshift({ userId: meeting.hostId, name: meeting.hostName ?? 'Host', color: '#888', status: 'accepted', cohost: false });
    return list;
  }, [detail, meeting]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {detail.canManage && meeting.endedAt === null && (
        <div className="mb-3">
          {adding ? (
            <div className="space-y-2">
              <PeoplePicker value={adding} onChange={setAdding} exclude={people.map((p) => p.userId)} />
              <div className="flex justify-end gap-2">
                <Button onClick={() => setAdding(null)}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={!adding.length}
                  onClick={() =>
                    void api(`/api/meetings/${meeting.code}/invite`, { method: 'POST', body: { userIds: adding } }).then(() => {
                      setAdding(null);
                      void refresh();
                      toast('Invited');
                    }, toastError)
                  }
                >
                  Invite {adding.length || ''}
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setAdding([])}>
              <UserPlus size={14} /> Invite people
            </Button>
          )}
        </div>
      )}
      <div className="divide-y divide-line rounded-lg border border-line">
        {people.map((p) => {
          const isHost = p.userId === meeting.hostId;
          const perms = detail.perms[p.userId] ?? meeting.defaults;
          const runs = isHost || p.cohost;
          return (
            <div key={p.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className={clsx('relative rounded-full', speaking?.has(p.userId) && 'ring-2 ring-green-500 ring-offset-1 ring-offset-surface')}>
                <Avatar name={p.name} color={p.color} size={26} />
                {live?.has(p.userId) && <span className="absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface bg-green-500" title="In the call" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate font-medium" data-no-translate>
                  {p.name}
                  {p.userId === user.id && <span className="text-xs font-normal text-faint">(you)</span>}
                  {isHost && <Crown size={13} className="text-amber-500" />}
                </span>
                <span className="text-xs text-faint">{isHost ? 'Host' : p.cohost ? 'Co-host' : ({ invited: 'Invited', accepted: 'Coming', declined: "Can't come", joined: 'Joined' } as Record<string, string>)[p.status] ?? p.status}</span>
              </span>
              {detail.canManage && !isHost ? (
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  {PERMS.map(({ key, label }) => (
                    <label key={key} className={clsx('flex items-center gap-1', runs && 'opacity-50')}>
                      <input type="checkbox" checked={runs || perms[key]} disabled={runs || !!meeting.endedAt} onChange={(e) => void set(p.userId, { [key]: e.target.checked })} />
                      {label}
                    </label>
                  ))}
                  {meeting.hostId === user.id && (
                    <Button size="sm" onClick={() => void set(p.userId, { cohost: !p.cohost })} disabled={!!meeting.endedAt}>
                      {p.cohost ? 'Remove co-host' : 'Make co-host'}
                    </Button>
                  )}
                </span>
              ) : (
                !runs && (
                  <span className="flex gap-1.5 text-faint" title="What they may do">
                    {!perms.talk && <MicOff size={14} />}
                    {!perms.camera && <VideoOff size={14} />}
                    {perms.screen && <MonitorUp size={14} />}
                  </span>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- the call ----------

interface TileItem {
  key: string;
  focus: NonNullable<Focus>;
  name: string;
  color: string;
  stream?: MediaStream;
  screen: boolean;
  mic: boolean;
  speaking: boolean;
  mirror: boolean;
  muteNote?: string;
}

function Tile({ item, big = false, focused, onFocus }: { item: TileItem; big?: boolean; focused: boolean; onFocus: () => void }) {
  return (
    <div
      onClick={onFocus}
      className={clsx(
        'group relative flex cursor-pointer items-center justify-center overflow-hidden rounded-xl bg-neutral-900 transition-shadow',
        big ? 'size-full' : 'aspect-video',
      )}
    >
      {item.stream ? (
        <MediaView stream={item.stream} className={clsx('size-full', item.screen ? 'object-contain' : 'object-cover')} mirror={item.mirror} />
      ) : (
        <span className={clsx('rounded-full transition-shadow', item.speaking && 'shadow-[0_0_0_6px_rgba(74,222,128,0.35)]')}>
          <Avatar name={item.name} color={item.color} size={big ? 96 : 56} />
        </span>
      )}
      <span className="absolute start-2 bottom-2 flex max-w-[85%] items-center gap-1 truncate rounded-md bg-black/55 px-1.5 py-0.5 text-xs text-white" data-no-translate>
        {item.screen ? <MonitorUp size={12} /> : item.mic ? <Mic size={12} /> : <MicOff size={12} className="text-red-400" />}
        {item.name}
      </span>
      {/* Talking: a border drawn inside the tile, over the picture. */}
      <span className={clsx('pointer-events-none absolute inset-0 rounded-xl border-[3px] border-green-400 transition-opacity duration-150', item.speaking ? 'opacity-100' : 'opacity-0')} />
      {item.muteNote && <span className="absolute end-2 top-2 rounded bg-black/55 px-1.5 text-[10px] text-white">{item.muteNote}</span>}
      <span className={clsx('absolute end-2 bottom-2 rounded-md bg-black/55 p-1 text-white transition-opacity', focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')} title={focused ? 'Stop focusing' : 'Focus on this'}>
        {focused ? <PinOff size={13} /> : <Pin size={13} />}
      </span>
    </div>
  );
}

function RoomView() {
  const { user, workspace } = useApp();
  const navigate = useNavigate();
  const phone = usePhone();
  const members = useMembers(workspace.id);
  const { active } = useCall();
  const [panel, setPanel] = useState<'chat' | 'people' | 'tasks' | null>(phone ? null : 'chat');
  if (!active) return null;
  const { detail, state, speaking, focus, setFocus, toggle, leave } = active;
  const { meeting } = detail;
  const perms: MeetingPerms = state?.perms[user.id] ?? detail.perms[user.id] ?? meeting.defaults;
  const colorOf = (id: string) => members.data?.members.find((m) => m.id === id)?.color ?? '#6b7280';
  const media = state?.media ?? { mic: false, cam: false, screen: false };
  const canScreen = !!navigator.mediaDevices?.getDisplayMedia;
  const peers = state?.peers ?? [];

  // Everyone's camera (or picture), plus a tile for each shared screen.
  const tiles: TileItem[] = [
    { key: 'me:cam', focus: { peer: 'me', slot: 'cam' }, name: `${user.name} (you)`, color: user.color, stream: media.cam ? state?.local.cam : undefined, screen: false, mic: media.mic, speaking: speaking.has('me'), mirror: true },
  ];
  for (const p of peers) {
    const v = visible(detail, state, p);
    tiles.push({ key: `${p.id}:cam`, focus: { peer: p.id, slot: 'cam' }, name: p.name, color: colorOf(p.userId), stream: v.cam, screen: false, mic: !!v.mic, speaking: speaking.has(p.id), mirror: false, muteNote: !v.may.talk && p.media.mic ? 'not allowed to talk' : undefined });
  }
  if (media.screen && state?.local.screen) tiles.push({ key: 'me:screen', focus: { peer: 'me', slot: 'screen' }, name: 'Your screen', color: user.color, stream: state.local.screen, screen: true, mic: media.mic, speaking: false, mirror: false });
  for (const p of peers) {
    const v = visible(detail, state, p);
    if (v.screen) tiles.push({ key: `${p.id}:screen`, focus: { peer: p.id, slot: 'screen' }, name: `${p.name}'s screen`, color: colorOf(p.userId), stream: v.screen, screen: true, mic: !!v.mic, speaking: false, mirror: false });
  }
  // The big view: what you focused on, else a shared screen.
  const stage = (focus && tiles.find((t) => t.focus.peer === focus.peer && t.focus.slot === focus.slot)) ?? tiles.find((t) => t.screen && t.key !== 'me:screen');
  const rest = stage ? tiles.filter((t) => t !== stage) : tiles;
  const isFocused = (t: TileItem) => !!focus && focus.peer === t.focus.peer && focus.slot === t.focus.slot;
  const pick = (t: TileItem) => setFocus(isFocused(t) ? null : t.focus);
  const live = new Set([user.id, ...peers.map((p) => p.userId)]);
  const speakingUsers = new Set([...(speaking.has('me') ? [user.id] : []), ...peers.filter((p) => speaking.has(p.id)).map((p) => p.userId)]);

  const end = async () => {
    if (!(await confirmDialog({ title: 'End the meeting for everyone?', message: 'Its chat is kept, read-only.', confirmLabel: 'End meeting', danger: true }))) return;
    await api(`/api/meetings/${meeting.code}/end`, { method: 'POST' }).catch(toastError);
  };
  const tool = (on: boolean, may: boolean, onIcon: ReactNode, offIcon: ReactNode, label: string, run: () => void, why: string) => (
    <button
      onClick={run}
      disabled={!may}
      title={may ? label : why}
      className={clsx('flex size-11 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40', on ? 'bg-white text-neutral-900' : 'bg-white/10 text-white hover:bg-white/20')}
    >
      {on ? onIcon : offIcon}
    </button>
  );
  const panelBtn = (name: 'chat' | 'tasks' | 'people', icon: ReactNode, label: string) => (
    <button onClick={() => setPanel(panel === name ? null : name)} title={label} className={clsx('flex size-11 items-center justify-center rounded-full transition-colors', panel === name ? 'bg-accent text-white' : 'bg-white/10 text-white hover:bg-white/20')}>
      {icon}
    </button>
  );

  if (state?.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted">
        {state.error}
        <Button onClick={leave}>Back</Button>
      </div>
    );
  }

  return (
    <div className="af-ltr flex h-full min-h-0 flex-col bg-neutral-950 text-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => navigate(`/w/${workspace.id}/meetings`)} className="rounded-md p-1.5 text-white/70 hover:bg-white/10" title="Keep the call going and look around the app">
          <ArrowLeft size={17} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" data-no-translate>
            {meeting.title}
          </div>
          <div className="text-xs text-white/60">{state?.joined ? `${peers.length + 1} in the call` : 'Joining…'}</div>
        </div>
        <button onClick={() => void navigator.clipboard.writeText(`${location.origin}/w/${workspace.id}/meet/${meeting.code}`).then(() => toast('Link copied'))} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/70 hover:bg-white/10" title="Copy the meeting link">
          <Link2 size={14} /> Link
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 sm:p-3">
          {stage ? (
            <>
              <div className="min-h-0 flex-1">
                <Tile item={stage} big focused={isFocused(stage)} onFocus={() => pick(stage)} />
              </div>
              {rest.length > 0 && (
                <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
                  {rest.map((t) => (
                    <div key={t.key} className="w-40 shrink-0 sm:w-48">
                      <Tile item={t} focused={isFocused(t)} onFocus={() => pick(t)} />
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className={clsx('grid content-center gap-2', tiles.length === 1 ? 'mx-auto max-w-3xl grid-cols-1' : tiles.length <= 4 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 lg:grid-cols-3')}>
                {tiles.map((t) => (
                  <Tile key={t.key} item={t} focused={isFocused(t)} onFocus={() => pick(t)} />
                ))}
              </div>
            </div>
          )}
        </div>
        {panel && (
          <div className={clsx('flex min-h-0 flex-col overflow-hidden bg-surface text-fg', phone ? 'fixed inset-0 z-50' : 'my-3 me-3 w-80 shrink-0 rounded-2xl shadow-xl')} dir="auto">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="flex-1 text-sm font-semibold">{panel === 'chat' ? 'Meeting chat' : panel === 'people' ? `People (${live.size} here)` : 'Tasks'}</span>
              <button onClick={() => setPanel(null)} className="rounded-md px-2 py-0.5 text-sm text-muted hover:bg-hover">
                Close
              </button>
            </div>
            {panel === 'chat' && <ChatView chatId={meeting.chatId} tasks={detail.tasks} compact bubbles />}
            {panel === 'people' && <PeoplePanel detail={detail} live={live} speaking={speakingUsers} />}
            {panel === 'tasks' && <TasksPanel detail={detail} />}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        {tool(media.mic, perms.talk, <Mic size={19} />, <MicOff size={19} />, media.mic ? 'Mute' : 'Unmute', () => void toggle('mic'), "The host hasn't let you talk")}
        {tool(media.cam, perms.camera, <Video size={19} />, <VideoOff size={19} />, media.cam ? 'Turn camera off' : 'Turn camera on', () => void toggle('cam'), "The host hasn't let you use the camera")}
        {canScreen && tool(media.screen, perms.screen, <ScreenShareOff size={19} />, <MonitorUp size={19} />, media.screen ? 'Stop sharing' : 'Share your screen', () => void toggle('screen'), "The host hasn't let you share your screen")}
        <span className="mx-1 h-6 w-px bg-white/15" />
        {panelBtn('chat', <MessageSquare size={18} />, 'Chat')}
        {panelBtn('tasks', <CheckSquare size={18} />, 'Tasks')}
        {panelBtn('people', <Users size={18} />, 'People')}
        {!phone && <DevicePicker />}
        <span className="mx-1 h-6 w-px bg-white/15" />
        <button onClick={leave} title="Leave" className="flex h-11 items-center gap-1.5 rounded-full bg-red-600 px-4 text-sm font-medium hover:bg-red-700">
          <PhoneOff size={17} /> Leave
        </button>
        {detail.canManage && (
          <button onClick={() => void end()} className="h-11 rounded-full px-3 text-sm text-red-300 hover:bg-white/10" title="End the meeting for everyone">
            End for all
          </button>
        )}
      </div>
    </div>
  );
}
