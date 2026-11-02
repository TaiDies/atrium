import { QueryClient, useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type Invite,
  type Member,
  type PageDetail,
  type PageSummary,
  type PageType,
  type RecentPage,
  type TrashedPage,
  type User,
  type Workspace,
} from './api';
import { isOnline, OfflineError, sendOrQueue } from './offline';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Kept (and saved on the device) for a week, so lists show offline and right away on start-up.
      gcTime: 7 * 24 * 60 * 60 * 1000,
      // Without a connection, requests wait (keeping what's cached) instead of failing; see offline.ts.
      retry: (count, err) => (err instanceof OfflineError ? true : !(err instanceof ApiError && err.status < 500) && count < 2),
    },
  },
});

export const keys = {
  me: ['me'] as const,
  workspaces: ['workspaces'] as const,
  pages: (ws: string) => ['pages', ws] as const,
  page: (id: string) => ['page', id] as const,
  recent: (ws: string) => ['recent', ws] as const,
  trash: (ws: string) => ['trash', ws] as const,
  members: (ws: string) => ['members', ws] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/api/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    // Signed in: trust it until a request says otherwise. Signed out: check again on each load, since
    // signing in can happen elsewhere (another tab, the desktop app).
    staleTime: (q) => (q.state.data ? Infinity : 0),
  });
}

export function useWorkspaces() {
  return useQuery({
    queryKey: keys.workspaces,
    queryFn: async () => (await api<{ workspaces: Workspace[] }>('/api/workspaces')).workspaces,
  });
}

export function usePages(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.pages(workspaceId ?? ''),
    queryFn: async () => (await api<{ pages: PageSummary[] }>(`/api/workspaces/${workspaceId}/pages`)).pages,
    enabled: !!workspaceId,
    refetchInterval: 15_000,
  });
}

export function usePage(pageId: string | undefined) {
  return useQuery({
    queryKey: keys.page(pageId ?? ''),
    queryFn: async () => (await api<{ page: PageDetail }>(`/api/pages/${pageId}`)).page,
    enabled: !!pageId,
    // Until the server answers (e.g. a page made offline), use what the page tree knows about it.
    placeholderData: () => {
      for (const [, pages] of queryClient.getQueriesData<PageSummary[]>({ queryKey: ['pages'] })) {
        const p = pages?.find((x) => x.id === pageId);
        if (p) return { ...p, deletedAt: null, createdByName: null, updatedByName: null };
      }
      return undefined;
    },
  });
}

export function useRecent(workspaceId: string) {
  return useQuery({
    queryKey: keys.recent(workspaceId),
    queryFn: async () => (await api<{ pages: RecentPage[] }>(`/api/workspaces/${workspaceId}/recent`)).pages,
  });
}

export function useTrash(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.trash(workspaceId),
    queryFn: async () => (await api<{ pages: TrashedPage[] }>(`/api/workspaces/${workspaceId}/trash`)).pages,
    enabled,
  });
}

export function useMembers(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: keys.members(workspaceId),
    queryFn: () => api<{ members: Member[]; invites: Invite[] }>(`/api/workspaces/${workspaceId}/members`),
    enabled,
  });
}

/** Refresh everything that shows page titles, icons or tree structure. */
export function invalidatePages(workspaceId: string, pageId?: string) {
  queryClient.invalidateQueries({ queryKey: keys.pages(workspaceId) });
  queryClient.invalidateQueries({ queryKey: keys.recent(workspaceId) });
  queryClient.invalidateQueries({ queryKey: keys.trash(workspaceId) });
  if (pageId) queryClient.invalidateQueries({ queryKey: keys.page(pageId) });
}

/** Optimistically patch a page in the cached tree and detail views. */
export function patchPageCache(workspaceId: string, pageId: string, patch: Partial<PageSummary>) {
  queryClient.setQueryData<PageSummary[]>(keys.pages(workspaceId), (pages) =>
    pages?.map((p) => (p.id === pageId ? { ...p, ...patch } : p)),
  );
  queryClient.setQueryData<PageDetail>(keys.page(pageId), (page) => (page ? { ...page, ...patch } : page));
}

/**
 * Makes a page. The id is chosen here, so a document made while offline can be opened and written in
 * straight away; it's created on the server (with the same id) once the connection is back. Databases
 * need the server to set them up, so they can only be made online.
 */
export async function createPage(
  workspaceId: string,
  input: { parentId?: string | null; type?: PageType; title?: string; insertIntoParent?: boolean },
) {
  const id = crypto.randomUUID();
  const type = input.type ?? 'document';
  if (type !== 'document' && !isOnline()) throw new OfflineError();
  const reply = await sendOrQueue<{ page: PageSummary }>('POST', `/api/workspaces/${workspaceId}/pages`, { ...input, id }, `Create “${input.title || 'Untitled'}”`);
  const siblings = (queryClient.getQueryData<PageSummary[]>(keys.pages(workspaceId)) ?? []).filter((p) => p.parentId === (input.parentId ?? null));
  const page: PageSummary = reply?.page ?? {
    id,
    workspaceId,
    parentId: input.parentId ?? null,
    type,
    title: input.title ?? '',
    icon: '',
    cover: null,
    position: Math.max(0, ...siblings.map((p) => p.position + 1)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isFavorite: false,
    access: 'manage',
  };
  queryClient.setQueryData<PageSummary[]>(keys.pages(workspaceId), (pages) => (pages ? [...pages.filter((p) => p.id !== page.id), page] : [page]));
  if (reply) invalidatePages(workspaceId);
  return page;
}

export async function updatePage(workspaceId: string, pageId: string, patch: Partial<Pick<PageSummary, 'title' | 'icon' | 'cover' | 'parentId' | 'position'>>) {
  patchPageCache(workspaceId, pageId, patch);
  await sendOrQueue('PATCH', `/api/pages/${pageId}`, patch, patch.title !== undefined ? `Rename to “${patch.title}”` : 'Change a page');
}

export async function setFavorite(workspaceId: string, pageId: string, favorite: boolean) {
  patchPageCache(workspaceId, pageId, { isFavorite: favorite });
  await sendOrQueue(favorite ? 'PUT' : 'DELETE', `/api/pages/${pageId}/favorite`, undefined, favorite ? 'Add to favourites' : 'Remove from favourites').catch(() => {});
}
