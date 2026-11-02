import clsx from 'clsx';
import { Check, Pencil, Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../app/context';
import { Avatar, Button, Dialog, Input, toast, toastError } from '../components/ui';
import { api } from '../lib/api';
import { queryClient, useMembers } from '../lib/queries';
import type { MeetingPerms } from './chatApi';
import { PeoplePicker } from './PeoplePicker';

// Scheduling a meeting (or starting one now): when, who's invited, what people may do by default, and
// tasks to work through — the link exists straight away.

const localNow = () => {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** A task being prepared with the meeting. */
interface Draft {
  title: string;
  notes: string;
  due: string;
  priority: 'low' | 'normal' | 'high';
  everyone: boolean;
  who: string[];
}
const newDraft = (title: string): Draft => ({ title, notes: '', due: '', priority: 'normal', everyone: true, who: [] });

/** Editing a prepared task: what, notes, due date, priority, and who it's for (you and the invitees). */
function DraftEditor({ draft, people, onChange, onDone }: { draft: Draft; people: string[]; onChange: (d: Draft) => void; onDone: () => void }) {
  const { workspace, user } = useApp();
  const members = useMembers(workspace.id);
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  return (
    <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-2.5">
      <Input value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Task" />
      <textarea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} placeholder="Notes (optional)" className="w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent" />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5 text-muted">
          Due
          <input type="datetime-local" value={draft.due} onChange={(e) => set({ due: e.target.value })} className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg" />
        </label>
        <select value={draft.priority} onChange={(e) => set({ priority: e.target.value as Draft['priority'] })} className="h-8 rounded-md border border-line bg-surface px-2 text-sm">
          <option value="high">High priority</option>
          <option value="normal">Normal priority</option>
          <option value="low">Low priority</option>
        </select>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className="font-medium text-muted">For</span>
        <label className="flex items-center gap-1">
          <input type="radio" checked={draft.everyone} onChange={() => set({ everyone: true })} /> Everyone
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={!draft.everyone} onChange={() => set({ everyone: false })} /> Chosen people
        </label>
      </div>
      {!draft.everyone && (
        <div className="flex flex-wrap gap-1.5">
          {people.map((id) => {
            const m = members.data?.members.find((x) => x.id === id);
            const on = draft.who.includes(id);
            return (
              <button
                type="button"
                key={id}
                onClick={() => set({ who: on ? draft.who.filter((x) => x !== id) : [...draft.who, id] })}
                className={clsx('flex items-center gap-1.5 rounded-full border py-0.5 ps-0.5 pe-2.5 text-xs', on ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:bg-hover')}
              >
                <Avatar name={m?.name ?? '?'} color={m?.color ?? '#888'} size={20} />
                <span data-no-translate>{id === user.id ? 'You' : (m?.name ?? '')}</span>
                {on && <Check size={12} />}
              </button>
            );
          })}
          {people.length === 1 && <span className="self-center text-[11px] text-faint">Invite people above to give them tasks.</span>}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="button" variant="primary" onClick={onDone} disabled={!draft.title.trim() || (!draft.everyone && !draft.who.length)}>
          Done
        </Button>
      </div>
    </div>
  );
}

const PERM_LABELS: { key: keyof MeetingPerms; label: string }[] = [
  { key: 'talk', label: 'Talk' },
  { key: 'camera', label: 'Camera' },
  { key: 'screen', label: 'Share screen' },
  { key: 'chat', label: 'Chat' },
];

export function ScheduleDialog({ open, onClose, teamChatId = null, defaultTitle = '' }: { open: boolean; onClose: () => void; teamChatId?: string | null; defaultTitle?: string }) {
  const { workspace, user } = useApp();
  const navigate = useNavigate();
  const members = useMembers(workspace.id);
  const nameOf = (id: string) => (id === user.id ? 'You' : (members.data?.members.find((m) => m.id === id)?.name ?? ''));
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState('');
  const [now, setNow] = useState(false);
  const [when, setWhen] = useState(localNow);
  const [duration, setDuration] = useState(30);
  const [people, setPeople] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<MeetingPerms>({ talk: true, camera: true, screen: false, chat: true });
  const [open2ws, setOpen2ws] = useState(true);
  const [tasks, setTasks] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const all = task.trim() ? [...tasks, newDraft(task.trim())] : tasks;
      const { code } = await api<{ code: string }>(`/api/workspaces/${workspace.id}/meetings`, {
        method: 'POST',
        body: {
          title: title.trim(),
          description,
          startsAt: now ? null : new Date(when).toISOString(),
          durationMin: duration,
          inviteeIds: people,
          teamChatId,
          tasks: all.map((t) => ({
            title: t.title,
            notes: t.notes,
            dueAt: t.due ? new Date(t.due).toISOString() : null,
            priority: t.priority,
            forEveryone: t.everyone,
            assigneeIds: t.everyone ? [] : t.who,
          })),
          defaults,
          openToWorkspace: open2ws,
        },
      });
      queryClient.invalidateQueries({ queryKey: ['meetings'] });
      onClose();
      if (now) navigate(`/w/${workspace.id}/meet/${code}`);
      else {
        const link = `${location.origin}/w/${workspace.id}/meet/${code}`;
        void navigator.clipboard?.writeText(link).catch(() => {});
        toast('Meeting scheduled — link copied');
        navigate(`/w/${workspace.id}/meet/${code}`);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={teamChatId ? 'Meeting for this chat' : 'New meeting'} width={520} maxHeight="88vh">
      <form onSubmit={submit} className="space-y-3.5 px-5 pb-5">
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's it about?" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes or agenda (optional)" rows={2} className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!now} onChange={() => setNow(false)} /> Schedule
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={now} onChange={() => setNow(true)} /> Start now
          </label>
          {!now && <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2" />}
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="h-9 rounded-md border border-line bg-surface px-2" title="How long">
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </option>
            ))}
          </select>
        </div>
        {!teamChatId && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted">Invite (they get a notification{', and an email if mail is set up'})</div>
            <PeoplePicker value={people} onChange={setPeople} />
          </div>
        )}
        <div>
          <div className="mb-1 text-xs font-medium text-muted">Everyone may (you can change it per person in the meeting)</div>
          <div className="flex flex-wrap gap-1.5">
            {PERM_LABELS.map(({ key, label }) => (
              <label key={key} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-1 text-sm">
                <input type="checkbox" checked={defaults[key]} onChange={(e) => setDefaults({ ...defaults, [key]: e.target.checked })} /> {label}
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={open2ws} onChange={(e) => setOpen2ws(e.target.checked)} /> Anyone in the workspace with the link can join
          </label>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">Tasks for the meeting (click one to choose who it's for, a due date and more)</div>
          <div className="mb-2 space-y-1.5">
            {tasks.map((t, i) =>
              editing === i ? (
                <DraftEditor
                  key={i}
                  draft={t}
                  people={[user.id, ...people]}
                  onChange={(d) => setTasks(tasks.map((x, j) => (j === i ? d : x)))}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <div key={i} className="group flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm">
                  <button type="button" onClick={() => setEditing(i)} className="min-w-0 flex-1 text-start" title="Edit">
                    <span className="block truncate">{t.title}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {t.everyone ? 'Everyone' : t.who.map((id) => nameOf(id)).join(', ') || 'Choose who it’s for'}
                      {t.due && ` · due ${new Date(t.due).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
                      {t.priority !== 'normal' && ` · ${t.priority} priority`}
                    </span>
                  </button>
                  <button type="button" onClick={() => setEditing(i)} className="rounded p-1 text-faint hover:bg-hover hover:text-fg" title="Edit">
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTasks(tasks.filter((_, j) => j !== i));
                      setEditing(null);
                    }}
                    className="rounded p-1 text-faint hover:bg-hover hover:text-red-500"
                    title="Remove"
                  >
                    <X size={13} />
                  </button>
                </div>
              ),
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (task.trim()) setTasks([...tasks, newDraft(task.trim())]);
                  setTask('');
                }
              }}
              placeholder="Add a task (Enter)"
              className="flex-1"
            />
            <Button type="button" onClick={() => { if (task.trim()) setTasks([...tasks, newDraft(task.trim())]); setTask(''); }} title="Add task">
              <Plus size={14} />
            </Button>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()} loading={busy}>
            {now ? 'Start meeting' : 'Schedule'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
