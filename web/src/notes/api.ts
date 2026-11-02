import { useQuery } from '@tanstack/react-query';
import { api, type PageType } from '../lib/api';
import { queryClient } from '../lib/queries';
import type { InkItem } from './ink';

export type { Location as FileLocation } from '../lib/placement';
import type { Location as FileLocation, PlaceTarget } from '../lib/placement';

export interface WorkspaceFile {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
  isNote: boolean;
  strokes: number;
  createdAt: string;
  updatedAt: string;
  uploadedBy: string | null;
  locations: FileLocation[];
}

export { useOutline } from '../lib/placement';
export type { BlockPosition, Outline, OutlineBlock } from '../lib/placement';

export const filesKey = (workspaceId: string) => ['files', workspaceId] as const;

export function useWorkspaceFiles(workspaceId: string) {
  return useQuery({
    queryKey: filesKey(workspaceId),
    queryFn: () => api<{ files: WorkspaceFile[] }>(`/api/workspaces/${workspaceId}/files`).then((r) => r.files),
  });
}

export function refreshFiles(workspaceId: string) {
  return queryClient.invalidateQueries({ queryKey: filesKey(workspaceId) });
}

export function usePreview(fileId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['file-preview', fileId],
    queryFn: () => api<{ strokes: InkItem[]; extraPages: number }>(`/api/files/${fileId}/preview`),
    enabled,
    staleTime: 30_000,
  });
}

export const newNote = (workspaceId: string, name?: string) =>
  api<{ file: WorkspaceFile }>(`/api/workspaces/${workspaceId}/notes`, { method: 'POST', body: { name } }).then((r) => r.file);

export const renameFile = (fileId: string, name: string) => api(`/api/files/${fileId}`, { method: 'PATCH', body: { name } });

export const deleteFile = (fileId: string) => api(`/api/files/${fileId}`, { method: 'DELETE' });

export const moveFile = (fileId: string, target: PlaceTarget | null, keepExisting = false) => api<{ locations: FileLocation[] }>(`/api/files/${fileId}/move`, { method: 'POST', body: { target, keepExisting } });

export type OfficeKind = 'document' | 'spreadsheet' | 'presentation';
export type FileKind = 'note' | 'pdf' | OfficeKind | 'image' | 'video' | 'audio' | 'other';

const DOCUMENT = /\.(docx|doc|docm|dotx|dot|odt|ott|fodt|rtf|wpd|txt|md|markdown)$/i;
const SPREADSHEET = /\.(xlsx|xls|xlsm|xlsb|xltx|xlt|ods|ots|fods|csv|tsv|numbers)$/i;
const PRESENTATION = /\.(pptx|ppt|pptm|ppsx|pps|potx|pot|odp|otp|fodp|key)$/i;

/** Which editor or viewer a file opens in. */
export function kindOf(f: Pick<WorkspaceFile, 'mimeType' | 'name' | 'isNote'>): FileKind {
  if (f.isNote) return 'note';
  if (f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name)) return 'pdf';
  if (DOCUMENT.test(f.name) || /wordprocessingml|msword|opendocument\.text|application\/rtf/.test(f.mimeType)) return 'document';
  if (SPREADSHEET.test(f.name) || /spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/.test(f.mimeType)) return 'spreadsheet';
  if (PRESENTATION.test(f.name) || /presentationml|ms-powerpoint|opendocument\.presentation/.test(f.mimeType)) return 'presentation';
  if (f.mimeType.startsWith('image/')) return 'image';
  if (f.mimeType.startsWith('video/')) return 'video';
  if (f.mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}

export const isOffice = (k: FileKind): k is OfficeKind => k === 'document' || k === 'spreadsheet' || k === 'presentation';

/** A new, empty document, spreadsheet or presentation (its editor fills it in). */
export const newOfficeFile = (workspaceId: string, kind: OfficeKind, name?: string) =>
  api<{ file: { id: string; url: string; name: string } }>(`/api/workspaces/${workspaceId}/office`, { method: 'POST', body: { kind, name } }).then((r) => r.file);
