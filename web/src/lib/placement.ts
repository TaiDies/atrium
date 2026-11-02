import { useQuery } from '@tanstack/react-query';
import { api, type PageType } from './api';

/** A page (or a card of a database page) that a file, event or whiteboard is on. */
export interface Location {
  pageId: string;
  rowId: string | null;
  pageTitle: string;
  pageType: PageType;
  rowTitle: string | null;
  access: 'view' | 'edit' | 'manage';
}

export type BlockPosition = 'start' | 'end' | 'after' | 'inside';

/** Where to put a block: on a page or card, at the top, the end, after a block or nested under it. */
export interface PlaceTarget {
  pageId: string;
  rowId?: string | null;
  anchorId?: string | null;
  position: BlockPosition;
}

export interface OutlineBlock {
  id: string;
  type: string;
  text: string;
  depth: number;
}

export interface Outline {
  type: PageType;
  blocks: OutlineBlock[];
  rows?: { id: string; title: string }[];
}

export function useOutline(pageId: string | null, rowId: string | null) {
  return useQuery({
    queryKey: ['outline', pageId, rowId],
    queryFn: () => api<Outline>(`/api/pages/${pageId}/outline${rowId ? `?rowId=${encodeURIComponent(rowId)}` : ''}`),
    enabled: !!pageId,
    staleTime: 0,
  });
}

export const locationLabel = (l: Location) => (l.rowTitle ? `${l.pageTitle} › ${l.rowTitle}` : l.pageTitle);

/** The address of a location, opening the card full-page when it's in a card, and jumping to a block if given. */
export function locationPath(workspaceId: string, l: { pageId: string; rowId: string | null }, blockId?: string) {
  const row = l.rowId ? `?row=${l.pageId}:${l.rowId}&full=1` : '';
  return `/w/${workspaceId}/p/${l.pageId}${row}${blockId ? `#block-${blockId}` : ''}`;
}
