import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { useIsRestoring } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { lazy, type ReactNode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { startTranslating } from './i18n';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppLayout, NoWorkspace } from './app/AppLayout';
import { HomeView } from './app/HomeView';
import { PageView } from './app/PageView';
import { ConfirmHost, FullScreenSpinner, Toaster } from './components/ui';
import { AppUpdate } from './app/AppUpdate';
import { AuthPage } from './pages/AuthPage';
import { PublicFormPage } from './pages/PublicFormPage';
import { PublicPage } from './pages/PublicPage';
import { api, ApiError, type User } from './lib/api';
import { invalidatePages, keys, queryClient, useMe, useWorkspaces } from './lib/queries';
import { loadNative, nativeInfo } from './lib/native';
import { installAndroidDownloads } from './lib/save';
import { cacheStorage, onApplied, setOfflineUser } from './lib/offline';
import { toast } from './components/ui';
import { ServerPicker } from './app/ServerPicker';
import { getLocal, LAST_WORKSPACE_KEY } from './lib/storage';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

// The interface language (and right-to-left layout for Arabic).
startTranslating();
import './styles.css';

const CalendarPage = lazy(() => import('./calendar/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const WhiteboardsPage = lazy(() => import('./whiteboards/WhiteboardsPage').then((m) => ({ default: m.WhiteboardsPage })));
const WhiteboardPage = lazy(() => import('./whiteboards/WhiteboardsPage').then((m) => ({ default: m.WhiteboardPage })));
const TodayPage = lazy(() => import('./tasks/TodayPage').then((m) => ({ default: m.TodayPage })));
const AiPage = lazy(() => import('./ai/AiPage').then((m) => ({ default: m.AiPage })));
const NotesPage = lazy(() => import('./notes/NotesPage').then((m) => ({ default: m.NotesPage })));
const GraphPage = lazy(() => import('./graph/GraphPage').then((m) => ({ default: m.GraphPage })));
const ChatPage = lazy(() => import('./chat/ChatPage').then((m) => ({ default: m.ChatPage })));
const MeetingsPage = lazy(() => import('./meetings/MeetingsPage').then((m) => ({ default: m.MeetingsPage })));
const MeetingRoom = lazy(() => import('./meetings/MeetingRoom').then((m) => ({ default: m.MeetingRoom })));
const FileViewerPage = lazy(() => import('./pages/FileViewerPage').then((m) => ({ default: m.FileViewerPage })));

function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullScreenSpinner />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <FullScreenSpinner />;
  if (me.data) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function OpenLastWorkspace() {
  const workspaces = useWorkspaces();
  if (workspaces.isPending) return <FullScreenSpinner />;
  const list = workspaces.data ?? [];
  const last = getLocal<string | null>(LAST_WORKSPACE_KEY, null);
  const target = list.find((w) => w.id === last) ?? list[0];
  if (!target) return <NoWorkspace />;
  return <Navigate to={`/w/${target.id}`} replace />;
}

/** Lists (pages, workspaces…) saved on this device, so they show offline and right away on start-up. */
const persister = createAsyncStoragePersister({ storage: cacheStorage, key: 'query-cache', throttleTime: 2000 });

/** Ties offline changes to the signed-in person, and reports any the server refused once they're sent. */
function OfflineSync() {
  const me = useMe();
  const restoring = useIsRestoring();
  useEffect(() => setOfflineUser(me.data?.id ?? null), [me.data?.id]);
  // The saved account can be out of date: someone signed out or into another account in a different
  // tab or app. Check on start-up and when the window comes back, and start afresh if it changed.
  useEffect(() => {
    if (restoring) return;
    const check = async () => {
      const saved = queryClient.getQueryData<User | null>(keys.me);
      if (!saved || !navigator.onLine) return;
      let current: User | null;
      try {
        current = (await api<{ user: User }>('/api/auth/me')).user;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) return;
        current = null;
      }
      if (current?.id === saved.id) return;
      queryClient.clear();
      await persister.removeClient();
      location.reload();
    };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [restoring]);
  useEffect(
    () =>
      onApplied((changes, failed) => {
        const workspaces = new Set(changes.map((c) => /\/workspaces\/([0-9a-f-]{36})/.exec(c.path)?.[1]).filter(Boolean) as string[]);
        queryClient.invalidateQueries();
        workspaces.forEach((w) => invalidatePages(w));
        if (failed.length) toast(`${failed.length} change${failed.length === 1 ? '' : 's'} made offline couldn’t be applied: ${failed.map((f) => `${f.change.label} (${f.error})`).join('; ')}`, 'error');
        else toast(`Synced ${changes.length} change${changes.length === 1 ? '' : 's'} made offline`);
      }),
    [],
  );
  return null;
}

async function start() {
  // In the Windows and Android apps, find out which server we're talking to first.
  await loadNative();
  const native = nativeInfo();
  installAndroidDownloads();
  const root = createRoot(document.getElementById('root')!);
  if (native && !native.server) {
    root.render(<ServerPicker />);
    return;
  }
  root.render(
  <PersistQueryClientProvider client={queryClient} persistOptions={{
      persister,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      buster: 'v1',
      // Keep everything that has data, even if its latest refresh failed (e.g. offline).
      // A signed-out state isn't kept (it would hide a sign-in made elsewhere).
      dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.data !== undefined && !(q.queryKey[0] === 'me' && q.state.data === null) },
    }}>
    <OfflineSync />
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<GuestOnly><AuthPage mode="login" /></GuestOnly>} />
        <Route path="/signup" element={<GuestOnly><AuthPage mode="signup" /></GuestOnly>} />
        <Route path="/form/:pageId/:viewId" element={<PublicFormPage />} />
        <Route path="/share/:token/:pageId?" element={<PublicPage />} />
        <Route path="/file/:fileId" element={<RequireAuth><Suspense fallback={<FullScreenSpinner />}><FileViewerPage /></Suspense></RequireAuth>} />
        <Route path="/" element={<RequireAuth><OpenLastWorkspace /></RequireAuth>} />
        <Route path="/w/:workspaceId" element={<RequireAuth><AppLayout /></RequireAuth>}>
          <Route index element={<HomeView />} />
          <Route path="p/:pageId" element={<PageView />} />
          <Route path="files" element={<Suspense fallback={<FullScreenSpinner />}><NotesPage /></Suspense>} />
          <Route path="notes" element={<Navigate to="../files" replace />} />
          <Route path="today" element={<Suspense fallback={<FullScreenSpinner />}><TodayPage /></Suspense>} />
          <Route path="ai" element={<Suspense fallback={<FullScreenSpinner />}><AiPage /></Suspense>} />
          <Route path="calendar" element={<Suspense fallback={<FullScreenSpinner />}><CalendarPage /></Suspense>} />
          <Route path="graph" element={<Suspense fallback={<FullScreenSpinner />}><GraphPage /></Suspense>} />
          <Route path="chat" element={<Suspense fallback={<FullScreenSpinner />}><ChatPage /></Suspense>} />
          <Route path="chat/:chatId" element={<Suspense fallback={<FullScreenSpinner />}><ChatPage /></Suspense>} />
          <Route path="meetings" element={<Suspense fallback={<FullScreenSpinner />}><MeetingsPage /></Suspense>} />
          <Route path="meet/:code" element={<Suspense fallback={<FullScreenSpinner />}><MeetingRoom /></Suspense>} />
          <Route path="whiteboards" element={<Suspense fallback={<FullScreenSpinner />}><WhiteboardsPage /></Suspense>} />
          <Route path="whiteboards/:boardId" element={<Suspense fallback={<FullScreenSpinner />}><WhiteboardPage /></Suspense>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    <Toaster />
    <ConfirmHost />
    <AppUpdate />
  </PersistQueryClientProvider>,
  );
}

void start();
