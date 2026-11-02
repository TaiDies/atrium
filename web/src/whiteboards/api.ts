import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Location, PlaceTarget } from '../lib/placement';
import { queryClient } from '../lib/queries';

export interface Whiteboard {
  id: string;
  workspaceId: string;
  title: string;
  elementCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  locations: Location[];
}

export interface BoardFile {
  id: string;
  mimeType: string;
  url: string;
  created: number;
}

const listKey = (workspaceId: string) => ['whiteboards', workspaceId] as const;

export function useWhiteboards(workspaceId: string) {
  return useQuery({
    queryKey: listKey(workspaceId),
    queryFn: () => api<{ whiteboards: Whiteboard[] }>(`/api/workspaces/${workspaceId}/whiteboards`).then((r) => r.whiteboards),
  });
}

export function useWhiteboard(boardId: string | null) {
  return useQuery({
    queryKey: ['whiteboard', boardId],
    queryFn: () => api<{ whiteboard: Whiteboard }>(`/api/whiteboards/${boardId}`).then((r) => r.whiteboard),
    enabled: !!boardId,
    retry: false,
  });
}

export function useBoardPreview(boardId: string, enabled = true) {
  return useQuery({
    queryKey: ['whiteboard-preview', boardId],
    queryFn: () => api<{ elements: unknown[]; files: Record<string, BoardFile> }>(`/api/whiteboards/${boardId}/preview`),
    enabled,
    staleTime: 20_000,
  });
}

export function refreshWhiteboards(workspaceId: string, boardId?: string) {
  queryClient.invalidateQueries({ queryKey: listKey(workspaceId) });
  if (boardId) {
    queryClient.invalidateQueries({ queryKey: ['whiteboard', boardId] });
    queryClient.invalidateQueries({ queryKey: ['whiteboard-preview', boardId] });
  }
}

export async function createWhiteboard(workspaceId: string, title?: string, place?: PlaceTarget) {
  const { whiteboard } = await api<{ whiteboard: Whiteboard }>(`/api/workspaces/${workspaceId}/whiteboards`, { method: 'POST', body: { title, place } });
  refreshWhiteboards(workspaceId);
  return whiteboard;
}

export async function renameWhiteboard(workspaceId: string, boardId: string, title: string) {
  await api(`/api/whiteboards/${boardId}`, { method: 'PATCH', body: { title } });
  refreshWhiteboards(workspaceId, boardId);
}

export async function deleteWhiteboard(workspaceId: string, boardId: string) {
  await api(`/api/whiteboards/${boardId}`, { method: 'DELETE' });
  refreshWhiteboards(workspaceId, boardId);
}

export async function placeWhiteboard(workspaceId: string, boardId: string, target: PlaceTarget | null, keepExisting = false) {
  const r = await api<{ locations: Location[] }>(`/api/whiteboards/${boardId}/place`, { method: 'POST', body: { target, keepExisting } });
  refreshWhiteboards(workspaceId, boardId);
  return r.locations;
}
