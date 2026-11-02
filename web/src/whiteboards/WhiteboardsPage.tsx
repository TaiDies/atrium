import clsx from 'clsx';
import { ArrowLeft, Grid3x3, Maximize2, Minimize2, Moon, MoreVertical, PenTool, Plus, Search, Settings2, Sun, SunMoon, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useApp } from '../app/context';
import { LocationList, PlacePicker } from '../components/Placement';
import { type Anchor, Avatar, Button, confirmDialog, Dialog, IconButton, Input, Menu, MenuDivider, MenuItem, toast, toastError } from '../components/ui';
import { type Peer, useCollab, usePeers } from '../lib/collab';
import { locationLabel } from '../lib/placement';
import { getLocal, setLocal } from '../lib/storage';
import { timeAgo } from '../lib/time';
import { createWhiteboard, deleteWhiteboard, placeWhiteboard, renameWhiteboard, useWhiteboard, useWhiteboards, type Whiteboard } from './api';
import { BoardThumbnail } from './BoardThumbnail';
import { WhiteboardEditor } from './WhiteboardEditor';
import { SidebarIcon } from '../notifications/Notifications';

type Sort = 'modified' | 'created' | 'name';
interface BoardView {
  grid: boolean;
  theme: 'app' | 'light' | 'dark';
}

/** The Whiteboards screen: every board in the workspace (including ones placed in pages), and a + for a new one. */
export function WhiteboardsPage() {
  const { workspace, sidebarOpen, toggleSidebar } = useApp();
  const boards = useWhiteboards(workspace.id);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>(() => getLocal<Sort>('af-boards-sort', 'modified'));
  const [settings, setSettings] = useState<Whiteboard | null>(null);

  useEffect(() => setLocal('af-boards-sort', sort), [sort]);
  useEffect(() => {
    document.title = `Whiteboards · ${workspace.name}`;
  }, [workspace.name]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = (boards.data ?? []).filter((b) => !needle || b.title.toLowerCase().includes(needle) || b.locations.some((l) => locationLabel(l).toLowerCase().includes(needle)));
    const by: Record<Sort, (a: Whiteboard, b: Whiteboard) => number> = {
      modified: (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
      created: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
      name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
    };
    return out.sort(by[sort]);
  }, [boards.data, q, sort]);

  const create = async () => {
    try {
      const board = await createWhiteboard(workspace.id);
      navigate(`/w/${workspace.id}/whiteboards/${board.id}`);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="relative h-full overflow-y-auto">
      {!sidebarOpen && (
        <div className="px-3 pt-2">
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        </div>
      )}
      <div className="mx-auto max-w-[1200px] px-4 pt-8 pb-32 sm:px-8 sm:pt-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Whiteboards</h1>
            <p className="mt-1 text-sm text-muted">{boards.data ? `${boards.data.length} ${boards.data.length === 1 ? 'board' : 'boards'}` : 'Loading…'}</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 sm:w-64 sm:flex-none">
              <Search size={15} className="shrink-0 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search whiteboards" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </label>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 shrink-0 rounded-lg border border-line bg-surface px-2 text-sm" aria-label="Sort by">
              <option value="modified">Date modified</option>
              <option value="created">Date made</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>

        {boards.data && list.length === 0 && (
          <div className="mt-8 flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-16 text-center">
            <PenTool size={36} className="text-faint" />
            <div className="mt-3 font-medium">{q ? 'Nothing matches' : 'No whiteboards yet'}</div>
            <p className="mt-1 max-w-sm text-sm text-muted">
              {q ? 'Try another search.' : 'An endless canvas everyone in the workspace can draw on together. Boards added to pages with “/whiteboard” show up here too.'}
            </p>
            {!q && (
              <button onClick={create} className="mt-5 flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:brightness-110">
                <Plus size={16} /> New whiteboard
              </button>
            )}
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((b) => (
            <BoardCard key={b.id} board={b} onOpen={() => navigate(`/w/${workspace.id}/whiteboards/${b.id}`)} onSettings={() => setSettings(b)} />
          ))}
        </div>
      </div>

      <button
        onClick={create}
        data-fab
        className="fixed end-5 bottom-5 z-20 flex size-14 items-center justify-center rounded-2xl bg-accent text-white shadow-pop transition-transform hover:scale-105 active:scale-95 sm:end-8 sm:bottom-8"
        title="New whiteboard"
        aria-label="New whiteboard"
      >
        <Plus size={26} />
      </button>

      {settings && <BoardSettingsDialog board={(boards.data ?? []).find((b) => b.id === settings.id) ?? settings} onClose={() => setSettings(null)} />}
    </div>
  );
}

function BoardCard({ board, onOpen, onSettings }: { board: Whiteboard; onOpen: () => void; onSettings: () => void }) {
  const { workspace, user } = useApp();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const canDelete = workspace.role === 'owner' || board.createdBy === user.id;
  const where = board.locations[0] ? locationLabel(board.locations[0]) + (board.locations.length > 1 ? ` +${board.locations.length - 1}` : '') : null;
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete “${board.title}”?`, message: board.locations.length ? 'It will also be removed from the pages it is on.' : 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await deleteWhiteboard(workspace.id, board.id);
      toast('Deleted');
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div data-menu-scope className="group min-w-0">
      <button onClick={onOpen} className="block aspect-[16/10] w-full overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition-shadow hover:shadow-pop">
        <BoardThumbnail boardId={board.id} empty={board.elementCount === 0} className="size-full" />
      </button>
      <div className="mt-2 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{board.title || 'Untitled whiteboard'}</div>
          <div className="truncate text-xs text-faint">
            {timeAgo(board.updatedAt)} · {board.elementCount} {board.elementCount === 1 ? 'item' : 'items'}
          </div>
          {where && <div className="mt-0.5 truncate text-xs text-muted">{where}</div>}
        </div>
        <button
          data-menu-button
          onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
          className="hover-reveal flex size-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg"
          aria-label="More"
        >
          <MoreVertical size={16} />
        </button>
      </div>
      <Menu anchor={menu} onClose={() => setMenu(null)} align="end">
        <MenuItem icon={<PenTool size={15} />} label="Open" onClick={onOpen} />
        <MenuItem icon={<Settings2 size={15} />} label="Settings & location" onClick={onSettings} />
        {canDelete && (
          <>
            <MenuDivider />
            <MenuItem icon={<Trash2 size={15} />} label="Delete" danger onClick={remove} />
          </>
        )}
      </Menu>
    </div>
  );
}

/** A whiteboard's name, where it's used, and putting it on a page or card. */
export function BoardSettingsDialog({ board, onClose }: { board: Whiteboard; onClose: () => void }) {
  const { workspace } = useApp();
  const [title, setTitle] = useState(board.title);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || title.trim() === board.title) return;
    try {
      await renameWhiteboard(workspace.id, board.id, title.trim());
      toast('Renamed');
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Dialog open onClose={onClose} width={560} top="6vh" maxHeight="88vh" className="flex flex-col">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-[15px] font-semibold">Whiteboard settings</h2>
        <IconButton onClick={onClose} aria-label="Close">
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <form onSubmit={save}>
          <label className="mb-1.5 block text-xs font-medium text-muted">Name</label>
          <div className="flex gap-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="min-w-0 flex-1" maxLength={300} />
            <Button type="submit" disabled={!title.trim() || title.trim() === board.title}>
              Save
            </Button>
          </div>
        </form>
        <LocationList
          locations={board.locations}
          empty="Not on any page yet. Pick a place below."
          onOpen={onClose}
          onRemoveAll={async () => {
            try {
              await placeWhiteboard(workspace.id, board.id, null);
              toast('Removed from pages');
            } catch (err) {
              toastError(err);
            }
          }}
        />
        <PlacePicker
          title={board.locations.length ? 'Move to' : 'Put on a page'}
          hasLocations={board.locations.length > 0}
          hideBlock={(b) => b.type === 'whiteboard'}
          onPlace={async (target, keep) => {
            try {
              await placeWhiteboard(workspace.id, board.id, target, keep);
              toast(keep ? 'Added to the page' : 'Moved');
            } catch (err) {
              toastError(err);
              throw err;
            }
          }}
        />
      </div>
    </Dialog>
  );
}

/** One whiteboard, filling the content area (or the whole screen), with who's here. */
export function WhiteboardPage() {
  const { boardId = '' } = useParams();
  const { workspace, user } = useApp();
  const navigate = useNavigate();
  const board = useWhiteboard(boardId);
  const { session, synced, denied } = useCollab(`board:${boardId}`, user, () => {});
  const peers = usePeers(session?.provider);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [settings, setSettings] = useState(false);
  const [full, setFull] = useState(false);
  // Grid and light/dark are remembered per board on this device.
  const [view, setView] = useState<BoardView>(() => getLocal<BoardView>(`af-board-view-${boardId}`, { grid: true, theme: 'app' }));
  useEffect(() => setLocal(`af-board-view-${boardId}`, view), [boardId, view]);
  const [themeMenu, setThemeMenu] = useState<Anchor | null>(null);

  useEffect(() => {
    if (board.data) {
      setTitle(board.data.title);
      document.title = board.data.title || 'Whiteboard';
    }
  }, [board.data]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.excalidraw .Island, [data-af-popover]') && setFull(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const rename = async () => {
    setEditing(false);
    if (!title.trim() || title.trim() === board.data?.title) return setTitle(board.data?.title ?? '');
    try {
      await renameWhiteboard(workspace.id, boardId, title.trim());
    } catch (err) {
      toastError(err);
    }
  };

  if (board.isError || denied) return <div className="p-10 text-center text-sm text-muted">This whiteboard doesn't exist or you don't have access to it.</div>;

  return (
    <div className={clsx('flex flex-col bg-bg', full ? 'fixed inset-0 z-50' : 'h-full')}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 sm:px-3">
        <IconButton onClick={() => navigate(`/w/${workspace.id}/whiteboards`)} title="All whiteboards">
          <ArrowLeft size={17} />
        </IconButton>
        <PenTool size={16} className="shrink-0 text-muted" />
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename();
              if (e.key === 'Escape') {
                setTitle(board.data?.title ?? '');
                setEditing(false);
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm font-medium outline-none focus:border-accent"
            maxLength={300}
          />
        ) : (
          <button onClick={() => setEditing(true)} className="min-w-0 flex-1 truncate rounded-md px-1 py-1 text-start text-sm font-medium hover:bg-hover" title="Rename">
            {board.data?.title || 'Untitled whiteboard'}
          </button>
        )}
        <PeerAvatars peers={peers} />
        <IconButton onClick={() => setView((v) => ({ ...v, grid: !v.grid }))} title={view.grid ? 'Hide grid' : 'Show grid'} aria-pressed={view.grid} className={view.grid ? 'text-accent' : ''}>
          <Grid3x3 size={17} />
        </IconButton>
        <IconButton onClick={(e) => setThemeMenu(e.currentTarget.getBoundingClientRect())} title="Light or dark board">
          {view.theme === 'dark' ? <Moon size={17} /> : view.theme === 'light' ? <Sun size={17} /> : <SunMoon size={17} />}
        </IconButton>
        <Menu anchor={themeMenu} onClose={() => setThemeMenu(null)} align="end">
          <MenuItem icon={<SunMoon size={15} />} label="Same as the app" onClick={() => setView((v) => ({ ...v, theme: 'app' }))} />
          <MenuItem icon={<Sun size={15} />} label="Light" onClick={() => setView((v) => ({ ...v, theme: 'light' }))} />
          <MenuItem icon={<Moon size={15} />} label="Dark" onClick={() => setView((v) => ({ ...v, theme: 'dark' }))} />
        </Menu>
        <IconButton onClick={() => setSettings(true)} title="Settings & location">
          <Settings2 size={17} />
        </IconButton>
        <IconButton onClick={() => setFull(!full)} title={full ? 'Exit full screen (Esc)' : 'Full screen'}>
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </IconButton>
      </header>
      <div className="relative min-h-0 flex-1">
        {session && synced ? (
          <WhiteboardEditor session={session} user={user} workspaceId={workspace.id} grid={view.grid} theme={view.theme === 'app' ? undefined : view.theme} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted">
            <span className="inline-block size-6 animate-spin rounded-full border-2 border-current border-e-transparent" />
          </div>
        )}
      </div>
      {settings && board.data && <BoardSettingsDialog board={board.data} onClose={() => setSettings(false)} />}
    </div>
  );
}

function PeerAvatars({ peers }: { peers: Peer[] }) {
  if (!peers.length) return null;
  return (
    <div className="flex -space-x-1.5" title={peers.map((p) => p.name).join(', ')}>
      {peers.slice(0, 5).map((p) => (
        <Avatar key={p.clientId} name={p.name} color={p.color} size={26} className="ring-2 ring-bg" />
      ))}
      {peers.length > 5 && <span className="flex size-[26px] items-center justify-center rounded-full bg-active text-[10px] ring-2 ring-bg">+{peers.length - 5}</span>}
    </div>
  );
}
