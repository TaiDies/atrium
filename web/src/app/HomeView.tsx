import { useQuery } from '@tanstack/react-query';
import { Download, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Avatar, IconButton } from '../components/ui';
import { api, PAGE_TYPES, pageTitle } from '../lib/api';
import { coverStyle } from '../lib/covers';
import { useRecent } from '../lib/queries';
import { greeting, timeAgo } from '../lib/time';
import { useApp } from './context';
import { PageIcon, PageTypeIcon } from './PageIcon';
import { SidebarIcon } from '../notifications/Notifications';

export function HomeView() {
  const { user, workspace, newPage, openImport, openSettings, sidebarOpen, toggleSidebar, canCreatePages } = useApp();
  const recent = useRecent(workspace.id);
  const navigate = useNavigate();

  return (
    <div className="h-full overflow-y-auto">
      {!sidebarOpen && (
        <div className="px-3 pt-2">
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        </div>
      )}
      <div className="mx-auto max-w-[960px] px-6 py-14 sm:px-10">
        <h1 className="text-3xl font-bold tracking-tight">
          {greeting()}, {user.name.split(' ')[0]}
        </h1>
        <p className="mt-1.5 text-muted">Here's what's happening in {workspace.name}.</p>
        <OnlineNow />

        <div className={workspace.role === 'guest' ? 'hidden' : 'mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3'}>
          {canCreatePages &&
            PAGE_TYPES.map((t) => (
              <QuickAction key={t.type} icon={<PageTypeIcon type={t.type} size={18} className="" />} label={`New ${t.label.toLowerCase()}`} onClick={() => newPage({ type: t.type })} />
            ))}
          {canCreatePages && <QuickAction icon={<Download size={18} />} label="Import" onClick={openImport} />}
          <QuickAction icon={<UserPlus size={18} />} label="Invite people" onClick={() => openSettings('members')} />
        </div>

        <h2 className="mt-12 mb-3 text-sm font-medium text-muted">Recently edited</h2>
        {recent.data && recent.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
            Nothing here yet — create your first page to get started.
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recent.data?.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/w/${workspace.id}/p/${p.id}`)}
              className="group overflow-hidden rounded-xl border border-line bg-surface text-start transition-shadow hover:shadow-pop"
            >
              <div className="h-16 bg-sidebar" style={{ background: coverStyle(p.cover) }} />
              <div className="px-4 pt-0 pb-4">
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

        <div className="mt-12 rounded-xl bg-sidebar p-5 text-sm text-muted">
          <div className="mb-2 font-medium text-fg">Tips</div>
          <ul className="list-disc space-y-1 ps-5">
            <li>
              Type <kbd className="rounded bg-active px-1">/</kbd> in a document to add headings, to-dos, tables, images and more.
            </li>
            <li>Drag pages in the sidebar to reorder them, or drop one onto another to nest it.</li>
            <li>Share the page link with workspace members — everyone edits together in real time.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function QuickAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-3 rounded-xl border border-line bg-surface p-4 text-start text-sm font-medium transition-colors hover:bg-hover"
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
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
