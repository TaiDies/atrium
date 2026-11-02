import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronRight, Download, ListChecks, MessagesSquare, UserPlus, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Avatar, IconButton, Spinner } from '../components/ui';
import { api, PAGE_TYPES, pageTitle } from '../lib/api';
import { coverStyle } from '../lib/covers';
import { useRecent } from '../lib/queries';
import { greeting, timeAgo } from '../lib/time';
import { useApp } from './context';
import { PageIcon, PageTypeIcon } from './PageIcon';
import { SidebarIcon, useNotifications } from '../notifications/Notifications';
import { meetingState, useChats, useMeetings } from '../chat/chatApi';

interface HomeTask {
  key: string;
  title: string;
  time: string | null;
  done: boolean;
  overdue: boolean;
  pageId?: string;
  pageTitle?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const at = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** A card on the home screen: a title with a link to the full view, and its contents. */
function Panel({ icon, title, to, linkLabel, children }: { icon: ReactNode; title: string; to: string; linkLabel: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <section className="flex min-h-[180px] flex-col rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
        <h2 className="flex-1 font-semibold">{title}</h2>
        {linkLabel && (
          <button onClick={() => navigate(to)} className="flex items-center gap-0.5 text-xs text-muted hover:text-fg">
            {linkLabel} <ChevronRight size={13} className="rtl:rotate-180" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="py-6 text-center text-sm text-faint">{children}</p>;

// Home: what matters right now — today's tasks, meetings, unread chats, what's new under the bell and
// recently edited pages — with the quick ways to make something new underneath.
export function HomeView() {
  const { user, workspace, newPage, openImport, openSettings, sidebarOpen, toggleSidebar, canCreatePages } = useApp();
  const recent = useRecent(workspace.id);
  const navigate = useNavigate();
  const guest = workspace.role === 'guest';
  const base = `/w/${workspace.id}`;
  const day = todayIso();
  const tasks = useQuery({
    queryKey: ['tasks', workspace.id, day],
    queryFn: () => api<{ tasks: HomeTask[] }>(`/api/workspaces/${workspace.id}/tasks?date=${day}`),
    enabled: !guest,
  });
  const meetings = useMeetings(workspace.id);
  const chats = useChats(workspace.id);
  const notes = useNotifications();

  const open = (tasks.data?.tasks ?? []).filter((t) => !t.done);
  const overdue = open.filter((t) => t.overdue).length;
  const upcoming = (meetings.data ?? [])
    .filter((m) => meetingState(m) !== 'ended')
    .sort((a, b) => (meetingState(a) === 'live' ? -1 : meetingState(b) === 'live' ? 1 : (a.startsAt ?? '').localeCompare(b.startsAt ?? '')))
    .slice(0, 4);
  const unread = (chats.data ?? []).filter((c) => c.unread > 0).slice(0, 5);
  const fresh = (notes.data?.items ?? []).filter((n) => !n.read).slice(0, 5);

  return (
    <div className="h-full overflow-y-auto">
      {!sidebarOpen && (
        <div className="px-3 pt-2">
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        </div>
      )}
      <div className="mx-auto max-w-[1040px] px-5 py-10 sm:px-10">
        <h1 className="text-3xl font-bold tracking-tight">
          {greeting()}, {user.name.split(' ')[0]}
        </h1>
        <p className="mt-1.5 text-muted">Here's what's happening in {workspace.name}.</p>
        <OnlineNow />

        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
          {!guest && (
            <Panel icon={<ListChecks size={16} />} title="Today" to={`${base}/today`} linkLabel="Open Today">
              {tasks.isPending ? (
                <Spinner />
              ) : open.length === 0 ? (
                <Empty>Nothing left for today.</Empty>
              ) : (
                <>
                  {overdue > 0 && <p className="mb-2 text-xs font-medium text-red-500">{`${overdue} overdue`}</p>}
                  <ul className="space-y-1">
                    {open.slice(0, 6).map((t) => (
                      <li key={t.key}>
                        <button onClick={() => navigate(t.pageId ? `${base}/p/${t.pageId}` : `${base}/today`)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-sm hover:bg-hover">
                          <span className={t.overdue ? 'size-2 shrink-0 rounded-full bg-red-500' : 'size-2 shrink-0 rounded-full bg-accent'} />
                          <span className="min-w-0 flex-1 truncate" data-no-translate>
                            {t.title}
                          </span>
                          {t.time && <span className="text-xs text-faint">{t.time}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {open.length > 6 && <p className="mt-1 ps-1.5 text-xs text-faint">{`+${open.length - 6} more`}</p>}
                </>
              )}
            </Panel>
          )}

          {!guest && (
            <Panel icon={<Video size={16} />} title="Meetings" to={`${base}/meetings`} linkLabel="All meetings">
              {upcoming.length === 0 ? (
                <Empty>No meetings coming up.</Empty>
              ) : (
                <ul className="space-y-1">
                  {upcoming.map((m) => {
                    const live = meetingState(m) === 'live';
                    return (
                      <li key={m.code}>
                        <button onClick={() => navigate(`${base}/meet/${m.code}`)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-hover">
                          <span className="min-w-0 flex-1 truncate font-medium" data-no-translate>
                            {m.title}
                          </span>
                          {live ? <span className="rounded-md bg-green-600 px-2 py-0.5 text-xs font-medium text-white">Join</span> : <span className="text-xs text-faint">{m.startsAt ? at(m.startsAt) : ''}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          )}

          {!guest && (
            <Panel icon={<MessagesSquare size={16} />} title="Unread chats" to={`${base}/chat`} linkLabel="Open Chat">
              {unread.length === 0 ? (
                <Empty>You're all caught up.</Empty>
              ) : (
                <ul className="space-y-1">
                  {unread.map((c) => (
                    <li key={c.id}>
                      <button onClick={() => navigate(`${base}/chat/${c.id}`)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-hover">
                        <span className="min-w-0 flex-1 truncate font-medium" data-no-translate>
                          {c.name}
                        </span>
                        <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">{c.unread}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          <Panel icon={<Bell size={16} />} title="What's new" to={base} linkLabel="">
            {fresh.length === 0 ? (
              <Empty>No new notifications.</Empty>
            ) : (
              <ul className="space-y-1">
                {fresh.map((n) => (
                  <li key={n.key}>
                    <button onClick={() => n.link && navigate(n.link)} disabled={!n.link} className="w-full rounded-md px-1.5 py-1 text-start text-sm hover:bg-hover disabled:cursor-default">
                      <span className="block truncate font-medium" data-no-translate>
                        {n.title}
                      </span>
                      {n.body && (
                        <span className="block truncate text-xs text-muted" data-no-translate>
                          {n.body}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <h2 className="mt-10 mb-3 text-sm font-medium text-muted">Recently edited</h2>
        {recent.data && recent.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
            Nothing here yet — create your first page to get started.
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recent.data?.slice(0, 6).map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/w/${workspace.id}/p/${p.id}`)}
              className="group overflow-hidden rounded-xl border border-line bg-surface text-start transition-shadow hover:shadow-pop"
            >
              <div className="h-14 bg-sidebar" style={{ background: coverStyle(p.cover) }} />
              <div className="px-4 pt-0 pb-3.5">
                <div className="-mt-5 mb-2 flex size-10 items-center justify-center rounded-lg bg-surface text-2xl shadow-sm">
                  <PageIcon page={p} size={22} />
                </div>
                <div className="truncate font-medium">{pageTitle(p)}</div>
                <div className="mt-1 truncate text-xs text-faint">
                  {p.updatedByName ? `${p.updatedByName} · ` : ''}
                  {timeAgo(p.updatedAt)}
                </div>
              </div>
            </button>
          ))}
        </div>

        {!guest && (
          <>
            <h2 className="mt-10 mb-3 text-sm font-medium text-muted">Create</h2>
            <div className="flex flex-wrap gap-2">
              {canCreatePages &&
                PAGE_TYPES.map((t) => (
                  <QuickAction key={t.type} icon={<PageTypeIcon type={t.type} size={15} className="" />} label={`New ${t.label.toLowerCase()}`} onClick={() => newPage({ type: t.type })} />
                ))}
              {canCreatePages && <QuickAction icon={<Download size={15} />} label="Import" onClick={openImport} />}
              <QuickAction icon={<UserPlus size={15} />} label="Invite people" onClick={() => openSettings('members')} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QuickAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm transition-colors hover:bg-hover">
      <span className="text-accent">{icon}</span>
      {label}
    </button>
  );
}

interface OnlinePerson {
  id: string;
  name: string;
  color: string;
  page: { id: string; title: string; icon: string; type: string } | null;
}

/** People with a page of this workspace open right now, and where. */
function OnlineNow() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const online = useQuery({
    queryKey: ['online', workspace.id],
    queryFn: () => api<{ people: OnlinePerson[] }>(`/api/workspaces/${workspace.id}/online`),
    refetchInterval: 20_000,
    enabled: workspace.role !== 'guest',
  });
  const people = online.data?.people ?? [];
  if (!people.length) return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <span className="size-2 rounded-full bg-green-500" /> Online now
      </span>
      {people.map((p) => (
        <button
          key={p.id}
          disabled={!p.page}
          onClick={() => p.page && navigate(`/w/${workspace.id}/p/${p.page.id}`)}
          className="flex items-center gap-1.5 rounded-full border border-line py-0.5 pe-2.5 ps-0.5 text-xs hover:bg-hover disabled:cursor-default"
          title={p.page ? `${p.name} is on “${pageTitle(p.page as never)}”` : p.name}
        >
          <Avatar name={p.name} color={p.color} size={20} />
          <span className="font-medium">{p.name.split(' ')[0]}</span>
          {p.page && (
            <span className="max-w-[160px] truncate text-muted">
              in {p.page.icon ? `${p.page.icon} ` : ''}
              {pageTitle(p.page as never)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
