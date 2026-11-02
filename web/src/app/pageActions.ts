import { isOnline, sendOrQueue } from '../lib/offline';
import { confirmDialog, toast, toastError } from '../components/ui';
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
  // Ask first, so a page isn't deleted by a stray click.
  const title = pages.find((p) => p.id === pageId)?.title.trim() || 'Untitled';
  const inside = removed.size - 1;
  const sure = await confirmDialog({
    title: `Move “${title}” to the trash?`,
    message: inside > 0 ? `The ${inside} page${inside === 1 ? '' : 's'} inside it will go too. You can restore them from the trash.` : 'You can restore it from the trash.',
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!sure) return new Set<string>();
  // Events and tasks that live only in this page (and the pages and cards inside it) can go too.
  let deleteEvents = false;
  if (isOnline()) {
    const own = await api<{ count: number }>(`/api/pages/${pageId}/own-events`).catch(() => ({ count: 0 }));
    if (own.count > 0) {
      deleteEvents = await confirmDialog({
        title: `Also delete ${own.count} event${own.count === 1 ? '' : 's'} and task${own.count === 1 ? '' : 's'}?`,
        message: `They're only in this page${removed.size > 1 ? ' and the pages inside it' : ''} — nowhere else. If you delete them, restoring the page from the trash won't bring them back. Events that are also in other pages are kept either way.`,
        confirmLabel: 'Delete them too',
        cancelLabel: 'Keep them',
        danger: true,
      });
    }
  }
  queryClient.setQueryData<PageSummary[]>(keys.pages(workspaceId), (list) => list?.filter((p) => !removed.has(p.id)));
  try {
    const sent = await sendOrQueue('POST', `/api/pages/${pageId}/trash`, deleteEvents ? { deleteEvents: true } : undefined, 'Move a page to the trash');
    if (deleteEvents) {
      queryClient.invalidateQueries({ queryKey: ['calendar', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId] });
    }
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
    await navigator.clipboard.writeText(`${location.origin}/w/${workspaceId}/p/${pageId}`);
    toast('Link copied');
  } catch {
    toast('Could not copy the link', 'error');
  }
}
