import { trackedFetch } from './offline';

export const APP_NAME = 'Atrium';

export interface User {
  id: string;
  email: string;
  name: string;
  color: string;
}

export type Role = 'owner' | 'member' | 'guest';
export type PageType = 'document' | 'grid' | 'board' | 'calendar' | 'timeline' | 'chart' | 'form' | 'list' | 'gallery' | 'feed';

export const PAGE_TYPES: { type: PageType; label: string }[] = [
  { type: 'document', label: 'Document' },
  { type: 'grid', label: 'Grid' },
  { type: 'board', label: 'Board' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'timeline', label: 'Timeline' },
  { type: 'chart', label: 'Chart' },
  { type: 'form', label: 'Form builder' },
  { type: 'list', label: 'List' },
  { type: 'gallery', label: 'Gallery' },
  { type: 'feed', label: 'Feed' },
];

/** What the current user may do with a page. */
export type Access = 'view' | 'edit' | 'manage';
export const canEdit = (access: Access | undefined) => access === 'edit' || access === 'manage';

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  role: Role;
  memberCount: number;
}

export interface PageSummary {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: PageType;
  title: string;
  icon: string;
  cover: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  isFavorite: boolean;
  access: Access;
  /** Has its own sharing settings. */
  restricted?: boolean;
  /** Locked against accidental edits. */
  locked?: boolean;
  /** Archived: out of the sidebar, still searchable and linkable. */
  archivedAt?: string | null;
  /** Verified (a trusted wiki page) until this date. */
  verifiedUntil?: string | null;
  layout?: { fullWidth?: boolean; smallText?: boolean };
  /** The teamspace a top-level page belongs to. */
  teamspaceId?: string | null;
}

export interface PageDetail extends PageSummary {
  deletedAt: string | null;
  createdByName: string | null;
  updatedByName: string | null;
  verifiedByName?: string | null;
}

export interface TrashedPage extends PageSummary {
  deletedAt: string;
}

export interface RecentPage extends PageSummary {
  updatedByName: string | null;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  color: string;
  role: Role;
  joinedAt: string;
}

export interface Invite {
  email: string;
  role: Role;
  createdAt: string;
}

export interface SearchResult {
  id: string;
  title: string;
  icon: string;
  type: PageType;
  snippet: string;
}

export class ApiError extends Error {
  status: number;
  /** The rest of the server's error reply (e.g. `verify: true` when an email code is needed). */
  data: Record<string, unknown> | null;
  constructor(status: number, message: string, data: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  // Tracks whether the server can be reached (offline.ts); throws OfflineError when it can't.
  const res = await trackedFetch(path, {
    method: options.method ?? 'GET',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data && typeof data === 'object' ? data : null);
  return data as T;
}

export async function uploadFile(workspaceId: string, file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await trackedFetch(`/api/workspaces/${workspaceId}/files`, { method: 'POST', body: form, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'Upload failed');
  return data.url as string;
}

/** A URL that makes the browser save the file instead of showing it (works on phones too). */
export function downloadUrl(url: string) {
  if (!url.startsWith('/api/files/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}download=1`;
}

/** Where "Open in a new tab" goes: uploaded files open in the app's own viewer, so PDFs show on every
 * browser (Android Chrome and download managers would otherwise save them); other links open as-is. */
export function viewerUrl(url: string, name?: string) {
  const m = /^\/api\/files\/([0-9a-f-]{36})/i.exec(url);
  if (!m) return url;
  return `/file/${m[1]}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
}

/** Pages hidden from the sidebar because they (or a page above them) are archived. */
export function archivedIds(pages: { id: string; parentId: string | null; archivedAt?: string | null }[]): Set<string> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out = new Set<string>();
  for (const p of pages) {
    for (let cur: typeof p | undefined = p, depth = 0; cur && depth < 100; cur = cur.parentId ? byId.get(cur.parentId) : undefined, depth++) {
      if (cur.archivedAt) {
        out.add(p.id);
        break;
      }
    }
  }
  return out;
}

export function pageTitle(page: { title: string } | undefined | null) {
  return page?.title?.trim() || 'Untitled';
}
