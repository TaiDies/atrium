import { type FormEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, FullScreenSpinner, Input, toastError } from '../components/ui';
import { api, type PageType, type Workspace } from '../lib/api';
import { createPage, keys, queryClient, useMe, usePages, useWorkspaces, useMembers } from '../lib/queries';
import { setDirectory } from '../lib/directory';
import { getLocal, LAST_WORKSPACE_KEY, setLocal } from '../lib/storage';
import { AppContext, type AppContextValue, type SettingsTab } from './context';
import { ImportDialog } from './ImportDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import { isInside } from './PageExtras';
import { downloadForOffline } from '../lib/collab';
import { startLive } from '../lib/live';
import { syncAccountPrefs } from '../lib/accountPrefs';
import { startAppNotifications } from '../lib/appNotify';
import { CallBar, CallProvider } from '../meetings/CallContext';
import { offlinePages } from '../lib/offline';
import { TemplatesDialog } from '../templates/TemplatesDialog';
import { SearchDialog } from './SearchDialog';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar } from './Sidebar';
import { TrashDialog } from './TrashDialog';
import { PageAssistant } from '../ai/PageAssistant';
import { PhoneNav } from './PhoneChrome';

const FileViewerPage = lazy(() => import('../pages/FileViewerPage').then((m) => ({ default: m.FileViewerPage })));

/**
 * Right-clicking an item that has its own menu (a file, a whiteboard, a board column…) opens that
 * menu instead of the browser's. Items mark this with data-menu-scope and their menu button with
 * data-menu-button. Text fields keep the browser's menu (spelling, paste).
 */
function RightClickMenus() {
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const scope = target?.closest?.('[data-menu-scope]');
      if (!scope || target!.closest('input, textarea')) return;
      const button = scope.querySelector<HTMLElement>('[data-menu-button]');
      if (!button) return;
      e.preventDefault();
      button.click();
    };
    window.addEventListener('contextmenu', onContext);
    return () => window.removeEventListener('contextmenu', onContext);
  }, []);

  return null;
}

/** A file opened on top of the page (`?file=`): the page stays as it was underneath. */
function FileOverlay() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const fileId = search.get('file');
  // Escape closes the file (and not a card or dialog underneath it).
  useEffect(() => {
    if (!fileId) return;
    // Menus and pickers (like a card's file list) close when a file opens, so none stays on top of it.
    // (Dialogs leave Escape to an open menu, so a card underneath stays open.)
    if (document.querySelector('[data-af-popover]')) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[data-af-popover], [role="dialog"] [role="dialog"]')) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fileId]);
  const closeRef = useRef(() => {});
  if (!fileId) return null;
  const close = () => {
    // Opened from the page: go back to it; opened from a link: just drop the file from the address.
    if ((window.history.state?.idx ?? 0) > 0) return navigate(-1);
    const next = new URLSearchParams(search);
    next.delete('file');
    next.delete('fname');
    navigate({ pathname: location.pathname, search: next.size ? `?${next}` : '' }, { replace: true });
  };
  closeRef.current = close;
  // In <body> on the dialogs' layer: opened after a card, it covers the card; dialogs it opens cover it.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-sidebar">
      <Suspense fallback={<FullScreenSpinner />}>
        <FileViewerPage key={fileId} overlay={{ fileId, name: search.get('fname'), onClose: close }} />
      </Suspense>
    </div>,
    document.body,
  );
}

export function AppLayout() {
  const params = useParams();
  const { workspaceId } = params;
  const navigate = useNavigate();
  const user = useMe().data!;
  const workspaces = useWorkspaces();
  const pages = usePages(workspaceId);
  const members = useMembers(workspaceId ?? '', !!workspaceId);
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);

  // The live channel: chat messages, meeting invitations and calls.
  useEffect(() => startLive(), []);
  // Appearance and language follow the account across devices.
  useEffect(() => void syncAccountPrefs(), [user.id]);
  // System notifications (Windows, Android and browsers), as set in Settings → Notifications.
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  useEffect(() => startAppNotifications({ userId: user.id, workspaceId: () => workspaceRef.current, navigate: (link) => navigate(link) }), [user.id, navigate]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    if (!workspace) return;
    const refresh = () => {
      const kept = offlinePages(user.id);
      const all = pages.data ?? [];
      const ids = all.filter((p) => kept.includes(p.id) || kept.some((k) => isInside(all, p.id, k))).map((p) => p.id);
      if (ids.length) void downloadForOffline(ids, user);
    };
    const first = setTimeout(refresh, 8000);
    const timer = setInterval(refresh, 15 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [workspace?.id, user.id, !!pages.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => getLocal('af-sidebar-open', window.innerWidth >= 768));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!workspace) return;
    setLocal(LAST_WORKSPACE_KEY, workspace.id);
    setExpanded(new Set(getLocal<string[]>(`af-expanded-${workspace.id}`, [])));
  }, [workspace?.id]);

  const updateExpanded = useCallback(
    (fn: (prev: Set<string>) => Set<string>) => {
      setExpanded((prev) => {
        const next = fn(prev);
        if (workspaceId) setLocal(`af-expanded-${workspaceId}`, [...next]);
        return next;
      });
    },
    [workspaceId],
  );

  useEffect(() => {
    if (workspace) setDirectory({ workspaceId: workspace.id, user, canCreatePages: workspace.role === 'owner', pages: pages.data ?? [], members: members.data?.members ?? [], navigate });
  }, [workspace, user, pages.data, members.data, navigate]);

  // On phones the sidebar covers the page, so close it once a page is chosen.
  const location = useLocation();
  useEffect(() => {
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, [location.pathname]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      setLocal('af-sidebar-open', !open);
      return !open;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key.toLowerCase() === 'k' || (e.key.toLowerCase() === 'p' && !e.shiftKey))) {
        // Ctrl+K inside a page with text selected adds a link (the editor handles it).
        if (e.key.toLowerCase() === 'k' && document.activeElement?.closest('.bn-editor') && !window.getSelection()?.isCollapsed) return;
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  const value = useMemo<AppContextValue | null>(() => {
    if (!workspace) return null;
    return {
      user,
      workspace,
      pages: pages.data ?? [],
      openSearch: () => setSearchOpen(true),
      openTrash: () => setTrashOpen(true),
      openImport: () => setImportOpen(true),
      openTemplates: () => setTemplatesOpen(true),
      openSettings: (tab = 'account') => setSettingsTab(tab),
      toggleSidebar,
      sidebarOpen,
      canCreatePages: workspace?.role === 'owner',
      expand: (id) => updateExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id))),
      newPage: async ({ parentId = null, type = 'document' }: { parentId?: string | null; type?: PageType } = {}) => {
        try {
          const page = await createPage(workspace.id, { parentId, type, insertIntoParent: !!parentId });
          if (parentId) updateExpanded((prev) => new Set(prev).add(parentId));
          if (window.innerWidth < 768) setSidebarOpen(false);
          navigate(`/w/${workspace.id}/p/${page.id}`, { state: { focusTitle: true } });
        } catch (err) {
          toastError(err);
        }
      },
    };
  }, [user, workspace, pages.data, sidebarOpen, toggleSidebar, updateExpanded, navigate]);

  if (workspaces.isPending) return <FullScreenSpinner />;
  if (!workspace || !value) {
    const first = workspaces.data?.[0];
    return first ? <Navigate to={`/w/${first.id}`} replace /> : <NoWorkspace />;
  }

  return (
    <AppContext.Provider value={value}>
      <CallProvider>
      <div className="flex h-full flex-col overflow-hidden">
      <CallBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {sidebarOpen && (
          <>
            <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={toggleSidebar} />
            <Sidebar expanded={expanded} setExpanded={updateExpanded} />
          </>
        )}
        <main id="app-main" className="relative min-w-0 flex-1 overflow-hidden bg-bg">
          {pages.isPending ? <FullScreenSpinner /> : <Outlet />}
        </main>
        <FileOverlay />
        <RightClickMenus />
        {/* (Not on the AI page itself, nor in chats and meetings, where it would cover the Send button.) */}
        {!/\/(ai|chat|meetings|meet)(\/|$)/.test(location.pathname) && <PageAssistant key={params.pageId ?? 'general'} pageId={params.pageId} />}
      </div>
      <PhoneNav />
      </div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <TrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <TemplatesDialog open={templatesOpen} onClose={() => setTemplatesOpen(false)} />
      <SettingsDialog tab={settingsTab} onTabChange={setSettingsTab} onClose={() => setSettingsTab(null)} />
      </CallProvider>
    </AppContext.Provider>
  );
}

/** Shown when the user isn't a member of any workspace (e.g. they left them all). */
export function NoWorkspace() {
  const navigate = useNavigate();
  const [name, setName] = useState('My Workspace');
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { workspace } = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: { name, icon: '🏠' } });
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      navigate(`/w/${workspace.id}`, { replace: true });
    } catch (err) {
      toastError(err);
      setLoading(false);
    }
  };
  return (
    <div className="flex h-full items-center justify-center bg-sidebar p-4">
      <form onSubmit={submit} className="shadow-pop w-full max-w-sm space-y-4 rounded-xl bg-surface p-6">
        <div>
          <h1 className="text-lg font-semibold">Create a workspace</h1>
          <p className="mt-1 text-sm text-muted">You're not a member of any workspace yet.</p>
        </div>
        <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <Button type="submit" variant="primary" className="w-full" loading={loading}>
          Create workspace
        </Button>
      </form>
    </div>
  );
}
