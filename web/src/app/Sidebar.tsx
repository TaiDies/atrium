import clsx from 'clsx';
import {
  ChevronDown,
  LayoutTemplate,
  ChevronsLeft,
  Download,
  Home,
  LogOut,
  Plus,
  Search,
  Settings,
  Trash2,
  UserPlus,
  CalendarDays,
  FolderOpen,
  PenTool,
  ListChecks,
  Sparkles,
  MessagesSquare,
  Network,
  Video,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { EmojiPicker } from '../components/EmojiPicker';
import { type Anchor, Avatar, Button, Dialog, IconButton, Input, Menu, MenuDivider, MenuItem, MenuLabel, toastError } from '../components/ui';
import { api, PAGE_TYPES, pageTitle, type Workspace } from '../lib/api';
import { keys, queryClient, useWorkspaces } from '../lib/queries';
import { useApp } from './context';
import { PageIcon, PageTypeIcon } from './PageIcon';
import { SidebarPageSections } from './Teamspaces';
import { NotificationBell } from '../notifications/Notifications';

const isMac = navigator.platform.toLowerCase().includes('mac');
export const MOD = isMac ? '⌘' : 'Ctrl+';

export function Sidebar({ expanded, setExpanded }: { expanded: Set<string>; setExpanded: (fn: (p: Set<string>) => Set<string>) => void }) {
  const { workspace, pages, openSearch, openTrash, openImport, openTemplates, openSettings, toggleSidebar, newPage, canCreatePages } = useApp();
  const navigate = useNavigate();
  const { pageId } = useParams();
  const path = useLocation().pathname;
  const section = /\/w\/[^/]+\/(files|calendar|whiteboards|today|ai|graph|chat|meetings|meet)/.exec(path)?.[1] ?? null;
  const [addMenu, setAddMenu] = useState<Anchor | null>(null);
  const favorites = pages.filter((p) => p.isFavorite && !p.archivedAt);

  return (
    <aside className="fixed inset-y-0 start-0 z-40 flex w-[260px] shrink-0 flex-col border-e border-line bg-sidebar md:static md:z-auto">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <WorkspaceSwitcher />
        <NotificationBell />
        <IconButton onClick={toggleSidebar} title={`Close sidebar (${MOD}\\)`}>
          <ChevronsLeft size={17} />
        </IconButton>
      </div>

      <nav className="px-1 pb-2">
        <ConnectionBadge />
        <NavItem icon={<Search size={16} />} label="Search" hint={`${MOD}K`} onClick={openSearch} />
        <NavItem icon={<Home size={16} />} label="Home" onClick={() => navigate(`/w/${workspace.id}`)} active={!pageId && !section} />
        <NavItem icon={<Network size={16} />} label="Graph" onClick={() => navigate(`/w/${workspace.id}/graph`)} active={section === 'graph'} />
        {workspace.role !== 'guest' && (
          <>
            <NavItem icon={<MessagesSquare size={16} />} label="Chat" onClick={() => navigate(`/w/${workspace.id}/chat`)} active={section === 'chat'} />
            <NavItem icon={<Video size={16} />} label="Meetings" onClick={() => navigate(`/w/${workspace.id}/meetings`)} active={section === 'meetings' || section === 'meet'} />
            <NavItem icon={<ListChecks size={16} />} label="Today" onClick={() => navigate(`/w/${workspace.id}/today`)} active={section === 'today'} />
            <NavItem icon={<CalendarDays size={16} />} label="Calendar" onClick={() => navigate(`/w/${workspace.id}/calendar`)} active={section === 'calendar'} />
            <NavItem icon={<FolderOpen size={16} />} label="Files" onClick={() => navigate(`/w/${workspace.id}/files`)} active={section === 'files'} />
            <NavItem icon={<PenTool size={16} />} label="Whiteboards" onClick={() => navigate(`/w/${workspace.id}/whiteboards`)} active={section === 'whiteboards'} />
            <NavItem icon={<Sparkles size={16} />} label="AI assistant" onClick={() => navigate(`/w/${workspace.id}/ai`)} active={section === 'ai'} />
          </>
        )}
        <NavItem icon={<Settings size={16} />} label="Settings & members" onClick={() => openSettings('members')} />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {favorites.length > 0 && (
          <Section title="Favorites">
            {favorites.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/w/${workspace.id}/p/${p.id}`)}
                className={clsx(
                  'mx-1 flex h-[30px] w-[calc(100%-8px)] items-center gap-1.5 rounded-md px-2 text-start text-sm',
                  pageId === p.id ? 'bg-active font-medium' : 'text-fg/85 hover:bg-hover',
                )}
              >
                <PageIcon page={p} />
                <span className="truncate">{pageTitle(p)}</span>
              </button>
            ))}
          </Section>
        )}

        <SidebarPageSections
          expanded={expanded}
          setExpanded={setExpanded}
          addPageButton={
            canCreatePages && (
              <IconButton className="size-6" title="Add a page" onClick={(e) => setAddMenu(e.currentTarget.getBoundingClientRect())}>
                <Plus size={15} />
              </IconButton>
            )
          }
        />
      </div>

      <div className="border-t border-line px-1 py-1.5">
        {workspace.role !== 'guest' && <NavItem icon={<LayoutTemplate size={16} />} label="Templates" onClick={openTemplates} />}
        {canCreatePages && <NavItem icon={<Download size={16} />} label="Import" onClick={openImport} />}
        <NavItem icon={<Trash2 size={16} />} label="Trash" onClick={openTrash} />
        {canCreatePages && <NavItem icon={<Plus size={16} />} label="New page" onClick={() => newPage()} />}
      </div>

      <Menu anchor={addMenu} onClose={() => setAddMenu(null)}>
        {PAGE_TYPES.map((t) => (
          <MenuItem key={t.type} icon={<PageTypeIcon type={t.type} size={15} />} label={t.label} onClick={() => newPage({ type: t.type })} />
        ))}
      </Menu>
    </aside>
  );
}

function NavItem({ icon, label, hint, onClick, active }: { icon: ReactNode; label: string; hint?: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-start text-sm',
        active ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      <span className="flex w-4 justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </button>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-2">
      <div className="group flex h-7 items-center px-3">
        <button onClick={() => setOpen(!open)} className="flex-1 text-start text-xs font-medium text-faint hover:text-muted">
          {title}
        </button>
        <div className="hover-reveal opacity-0 transition-opacity group-hover:opacity-100">{action}</div>
      </div>
      {open && children}
    </div>
  );
}

function WorkspaceSwitcher() {
  const { workspace, user, openSettings } = useApp();
  const workspaces = useWorkspaces();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [creating, setCreating] = useState(false);

  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    queryClient.clear();
    queryClient.setQueryData(keys.me, null);
    navigate('/login', { replace: true });
  };

  return (
    <>
      <button
        onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-start hover:bg-hover"
      >
        <WorkspaceIcon workspace={workspace} />
        <span className="truncate text-sm font-semibold">{workspace.name}</span>
        <ChevronDown size={14} className="shrink-0 text-faint" />
      </button>

      <Menu anchor={menu} onClose={() => setMenu(null)}>
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Avatar name={user.name} color={user.color} size={28} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted">{user.email}</div>
          </div>
        </div>
        <MenuDivider />
        <MenuLabel>Workspaces</MenuLabel>
        {workspaces.data?.map((w) => (
          <MenuItem
            key={w.id}
            icon={<WorkspaceIcon workspace={w} size={18} />}
            label={w.name}
            hint={`${w.memberCount} ${w.memberCount === 1 ? 'member' : 'members'}`}
            checked={w.id === workspace.id}
            onClick={() => navigate(`/w/${w.id}`)}
          />
        ))}
        <MenuItem icon={<Plus size={15} />} label="Create workspace" onClick={() => setCreating(true)} />
        <MenuDivider />
        <MenuItem icon={<UserPlus size={15} />} label="Invite members" onClick={() => openSettings('members')} />
        <MenuItem icon={<Settings size={15} />} label="Settings" onClick={() => openSettings('account')} />
        <MenuItem icon={<LogOut size={15} />} label="Sign out" onClick={signOut} />
      </Menu>

      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function WorkspaceIcon({ workspace, size = 22 }: { workspace: Pick<Workspace, 'name' | 'icon'>; size?: number }) {
  if (workspace.icon) {
    return (
      <span className="flex shrink-0 items-center justify-center rounded-md bg-active" style={{ width: size, height: size, fontSize: size * 0.62 }}>
        {workspace.icon}
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md bg-accent font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      {workspace.name.charAt(0).toUpperCase()}
    </span>
  );
}

function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🚀');
  const [picker, setPicker] = useState<Anchor | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { workspace } = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: { name, icon } });
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      onClose();
      setName('');
      navigate(`/w/${workspace.id}`);
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Create a workspace" width={420}>
      <form onSubmit={submit} className="space-y-4 px-5 pt-2 pb-5">
        <p className="text-sm text-muted">Workspaces keep pages and members separate. There's no limit on how many you create or who you invite.</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line text-lg hover:bg-hover"
          >
            {icon}
          </button>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." required autoFocus />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Create
          </Button>
        </div>
      </form>
      <EmojiPicker anchor={picker} onClose={() => setPicker(null)} onPick={setIcon} />
    </Dialog>
  );
}
