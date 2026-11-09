import { publicOrigin } from '../lib/native';
import { useQuery } from '@tanstack/react-query';
import { Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button, confirmDialog, Dialog, Spinner, toast, toastError } from '../components/ui';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';

const absolute = (path: string) => new URL(path, publicOrigin()).toString();
const isLocal = () => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(location.hostname);

/** "Subscribe in another calendar app": the person's secret .ics link for this workspace. */
export function FeedDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const key = ['calendar-feed', workspaceId];
  const feed = useQuery({ queryKey: key, queryFn: () => api<{ path: string }>(`/api/workspaces/${workspaceId}/calendar/feed`) });
  const [resetting, setResetting] = useState(false);
  const url = feed.data ? absolute(feed.data.path) : '';

  const copy = () => void navigator.clipboard.writeText(url).then(() => toast('Link copied'));
  const reset = async () => {
    const ok = await confirmDialog({
      title: 'Make a new link?',
      message: 'The current link stops working, so calendars subscribed with it stop updating. Use this if the link was shared by mistake.',
      confirmLabel: 'New link',
      danger: true,
    });
    if (!ok) return;
    setResetting(true);
    try {
      queryClient.setQueryData(key, await api<{ path: string }>(`/api/workspaces/${workspaceId}/calendar/feed/reset`, { method: 'POST' }));
      toast('New link made');
    } catch (err) {
      toastError(err);
    } finally {
      setResetting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Subscribe in another calendar app" width={520}>
      <div className="space-y-3 px-5 pb-5 text-sm">
        <p className="text-muted">
          Add this link to Google Calendar, Outlook or Apple Calendar to see your events, tasks, dated cards and dated to-dos there. They
          follow changes made here (most apps check every few hours).
        </p>
        {feed.isPending ? (
          <Spinner />
        ) : (
          <div className="flex gap-2">
            <input readOnly value={url} onFocus={(e) => e.target.select()} className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 font-mono text-xs" />
            <Button onClick={copy}>
              <Copy size={14} /> Copy
            </Button>
          </div>
        )}
        <ul className="list-disc space-y-1 ps-5 text-muted">
          <li>
            <b className="text-fg">Google Calendar:</b> Other calendars → + → From URL.
          </li>
          <li>
            <b className="text-fg">Outlook:</b> Add calendar → Subscribe from web.
          </li>
          <li>
            <b className="text-fg">Apple Calendar:</b> File → New Calendar Subscription.
          </li>
        </ul>
        {isLocal() && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            This server is only reachable on your own network, so online calendars (Google, Outlook.com) can't fetch the link. Apps on a
            computer on the same network can, or serve this app on a public address first.
          </p>
        )}
        <p className="text-xs text-faint">Anyone with the link can see these events, so keep it private. Read-only: changes made in the other app don't come back here.</p>
        <div className="flex justify-between pt-1">
          <Button onClick={reset} loading={resetting}>
            <RefreshCw size={14} /> New link
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Picks a .ics file and adds its events to the workspace's calendar. */
export function importIcs(workspaceId: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.ics,text/calendar';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { added, skipped } = await api<{ added: number; skipped: number }>(`/api/workspaces/${workspaceId}/events/import`, {
        method: 'POST',
        body: { ics: await file.text() },
      });
      toast(`Added ${added} event${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already here)` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['calendar', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId] });
    } catch (err) {
      toastError(err);
    }
  };
  input.click();
}
