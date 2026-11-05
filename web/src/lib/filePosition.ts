import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { api } from './api';
import { queryClient } from './queries';

// Where each person stopped in a file, saved on the server so it opens there again on any device:
// the page of a PDF (and how far down it), how far down a document, the slide, or the time in a video.

export type FilePosition =
  | { kind: 'page'; page: number; pages: number; offset: number }
  | { kind: 'scroll'; fraction: number }
  | { kind: 'slide'; slide: number; slides: number }
  | { kind: 'time'; seconds: number; duration: number };

export interface SavedPosition {
  position: FilePosition;
  updatedAt: string;
}

const clock = (s: number) => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/** "Page 12 of 40", "48% through", "Slide 3 of 10", "Stopped at 12:31" — or null at the very start. */
export function positionLabel(p: FilePosition | null | undefined): string | null {
  if (!p) return null;
  if (p.kind === 'page') return p.page <= 1 && p.offset < 0.05 ? null : `Page ${p.page} of ${p.pages}`;
  if (p.kind === 'slide') return p.slide <= 1 ? null : `Slide ${p.slide} of ${p.slides}`;
  if (p.kind === 'scroll') return p.fraction < 0.02 ? null : `${Math.round(p.fraction * 100)}% through`;
  return p.seconds < 5 ? null : `Stopped at ${clock(p.seconds)}`;
}

const fileIdOf = (url: string) => /\/api\/files\/([0-9a-f-]{36})/i.exec(url)?.[1] ?? null;

/** This person's place in the files behind these attachment URLs (for showing it on attachments). */
export function useFilePositions(urls: string[]) {
  const ids = useMemo(() => [...new Set(urls.map(fileIdOf).filter((x): x is string => !!x))].sort(), [urls]);
  return useQuery({
    queryKey: ['file-positions', ids.join(',')],
    // A plain object, not a Map: the query cache is saved on the device for offline use (as JSON), and a
    // Map would come back from it as an empty object.
    queryFn: async () => (await api<{ positions: Record<string, SavedPosition> }>(`/api/file-positions?ids=${ids.join(',')}`)).positions,
    enabled: ids.length > 0,
    staleTime: 30_000,
    select: (positions) => (url: string) => {
      const id = fileIdOf(url);
      return (id && positions && typeof positions === 'object' ? positions[id]?.position : null) ?? null;
    },
  });
}

function send(fileId: string, position: FilePosition, keepalive = false) {
  return fetch(`/api/files/${fileId}/position`, {
    method: 'PUT',
    credentials: 'include',
    keepalive,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ position }),
  }).catch(() => {});
}

/**
 * Saves the place in a file a moment after it stops changing, and right away when the viewer
 * closes or the app goes to the background.
 */
export function usePositionSaver(fileId: string | null) {
  const pending = useRef<FilePosition | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const last = useRef<string>('');
  const flushRef = useRef<((keepalive: boolean) => void) | null>(null);

  useEffect(() => {
    if (!fileId) return;
    const flush = (keepalive: boolean) => {
      clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (!p) return;
      const key = JSON.stringify(p);
      if (key === last.current) return;
      last.current = key;
      // The viewer opens from this (cached) info next time, so it starts at the new place.
      queryClient.setQueryData(['file-info', fileId], (old: object | undefined) => (old ? { ...old, position: { position: p, updatedAt: new Date().toISOString() } } : old));
      void send(fileId, p, keepalive).then(() => {
        queryClient.invalidateQueries({ queryKey: ['file-positions'] });
        queryClient.invalidateQueries({ queryKey: ['files'] });
      });
    };
    const hidden = () => document.visibilityState === 'hidden' && flush(true);
    const leave = () => flush(true);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    flushRef.current = flush;
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
      flush(true);
    };
  }, [fileId]);

  return useMemo(
    () => (position: FilePosition) => {
      pending.current = position;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flushRef.current?.(false), 1500);
    },
    [],
  );
}

/**
 * For a scrolling editor (documents, spreadsheets): goes back to how far down this person was, saves it
 * as they scroll, and keeps the middle of the screen in place when `zoom` changes.
 */
export function useScrollPlace(scroller: React.RefObject<HTMLElement | null>, fileId: string, saved: FilePosition | null | undefined, ready: boolean, zoom: unknown) {
  const savePlace = usePositionSaver(fileId);
  const restored = useRef(saved?.kind !== 'scroll');
  const center = useRef(0.5);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !ready || restored.current || saved?.kind !== 'scroll') return;
    let touched = false;
    const touch = () => (touched = true);
    const apply = () => {
      if (!touched) el.scrollTop = saved.fraction * (el.scrollHeight - el.clientHeight);
    };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    for (const t of events) el.addEventListener(t, touch, { passive: true });
    // Content (images, fonts) keeps settling for a moment after it's loaded.
    const timers = [0, 200, 600, 1200].map((ms) => setTimeout(apply, ms));
    const done = setTimeout(() => (restored.current = true), 1300);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(done);
      for (const t of events) el.removeEventListener(t, touch);
    };
  }, [scroller, ready, saved]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !ready) return;
    const onScroll = () => {
      center.current = el.scrollHeight ? (el.scrollTop + el.clientHeight / 2) / el.scrollHeight : 0.5;
      if (!restored.current) return;
      const room = el.scrollHeight - el.clientHeight;
      if (room > 0) savePlace({ kind: 'scroll', fraction: Math.round((el.scrollTop / room) * 1000) / 1000 });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller, ready, savePlace]);

  // Zooming keeps what was in the middle of the screen in the middle.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = scroller.current;
    if (el) el.scrollTop = center.current * el.scrollHeight - el.clientHeight / 2;
  }, [zoom, scroller]);
}
