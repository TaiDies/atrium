import { publicOrigin } from '../lib/native';
import { isOnline, sendOrQueue } from '../lib/offline';
import { confirmWithChecks, toast, toastError } from '../components/ui';
import { api, type PageSummary } from '../lib/api';
import { invalidatePages, keys, queryClient } from '../lib/queries';

export function descendantIds(pages: PageSummary[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pages) {
      if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function ancestors(pages: PageSummary[], pageId: string): PageSummary[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const chain: PageSummary[] = [];
  let current = byId.get(pageId);
  while (current?.parentId && chain.length < 50) {
    current = byId.get(current.parentId);
    if (current) chain.unshift(current);
  }
  return chain;
}

/** Moves a page (and its sub-pages) to the trash. Returns the ids that were removed. */
export async function trashPage(workspaceId: string, pages: PageSummary[], pageId: string) {
  const removed = descendantIds(pages, pageId);
  // One question, so a page isn't deleted by a stray click — with what lives only in it (files, events
  // and tasks in no other page or card) offered to go too.
  const title = pages.find((p) => p.id === pageId)?.title.trim() || 'Untitled';
  const inside = removed.size - 1;
  const own = isOnline() ? await api<{ events: number; files: number }>(`/api/pages/${pageId}/own-content`).catch(() => ({ events: 0, files: 0 })) : { events: 0, files: 0 };
  const where = removed.size > 1 ? 'this page and the pages inside it' : 'this page';
  const checks: { key: 'files' | 'events'; label: string; help: string }[] = [];
  if (own.files > 0) checks.push({ key: 'files', label: `Also delete ${own.files} file${own.files === 1 ? '' : 's'} only in ${where}`, help: 'Deleted for good, even if you restore the page. Files also in another page or card are kept.' });
  if (own.events > 0)
    checks.push({ key: 'events', label: `Also delete ${own.events} task${own.events === 1 ? '' : 's'} and event${own.events === 1 ? '' : 's'} only in ${where}`, help: 'Deleted for good, even if you restore the page. Ones also in another page are kept.' });
  const ticked = await confirmWithChecks({
    title: `Move “${title}” to the trash?`,
    message: inside > 0 ? `The ${inside} page${inside === 1 ? '' : 's'} inside it will go too. You can restore them from the trash.` : 'You can restore it from the trash.',
    confirmLabel: 'Move to trash',
    danger: true,
    checks: checks.map(({ label, help }) => ({ label, help })),
  });
  if (!ticked) return new Set<string>();
  const deleteFiles = checks.some((c, i) => c.key === 'files' && ticked[i]);
  const deleteEvents = checks.some((c, i) => c.key === 'events' && ticked[i]);
  queryClient.setQueryData<PageSummary[]>(keys.pages(workspaceId), (list) => list?.filter((p) => !removed.has(p.id)));
  try {
    const sent = await sendOrQueue('POST', `/api/pages/${pageId}/trash`, deleteEvents || deleteFiles ? { deleteEvents, deleteFiles } : undefined, 'Move a page to the trash');
    if (deleteEvents) {
      queryClient.invalidateQueries({ queryKey: ['calendar', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId] });
    }
    if (deleteFiles) queryClient.invalidateQueries({ queryKey: ['files', workspaceId] });
    toast(sent ? 'Moved to trash' : 'Moved to trash (will sync when you’re back online)');
  } catch (err) {
    toastError(err);
  }
  if (isOnline()) invalidatePages(workspaceId, pageId);
  return removed;
}

export async function duplicatePage(workspaceId: string, pageId: string) {
  const { page } = await api<{ page: { id: string } }>(`/api/pages/${pageId}/duplicate`, { method: 'POST' });
  invalidatePages(workspaceId);
  return page.id;
}

export async function copyPageLink(workspaceId: string, pageId: string) {
  try {
    await navigator.clipboard.writeText(`${publicOrigin()}/w/${workspaceId}/p/${pageId}`);
    toast('Link copied');
  } catch {
    toast('Could not copy the link', 'error');
  }
}
