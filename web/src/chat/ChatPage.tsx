import clsx from 'clsx';
import { ArrowLeft, CalendarPlus, Crown, LogOut, MessageSquarePlus, MessagesSquare, Settings2, Shield, UserMinus, UserPlus, Users, Video } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApp } from '../app/context';
import { Avatar, Button, confirmDialog, Dialog, IconButton, Input, Spinner, toastError } from '../components/ui';
import { api } from '../lib/api';
import { usePhone } from '../lib/device';
import { queryClient, useMembers } from '../lib/queries';
import { SidebarIcon } from '../notifications/Notifications';
import { type ChatDetail, type ChatKind, type ChatSummary, useChat, useChats } from './chatApi';
import { ChatView } from './ChatView';
import { PeoplePicker } from './PeoplePicker';
import { ScheduleDialog } from './ScheduleDialog';

// The Chat page: private chats, groups and teams on the left, the open chat on the right (on a phone,
// one or the other). Meetings have their own page; a meeting's chat lives in the meeting.

const KIND_LABEL: Record<ChatKind, string> = { direct: 'Private', group: 'Group', team: 'Team', meeting: 'Meeting' };
const SECTIONS: { kind: ChatKind; label: string }[] = [
  { kind: 'direct', label: 'Private chats' },
  { kind: 'group', label: 'Groups' },
  { kind: 'team', label: 'Teams' },
];

/** A message's first line with its tokens read out. */
const preview = (body: string | null) =>
  (body ?? '')
    .replace(/<@[0-9a-f-]{36}>/gi, '@…')
    .replace(/<page:[^>]+>/g, '📄')
    .replace(/<date:[^>]+>/g, '📅')
    .replace(/<task:[^>]+>/g, '☑')
    .replace(/<meeting:[^>]+>/g, '🎥 meeting')
    .split('\n')[0];

export function ChatPage() {
  const { workspace, sidebarOpen, toggleSidebar } = useApp();
  const { chatId } = useParams();
  const navigate = useNavigate();
  const phone = usePhone();
  const chats = useChats(workspace.id);
  const [making, setMaking] = useState<ChatKind | null>(null);
  const base = `/w/${workspace.id}/chat`;

  const list = (
    <div className={clsx('flex min-h-0 flex-col border-line', phone ? 'flex-1' : 'w-72 shrink-0 border-e')}>
      <header className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        {!sidebarOpen && !phone && (
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        )}
        <h1 className="flex flex-1 items-center gap-2 text-lg font-semibold">
          <MessagesSquare size={18} className="text-muted" /> Chat
        </h1>
        <Link to={`/w/${workspace.id}/meetings`} className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-hover" title="Meetings">
          <Video size={15} /> Meetings
        </Link>
        <IconButton onClick={() => setMaking('direct')} title="New chat">
          <MessageSquarePlus size={17} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {chats.isPending && <Spinner />}
        {chats.data?.length === 0 && (
          <div className="p-4 text-center text-sm text-muted">
            <p>No chats yet.</p>
            <div className="mt-3 flex flex-col gap-1.5">
              <Button onClick={() => setMaking('direct')}>Message someone</Button>
              <Button onClick={() => setMaking('group')}>Make a group</Button>
              <Button onClick={() => setMaking('team')}>Make a team</Button>
            </div>
          </div>
        )}
        {SECTIONS.map(({ kind, label }) => {
          const items = (chats.data ?? []).filter((c) => c.kind === kind);
          if (!items.length) return null;
          return (
            <section key={kind} className="mb-2">
              <div className="flex items-center justify-between px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
                {label}
                <button onClick={() => setMaking(kind)} className="rounded px-1 text-base leading-none hover:bg-hover hover:text-fg" title={`New ${KIND_LABEL[kind].toLowerCase()}`}>
                  +
                </button>
              </div>
              {items.map((c) => (
                <ChatRow key={c.id} chat={c} active={c.id === chatId} onOpen={() => navigate(`${base}/${c.id}`)} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      {(!phone || !chatId) && list}
      {chatId ? <OpenChat key={chatId} chatId={chatId} onBack={() => navigate(base)} /> : !phone && <div className="flex flex-1 items-center justify-center text-sm text-muted">Pick a chat, or start one.</div>}
      <NewChatDialog kind={making} onClose={() => setMaking(null)} onMade={(id) => navigate(`${base}/${id}`)} />
    </div>
  );
}

function ChatRow({ chat, active, onOpen }: { chat: ChatSummary; active: boolean; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start', active ? 'bg-accent/10' : 'hover:bg-hover')}>
      <span className={clsx('flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', chat.kind === 'team' ? 'bg-amber-500/15 text-amber-600' : chat.kind === 'group' ? 'bg-sky-500/15 text-sky-600' : 'bg-accent/15 text-accent')}>
        {chat.kind === 'team' ? <Shield size={15} /> : chat.kind === 'group' ? <Users size={15} /> : chat.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className={clsx('block truncate text-sm', chat.unread ? 'font-semibold' : 'font-medium')} data-no-translate>
          {chat.name}
        </span>
        <span className="block truncate text-xs text-faint" data-no-translate>
          {preview(chat.last) || ' '}
        </span>
      </span>
      {chat.unread > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">{chat.unread}</span>}
    </button>
  );
}

function OpenChat({ chatId, onBack }: { chatId: string; onBack: () => void }) {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const phone = usePhone();
  const chat = useChat(chatId);
  const [settings, setSettings] = useState(false);
  const [schedule, setSchedule] = useState(false);
  if (chat.isError) return <div className="flex flex-1 items-center justify-center text-sm text-muted">This chat isn’t available.</div>;
  if (!chat.data) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;
  const d = chat.data;
  const mayMeet = d.chat.kind !== 'team' || d.me.role !== 'member' || d.me.canMeet;
  const startNow = async () => {
    try {
      const { code } = await api<{ code: string }>(`/api/workspaces/${workspace.id}/meetings`, {
        method: 'POST',
        body: { title: d.chat.kind === 'direct' ? `Call with ${d.chat.name}` : `${d.chat.name} meeting`, teamChatId: chatId },
      });
      navigate(`/w/${workspace.id}/meet/${code}`);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-1.5 border-b border-line px-2 py-2 sm:px-4">
        {phone && (
          <IconButton onClick={onBack} title="Back to chats">
            <ArrowLeft size={17} className="rtl:rotate-180" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" data-no-translate>
            {d.chat.name}
          </div>
          <div className="text-xs text-muted">
            {KIND_LABEL[d.chat.kind]} · {d.members.length} {d.members.length === 1 ? 'person' : 'people'}
          </div>
        </div>
        {mayMeet && (
          <>
            <IconButton onClick={() => void startNow()} title="Start a meeting now">
              <Video size={17} />
            </IconButton>
            <IconButton onClick={() => setSchedule(true)} title="Schedule a meeting">
              <CalendarPlus size={17} />
            </IconButton>
          </>
        )}
        {d.chat.kind !== 'direct' && (
          <IconButton onClick={() => setSettings(true)} title="People and settings">
            <Settings2 size={17} />
          </IconButton>
        )}
      </header>
      <ChatView chatId={chatId} onSchedule={mayMeet ? () => setSchedule(true) : undefined} />
      <ChatSettings open={settings} onClose={() => setSettings(false)} detail={d} onLeft={onBack} />
      {schedule && <ScheduleDialog open onClose={() => setSchedule(false)} teamChatId={chatId} defaultTitle={d.chat.kind === 'direct' ? `Call with ${d.chat.name}` : `${d.chat.name} meeting`} />}
    </div>
  );
}

function NewChatDialog({ kind, onClose, onMade }: { kind: ChatKind | null; onClose: () => void; onMade: (id: string) => void }) {
  const { workspace } = useApp();
  const [type, setType] = useState<ChatKind>('direct');
  const [name, setName] = useState('');
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<ChatKind | null>(null);
  if (kind !== shown) {
    setShown(kind);
    if (kind) {
      setType(kind);
      setName('');
      setPeople([]);
    }
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>(`/api/workspaces/${workspace.id}/chats`, { method: 'POST', body: { kind: type, name: name.trim(), memberIds: people } });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      onClose();
      onMade(id);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!kind} onClose={onClose} title="New chat" width={460} maxHeight="88vh">
      <form onSubmit={submit} className="space-y-3 px-5 pb-5">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-hover p-1 text-sm">
          {(['direct', 'group', 'team'] as const).map((k) => (
            <button key={k} type="button" onClick={() => { setType(k); if (k === 'direct') setPeople(people.slice(0, 1)); }} className={clsx('rounded-md py-1.5', type === k ? 'bg-surface font-medium shadow-sm' : 'text-muted')}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">
          {type === 'direct'
            ? 'Just the two of you.'
            : type === 'group'
              ? 'Everyone can talk, add people and start meetings; you (the owner) can remove people.'
              : 'You and the admins you choose decide who may talk, use commands and start meetings.'}
        </p>
        {type !== 'direct' && <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'team' ? 'Team name' : 'Group name'} />}
        <PeoplePicker value={people} onChange={setPeople} single={type === 'direct'} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={type === 'direct' ? people.length !== 1 : !name.trim()}>
            {type === 'direct' ? 'Open chat' : `Make ${type}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** People in a group or team: adding, removing, and (teams) who may talk, use commands and start meetings. */
function ChatSettings({ open, onClose, detail, onLeft }: { open: boolean; onClose: () => void; detail: ChatDetail; onLeft: () => void }) {
  const { user, workspace } = useApp();
  const members = useMembers(workspace.id);
  const [adding, setAdding] = useState<string[]>([]);
  const [name, setName] = useState(detail.chat.name);
  const id = detail.chat.id;
  const team = detail.chat.kind === 'team';
  const iRun = detail.me.role !== 'member';
  const canAdd = detail.chat.kind === 'group' || (team && iRun);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['chat', id] });
    queryClient.invalidateQueries({ queryKey: ['chats'] });
  };
  const call = (p: Promise<unknown>) => p.then(refresh).catch(toastError);
  const leave = async () => {
    if (!(await confirmDialog({ title: `Leave “${detail.chat.name}”?`, message: 'You can be added back later.', confirmLabel: 'Leave', danger: true }))) return;
    await api(`/api/chats/${id}/members/${user.id}`, { method: 'DELETE' }).then(() => {
      refresh();
      onClose();
      onLeft();
    }, toastError);
  };
  const emailOf = (uid: string) => members.data?.members.find((m) => m.id === uid)?.email;

  return (
    <Dialog open={open} onClose={onClose} title={team ? 'Team' : 'Group'} width={560} maxHeight="88vh">
      <div className="space-y-4 px-5 pb-5">
        {(detail.chat.kind === 'group' || iRun) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void call(api(`/api/chats/${id}`, { method: 'PATCH', body: { name } }));
            }}
            className="flex gap-2"
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
            <Button type="submit" disabled={!name.trim() || name === detail.chat.name}>
              Rename
            </Button>
          </form>
        )}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">People</h3>
          {team && <p className="mb-2 text-xs text-faint">Ticks: may talk · may use commands · may start meetings. The owner and admins may always do everything.</p>}
          <div className="divide-y divide-line rounded-lg border border-line">
            {detail.members.map((m) => {
              const isMe = m.userId === user.id;
              const mayRemove = !isMe && (detail.chat.kind === 'group' ? detail.me.role === 'owner' : detail.me.role === 'owner' ? m.role !== 'owner' : detail.me.role === 'admin' && m.role === 'member');
              const mayEdit = team && iRun && m.role !== 'owner' && !(detail.me.role === 'admin' && m.role === 'admin');
              const patch = (body: object) => call(api(`/api/chats/${id}/members/${m.userId}`, { method: 'PATCH', body }));
              return (
                <div key={m.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <Avatar name={m.name} color={m.color} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate font-medium" data-no-translate>
                      {m.name}
                      {isMe && <span className="text-xs font-normal text-faint">(you)</span>}
                      {m.role === 'owner' && <Crown size={13} className="text-amber-500" />}
                      {m.role === 'admin' && <Shield size={13} className="text-sky-500" />}
                    </span>
                    <span className="block truncate text-xs text-faint">{emailOf(m.userId)}</span>
                  </span>
                  {team && m.role === 'member' && (
                    <span className="flex items-center gap-2 text-xs">
                      {(['canTalk', 'canCommand', 'canMeet'] as const).map((k) => (
                        <label key={k} className="flex items-center gap-1" title={k === 'canTalk' ? 'May talk' : k === 'canCommand' ? 'May use commands' : 'May start meetings'}>
                          <input type="checkbox" checked={m[k]} disabled={!mayEdit} onChange={(e) => void patch({ [k]: e.target.checked })} />
                          {k === 'canTalk' ? 'Talk' : k === 'canCommand' ? 'Commands' : 'Meetings'}
                        </label>
                      ))}
                    </span>
                  )}
                  {team && detail.me.role === 'owner' && m.role !== 'owner' && (
                    <Button size="sm" onClick={() => void patch({ role: m.role === 'admin' ? 'member' : 'admin' })}>
                      {m.role === 'admin' ? 'Remove admin' : 'Make admin'}
                    </Button>
                  )}
                  {mayRemove && (
                    <button onClick={() => void call(api(`/api/chats/${id}/members/${m.userId}`, { method: 'DELETE' }))} title="Remove from the chat" className="rounded p-1.5 text-faint hover:bg-hover hover:text-red-500">
                      <UserMinus size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        {canAdd && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Add people</h3>
            <PeoplePicker value={adding} onChange={setAdding} exclude={detail.members.map((m) => m.userId)} />
            <div className="mt-2 flex justify-end">
              <Button variant="primary" disabled={!adding.length} onClick={() => void call(api(`/api/chats/${id}/members`, { method: 'POST', body: { userIds: adding } })).then(() => setAdding([]))}>
                <UserPlus size={14} /> Add {adding.length || ''}
              </Button>
            </div>
          </section>
        )}
        <div className="flex justify-between border-t border-line pt-3">
          <Button onClick={() => void leave()}>
            <LogOut size={14} /> Leave
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}
