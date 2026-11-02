import clsx from 'clsx';
import { AtSign, CalendarClock, CheckSquare, FileText, Lock, Pencil, SendHorizontal, Trash2, Video, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApp } from '../app/context';
import { PageIcon } from '../app/PageIcon';
import { Avatar, Button, confirmDialog, toastError } from '../components/ui';
import { api, pageTitle } from '../lib/api';
import { queryClient, useMembers, usePages } from '../lib/queries';
import { type ChatDetail, type ChatMessage, type MeetingTask, meetingState, useChat, useMeeting, useMessages } from './chatApi';

// One chat: its messages and the box to write in. Messages carry commands as tokens, drawn as chips:
// <@user> mentions, <page:id> page links, <date:ISO> dates and times, <task:id> meeting tasks and
// <meeting:code> meeting links. In the box they read as "@Name", "[[Page]]", "📅 …" and "☑ …" — typed
// with "@", "[[" or "/" (/page, /date, /task, /meet, /schedule) — and turn back into tokens on sending.

const TOKEN = /<(@[0-9a-f-]{36}|page:[0-9a-f-]{36}|date:[^<>]{1,40}|task:[0-9a-f-]{36}|meeting:[\w-]{4,40})>/gi;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return d.toLocaleString(undefined, dateOnly ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Names, pages and tasks the chips need. */
function useLookups(workspaceId: string, tasks?: MeetingTask[]) {
  const members = useMembers(workspaceId);
  const pages = usePages(workspaceId);
  return useMemo(
    () => ({
      people: new Map((members.data?.members ?? []).map((m) => [m.id, m])),
      pages: new Map((pages.data ?? []).map((p) => [p.id, p])),
      tasks: new Map((tasks ?? []).map((t) => [t.id, t])),
    }),
    [members.data, pages.data, tasks],
  );
}
type Lookups = ReturnType<typeof useLookups>;

function MeetingChip({ code }: { code: string }) {
  const { workspace } = useApp();
  const m = useMeeting(code);
  if (!m.data) return <span className="rounded bg-hover px-1.5 py-0.5 text-xs text-muted">{m.isError ? 'A meeting you can’t open' : 'Meeting…'}</span>;
  const { meeting } = m.data;
  const state = meetingState(meeting);
  return (
    <Link
      to={`/w/${workspace.id}/meet/${code}`}
      className="my-1 flex max-w-sm items-center gap-3 rounded-lg border border-line bg-surface p-2.5 no-underline hover:border-accent"
    >
      <span className={clsx('flex size-9 shrink-0 items-center justify-center rounded-lg', state === 'live' ? 'bg-green-500/15 text-green-600' : 'bg-accent/10 text-accent')}>
        <Video size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg" data-no-translate>
          {meeting.title}
        </span>
        <span className="block text-xs text-muted">
          {state === 'ended' ? 'Ended' : state === 'live' ? 'Happening now' : meeting.startsAt ? fmtDate(meeting.startsAt) : ''}
        </span>
      </span>
      {state !== 'ended' && <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white">Join</span>}
    </Link>
  );
}

function TaskChip({ task }: { task: MeetingTask | undefined; readOnly: boolean }) {
  // Tasks are only shown to the people they're for (and whoever made them).
  if (!task) return <span className="inline-flex items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 align-middle text-xs text-faint"><Lock size={11} /> a task for someone else</span>;
  const toggle = () =>
    api(`/api/meeting-tasks/${task.id}/done`, { method: 'POST', body: { done: !task.myDone } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['meeting'] }))
      .catch(toastError);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-hover px-1.5 py-0.5 align-middle" title={task.mine ? 'Tick your part' : 'Only the people it is for can tick it'}>
      <input type="checkbox" checked={task.mine ? task.myDone : task.done} onChange={toggle} disabled={!task.mine} className="accent-[var(--accent)]" />
      <span className={clsx(task.done && 'text-muted line-through')} data-no-translate>
        {task.title}
      </span>
      {task.total > 1 && <span className="text-[10px] text-faint">{task.doneCount}/{task.total}</span>}
    </span>
  );
}

/** A message's text with its tokens drawn as chips (and web addresses as links). */
export function MessageBody({ body, lookups, readOnly = false }: { body: string; lookups: Lookups; readOnly?: boolean }) {
  const { workspace } = useApp();
  const parts: ReactNode[] = [];
  let last = 0;
  const text = (s: string, key: string) =>
    s.split(URL_RE).map((bit, i) =>
      i % 2 ? (
        <a key={`${key}-${i}`} href={bit} target="_blank" rel="noreferrer" className="text-accent underline">
          {bit}
        </a>
      ) : (
        bit
      ),
    );
  for (const m of body.matchAll(TOKEN)) {
    if (m.index! > last) parts.push(...text(body.slice(last, m.index), `t${last}`));
    const tok = m[1];
    const key = `k${m.index}`;
    if (tok.startsWith('@')) {
      const p = lookups.people.get(tok.slice(1));
      parts.push(
        <span key={key} className="rounded bg-accent/10 px-1 font-medium text-accent" data-no-translate>
          @{p?.name ?? 'someone'}
        </span>,
      );
    } else if (tok.startsWith('page:')) {
      const p = lookups.pages.get(tok.slice(5));
      parts.push(
        p ? (
          <Link key={key} to={`/w/${workspace.id}/p/${p.id}`} className="inline-flex items-center gap-1 rounded bg-hover px-1 align-middle text-fg no-underline hover:text-accent" data-no-translate>
            <PageIcon page={p} size={13} />
            {pageTitle(p)}
          </Link>
        ) : (
          <span key={key} className="text-faint">
            a page you can’t open
          </span>
        ),
      );
    } else if (tok.startsWith('date:')) {
      parts.push(
        <span key={key} className="inline-flex items-center gap-1 rounded bg-hover px-1 align-middle">
          <CalendarClock size={12} className="text-accent" />
          {fmtDate(tok.slice(5))}
        </span>,
      );
    } else if (tok.startsWith('task:')) {
      parts.push(<TaskChip key={key} task={lookups.tasks.get(tok.slice(5))} readOnly={readOnly} />);
    } else if (tok.startsWith('meeting:')) {
      parts.push(<MeetingChip key={key} code={tok.slice(8)} />);
    }
    last = m.index! + m[0].length;
  }
  if (last < body.length) parts.push(...text(body.slice(last), `t${last}`));
  return <>{parts}</>;
}

// ---------- the box to write in ----------

interface Suggest {
  kind: 'mention' | 'command' | 'page';
  query: string;
  start: number;
}
interface Item {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

function Composer({
  detail,
  lookups,
  editing,
  onDoneEditing,
  onSchedule,
}: {
  detail: ChatDetail;
  lookups: Lookups;
  editing: ChatMessage | null;
  onDoneEditing: () => void;
  onSchedule?: () => void;
}) {
  const { workspace, user } = useApp();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [active, setActive] = useState(0);
  const [panel, setPanel] = useState<'date' | 'task' | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // What each readable bit stands for ("@Uma" → "<@id>").
  const tokens = useRef(new Map<string, string>());
  const chatId = detail.chat.id;
  const isMeeting = detail.chat.kind === 'meeting';
  const commandsAllowed = detail.chat.kind !== 'team' || detail.me.canCommand;

  // Editing a message: its tokens back into readable text.
  useEffect(() => {
    if (!editing) return;
    tokens.current.clear();
    const readable = editing.body.replace(TOKEN, (_, tok: string) => {
      let shown = tok;
      if (tok.startsWith('@')) shown = `@${lookups.people.get(tok.slice(1))?.name ?? 'someone'}`;
      else if (tok.startsWith('page:')) shown = `[[${pageTitle(lookups.pages.get(tok.slice(5)))}]]`;
      else if (tok.startsWith('date:')) shown = `📅 ${fmtDate(tok.slice(5))}`;
      else if (tok.startsWith('task:')) shown = `☑ ${lookups.tasks.get(tok.slice(5))?.title ?? 'task'}`;
      else if (tok.startsWith('meeting:')) shown = `🎥 ${tok.slice(8)}`;
      tokens.current.set(shown, `<${tok}>`);
      return shown;
    });
    setText(readable);
    box.current?.focus();
  }, [editing, lookups]);

  const insert = (shown: string, token: string | null, replaceFrom?: number) => {
    const el = box.current;
    const caret = el?.selectionStart ?? text.length;
    const from = replaceFrom ?? caret;
    const next = `${text.slice(0, from)}${shown} ${text.slice(caret)}`;
    if (token) tokens.current.set(shown, token);
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      el?.focus();
      const at = from + shown.length + 1;
      el?.setSelectionRange(at, at);
    });
  };

  const onChange = (value: string) => {
    setText(value);
    const caret = box.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const page = /\[\[([^\]]*)$/.exec(before);
    const at = /(^|\s)([@/])([^\s@/]*)$/.exec(before);
    if (page) setSuggest({ kind: 'page', query: page[1], start: page.index });
    else if (at && (at[2] === '@' || commandsAllowed)) setSuggest({ kind: at[2] === '@' ? 'mention' : 'command', query: at[3], start: at.index + at[1].length });
    else setSuggest(null);
    setActive(0);
  };

  const startMeeting = async () => {
    setSuggest(null);
    setText((t) => t.replace(/(^|\s)\/\w*$/, '$1'));
    try {
      const { code } = await api<{ code: string }>(`/api/workspaces/${workspace.id}/meetings`, {
        method: 'POST',
        body: { title: detail.chat.kind === 'direct' ? `Call with ${detail.chat.name}` : `${detail.chat.name} meeting`, teamChatId: chatId },
      });
      navigate(`/w/${workspace.id}/meet/${code}`);
    } catch (err) {
      toastError(err);
    }
  };

  const items: Item[] = useMemo(() => {
    if (!suggest) return [];
    const q = suggest.query.toLowerCase();
    if (suggest.kind === 'mention') {
      return detail.members
        .filter((m) => m.userId !== user.id && m.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((m) => ({ key: m.userId, label: m.name, icon: <Avatar name={m.name} color={m.color} size={20} />, run: () => insert(`@${m.name}`, `<@${m.userId}>`, suggest.start) }));
    }
    if (suggest.kind === 'page') {
      return [...lookups.pages.values()]
        .filter((p) => !p.archivedAt && pageTitle(p).toLowerCase().includes(q))
        .slice(0, 8)
        .map((p) => ({ key: p.id, label: pageTitle(p), icon: <PageIcon page={p} size={15} />, run: () => insert(`[[${pageTitle(p)}]]`, `<page:${p.id}>`, suggest.start) }));
    }
    const clear = () => setText((t) => t.slice(0, suggest.start) + t.slice(box.current?.selectionStart ?? t.length));
    const all: (Item & { show: boolean })[] = [
      { key: 'page', label: '/page', hint: 'Link to a page', icon: <FileText size={15} />, show: true, run: () => { setText((t) => `${t.slice(0, suggest.start)}[[${t.slice(box.current?.selectionStart ?? t.length)}`); setSuggest({ kind: 'page', query: '', start: suggest.start }); requestAnimationFrame(() => box.current?.setSelectionRange(suggest.start + 2, suggest.start + 2)); } },
      { key: 'mention', label: '/mention', hint: 'Mention someone', icon: <AtSign size={15} />, show: true, run: () => { setText((t) => `${t.slice(0, suggest.start)}@${t.slice(box.current?.selectionStart ?? t.length)}`); setSuggest({ kind: 'mention', query: '', start: suggest.start }); } },
      { key: 'date', label: '/date', hint: 'A date and time', icon: <CalendarClock size={15} />, show: true, run: () => { clear(); setSuggest(null); setPanel('date'); } },
      { key: 'task', label: '/task', hint: 'Add a meeting task', icon: <CheckSquare size={15} />, show: isMeeting && !!detail.meeting && !detail.meeting.ended, run: () => { clear(); setSuggest(null); setPanel('task'); } },
      { key: 'meet', label: '/meet', hint: 'Start a meeting now', icon: <Video size={15} />, show: !isMeeting && (detail.chat.kind !== 'team' || detail.me.canMeet || detail.me.role !== 'member'), run: () => void startMeeting() },
      { key: 'schedule', label: '/schedule', hint: 'Schedule a meeting', icon: <CalendarClock size={15} />, show: !isMeeting && !!onSchedule && (detail.chat.kind !== 'team' || detail.me.canMeet || detail.me.role !== 'member'), run: () => { clear(); setSuggest(null); onSchedule?.(); } },
    ];
    return all.filter((c) => c.show && c.label.slice(1).startsWith(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggest, detail, lookups]);

  const send = async () => {
    let body = text.trim();
    if (!body || busy) return;
    // Readable bits back into tokens (longest first, so "@Ann Lee" wins over "@Ann").
    for (const [shown, token] of [...tokens.current].sort((a, b) => b[0].length - a[0].length)) body = body.split(shown).join(token);
    setBusy(true);
    try {
      if (editing) await api(`/api/chat-messages/${editing.id}`, { method: 'PATCH', body: { body } });
      else await api(`/api/chats/${chatId}/messages`, { method: 'POST', body: { body } });
      setText('');
      tokens.current.clear();
      onDoneEditing();
      queryClient.invalidateQueries({ queryKey: ['chat-messages', chatId] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        items[active]?.run();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (e.key === 'Escape' && editing) {
      setText('');
      onDoneEditing();
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  // Auto-grow up to a few lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  if (detail.readOnly) {
    return (
      <div className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-sm text-muted">
        <Lock size={14} /> The meeting has ended — this chat is kept, read-only.
      </div>
    );
  }
  if (detail.chat.kind === 'team' && !detail.me.canTalk) {
    return (
      <div className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-sm text-muted">
        <Lock size={14} /> Only some people can send messages in this team.
      </div>
    );
  }

  return (
    <div className="relative border-t border-line p-2.5">
      {suggest && items.length > 0 && (
        <div className="shadow-pop absolute start-2.5 bottom-full z-20 mb-1 w-72 max-w-[calc(100%-1.25rem)] overflow-hidden rounded-lg border border-line bg-surface p-1">
          {items.map((it, i) => (
            <button
              key={it.key}
              onMouseDown={(e) => {
                e.preventDefault();
                it.run();
              }}
              onMouseEnter={() => setActive(i)}
              className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm', i === active && 'bg-hover')}
            >
              <span className="flex w-5 shrink-0 justify-center text-muted">{it.icon}</span>
              <span className="truncate" data-no-translate={suggest.kind !== 'command' || undefined}>
                {it.label}
              </span>
              {it.hint && <span className="ms-auto truncate text-xs text-faint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {panel === 'date' && <DatePanel onCancel={() => setPanel(null)} onPick={(iso) => { setPanel(null); insert(`📅 ${fmtDate(iso)}`, `<date:${iso}>`); }} />}
      {panel === 'task' && detail.meeting && (
        <TaskPanel
          code={detail.meeting.code}
          members={detail.members}
          onCancel={() => setPanel(null)}
          onMade={(id, title) => {
            setPanel(null);
            insert(`☑ ${title}`, `<task:${id}>`);
          }}
        />
      )}
      {editing && (
        <div className="mb-1.5 flex items-center gap-2 px-1 text-xs text-muted">
          <Pencil size={12} /> Editing a message
          <button onClick={() => { setText(''); onDoneEditing(); }} className="ms-auto rounded p-0.5 hover:bg-hover" title="Stop editing">
            <X size={13} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={box}
          value={text}
          rows={1}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => setSuggest(null), 150)}
          placeholder={commandsAllowed ? 'Message… (@ to mention, [[ for a page, / for commands)' : 'Message… (@ to mention)'}
          className="max-h-40 min-h-9 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <Button variant="primary" onClick={() => void send()} disabled={!text.trim()} loading={busy} title="Send (Enter)" className="h-9">
          <SendHorizontal size={15} />
        </Button>
      </div>
    </div>
  );
}

function DatePanel({ onPick, onCancel }: { onPick: (iso: string) => void; onCancel: () => void }) {
  const now = new Date(Date.now() + 3600_000);
  now.setMinutes(0, 0, 0);
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [value, setValue] = useState(local(now));
  const [withTime, setWithTime] = useState(true);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-hover/50 p-2 text-sm">
      <CalendarClock size={15} className="text-accent" />
      <input
        type={withTime ? 'datetime-local' : 'date'}
        value={withTime ? value : value.slice(0, 10)}
        onChange={(e) => setValue(withTime ? e.target.value : `${e.target.value}T00:00`)}
        className="h-8 rounded-md border border-line bg-surface px-2"
      />
      <label className="flex items-center gap-1 text-xs text-muted">
        <input type="checkbox" checked={withTime} onChange={(e) => setWithTime(e.target.checked)} /> Time
      </label>
      <Button variant="primary" onClick={() => onPick(withTime ? new Date(value).toISOString() : value.slice(0, 10))}>
        Insert
      </Button>
      <button onClick={onCancel} className="rounded p-1 text-muted hover:bg-hover" title="Cancel">
        <X size={14} />
      </button>
    </div>
  );
}

function TaskPanel({ code, members, onMade, onCancel }: { code: string; members: ChatDetail['members']; onMade: (id: string, title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const make = async () => {
    if (!title.trim()) return;
    try {
      const { id } = await api<{ id: string }>(`/api/meetings/${code}/tasks`, { method: 'POST', body: { title: title.trim(), assigneeIds: assignee && assignee !== 'everyone' ? [assignee] : [], forEveryone: !assignee || assignee === 'everyone' } });
      queryClient.invalidateQueries({ queryKey: ['meeting'] });
      onMade(id, title.trim());
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
      className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-hover/50 p-2 text-sm"
    >
      <CheckSquare size={15} className="text-accent" />
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task" className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2" />
      <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="h-8 rounded-md border border-line bg-surface px-1.5 text-xs">
        <option value="everyone">Everyone</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
      <Button type="submit" variant="primary" disabled={!title.trim()}>
        Add
      </Button>
      <button type="button" onClick={onCancel} className="rounded p-1 text-muted hover:bg-hover" title="Cancel">
        <X size={14} />
      </button>
    </form>
  );
}

// ---------- the chat ----------

/** A chat's messages and the box to write in (used on the Chat page and in meetings). */
export function ChatView({
  chatId,
  tasks,
  onSchedule,
  compact = false,
  bubbles = false,
}: {
  chatId: string;
  tasks?: MeetingTask[];
  onSchedule?: () => void;
  compact?: boolean;
  /** Chat bubbles (yours on one side, others' on the other), as in a meeting. */
  bubbles?: boolean;
}) {
  const { user, workspace } = useApp();
  const detail = useChat(chatId);
  const messages = useMessages(chatId);
  const lookups = useLookups(workspace.id, tasks);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const list = messages.data?.messages ?? [];

  // Keep to the newest message, and mark the chat read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length, chatId]);
  useEffect(() => {
    if (!list.length) return;
    void api(`/api/chats/${chatId}/read`, { method: 'POST' })
      .then(() => queryClient.invalidateQueries({ queryKey: ['chats'] }))
      .catch(() => {});
  }, [list.length, chatId]);

  if (!detail.data) return <div className="flex-1" />;
  const d = detail.data;

  const remove = async (m: ChatMessage) => {
    if (!(await confirmDialog({ title: 'Delete this message?', confirmLabel: 'Delete', danger: true }))) return;
    await api(`/api/chat-messages/${m.id}`, { method: 'DELETE' }).catch(toastError);
  };
  const canModerate = d.chat.kind === 'team' && d.me.role !== 'member';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className={clsx('min-h-0 flex-1 overflow-y-auto', compact ? 'px-2 py-2' : 'px-3 py-3 sm:px-5')}>
        {messages.data?.more && <p className="pb-2 text-center text-xs text-faint">Older messages aren’t shown.</p>}
        {list.length === 0 && <p className="py-10 text-center text-sm text-muted">No messages yet — say hello.</p>}
        {list.map((m, i) => {
          const prev = list[i - 1];
          const grouped = prev && prev.kind === 'text' && m.kind === 'text' && prev.userId === m.userId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          const day = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const who = m.userId ? lookups.people.get(m.userId) : null;
          return (
            <div key={m.id}>
              {day && (
                <div className="my-3 flex items-center gap-3 text-[11px] text-faint">
                  <span className="h-px flex-1 bg-line" />
                  {new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              {bubbles && m.kind === 'text' ? (
                <div className={clsx('group flex gap-2', m.userId === user.id ? 'flex-row-reverse' : '', grouped ? 'mt-0.5' : 'mt-2.5')}>
                  <div className="w-6 shrink-0">{!grouped && m.userId !== user.id && <Avatar name={who?.name ?? '?'} color={who?.color ?? '#888'} size={24} />}</div>
                  <div className={clsx('flex max-w-[85%] min-w-0 flex-col', m.userId === user.id ? 'items-end' : 'items-start')}>
                    {!grouped && (
                      <span className="mb-0.5 px-1 text-[11px] text-faint" data-no-translate>
                        {m.userId === user.id ? '' : `${who?.name ?? 'Someone'} · `}
                        {fmtTime(m.createdAt)}
                      </span>
                    )}
                    <div
                      className={clsx(
                        'rounded-2xl px-3 py-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap',
                        m.userId === user.id ? 'rounded-se-md bg-accent text-white [&_a]:text-white' : 'rounded-ss-md bg-hover',
                        m.deleted && 'italic opacity-60',
                      )}
                    >
                      {m.deleted ? 'Message deleted' : <MessageBody body={m.body} lookups={lookups} readOnly={d.readOnly} />}
                    </div>
                  </div>
                  {!m.deleted && !d.readOnly && m.userId === user.id && (
                    <div className="hidden items-center gap-0.5 self-center group-hover:flex">
                      <button onClick={() => setEditing(m)} title="Edit" className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                        <Pencil size={12} />
                      </button>
                      <button onClick={() => void remove(m)} title="Delete" className="rounded p-1 text-muted hover:bg-hover hover:text-red-500">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>
              ) : m.kind === 'system' ? (
                <p className="my-1.5 text-center text-xs text-muted">
                  <MessageBody body={m.body} lookups={lookups} />
                </p>
              ) : (
                <div className={clsx('group relative flex gap-2.5 rounded-lg px-1.5 hover:bg-hover/50', grouped ? 'py-0.5' : 'mt-2 py-1')}>
                  <div className="w-8 shrink-0">{!grouped && <Avatar name={who?.name ?? '?'} color={who?.color ?? '#888'} size={32} />}</div>
                  <div className="min-w-0 flex-1">
                    {!grouped && (
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold" data-no-translate>
                          {who?.name ?? 'Someone'}
                        </span>
                        <span className="text-[11px] text-faint">{fmtTime(m.createdAt)}</span>
                      </div>
                    )}
                    <div className={clsx('text-sm leading-relaxed break-words whitespace-pre-wrap', m.deleted && 'text-faint italic')}>
                      {m.deleted ? 'Message deleted' : <MessageBody body={m.body} lookups={lookups} readOnly={d.readOnly} />}
                      {m.editedAt && !m.deleted && <span className="ms-1 text-[10px] text-faint">(edited)</span>}
                    </div>
                  </div>
                  {!m.deleted && !d.readOnly && (m.userId === user.id || canModerate) && (
                    <div className="absolute end-1 -top-2 hidden gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-sm group-hover:flex">
                      {m.userId === user.id && (
                        <button onClick={() => setEditing(m)} title="Edit" className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                          <Pencil size={13} />
                        </button>
                      )}
                      <button onClick={() => void remove(m)} title="Delete" className="rounded p-1 text-muted hover:bg-hover hover:text-red-500">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Composer detail={d} lookups={lookups} editing={editing} onDoneEditing={() => setEditing(null)} onSchedule={onSchedule} />
    </div>
  );
}
