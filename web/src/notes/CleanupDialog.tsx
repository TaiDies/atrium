import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Dialog, Spinner, toast, toastError } from '../components/ui';
import { api } from '../lib/api';
import { refreshFiles } from './api';

// Deleting files nothing uses any more: in no page or card, not a cover, not in a chat, whiteboard,
// template or page history. Handwritten notes and files added in the last few minutes are never listed.
// Everything starts ticked; the list is checked again on the server before anything is deleted.

interface Unused {
  id: string;
  name: string;
  size: string;
  createdAt: string;
}

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function CleanupDialog({ workspaceId, isOwner, onClose }: { workspaceId: string; isOwner: boolean; onClose: () => void }) {
  const unused = useQuery({
    queryKey: ['files-unused', workspaceId],
    queryFn: () => api<{ files: Unused[]; size: number }>(`/api/workspaces/${workspaceId}/files/unused`),
    staleTime: 0,
  });
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => setKeep(new Set()), [unused.data]);
  const files = unused.data?.files ?? [];
  const chosen = files.filter((f) => !keep.has(f.id));
  const total = chosen.reduce((n, f) => n + Number(f.size), 0);
  const remove = async () => {
    setBusy(true);
    try {
      const { deleted } = await api<{ deleted: number }>(`/api/workspaces/${workspaceId}/files/unused/delete`, { method: 'POST', body: { ids: chosen.map((f) => f.id) } });
      toast(`Deleted ${deleted} file${deleted === 1 ? '' : 's'}`);
      void refreshFiles(workspaceId);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Delete unused files" width={520} maxHeight="86vh">
      <div className="flex min-h-0 flex-col gap-3 px-5 pb-5">
        <p className="text-sm text-muted">
          Files that aren't in any page or card, cover, chat, whiteboard or template. {isOwner ? '' : 'Only files you added are listed. '}Handwritten notes are kept. Untick any you want to keep.
        </p>
        {unused.isPending ? (
          <Spinner />
        ) : files.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Every file is in use. Nothing to delete.</p>
        ) : (
          <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {files.map((f) => (
              <label key={f.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={!keep.has(f.id)}
                  onChange={(e) =>
                    setKeep((k) => {
                      const next = new Set(k);
                      if (e.target.checked) next.delete(f.id);
                      else next.add(f.id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-xs text-faint">{size(Number(f.size))}</span>
              </label>
            ))}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {chosen.length > 0 && <span className="flex-1 text-xs text-muted">Frees {size(total)}. This can't be undone.</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()} loading={busy} disabled={!chosen.length}>
            Delete {chosen.length || ''} file{chosen.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
