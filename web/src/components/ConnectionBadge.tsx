import { CloudOff, Loader2 } from 'lucide-react';
import { useConnection } from '../lib/offline';

/**
 * Shown in the sidebar while the server can't be reached or offline changes are being sent: everything
 * keeps working, and edits are saved on this device until they can be synced.
 */
export function ConnectionBadge() {
  const { online, pending, syncing } = useConnection();
  if (online && !syncing && pending === 0) return null;
  return (
    <div
      className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-hover px-2 py-1.5 text-xs text-muted"
      title="Your edits are saved on this device and sync automatically when the connection is back"
    >
      {syncing ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <CloudOff size={13} className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">
        {syncing ? 'Syncing changes…' : online ? `${pending} change${pending === 1 ? '' : 's'} waiting to sync` : 'Offline — changes are saved on this device'}
      </span>
      {!syncing && pending > 0 && <span className="shrink-0 rounded-full bg-active px-1.5 tabular-nums">{pending}</span>}
    </div>
  );
}
