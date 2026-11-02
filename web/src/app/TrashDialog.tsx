import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button, confirmDialog, Dialog, IconButton, Spinner, toast, toastError } from '../components/ui';
import { api, pageTitle } from '../lib/api';
import { invalidatePages, useTrash, patchPageCache } from '../lib/queries';
import { timeAgo } from '../lib/time';
import { useApp } from './context';
import { PageIcon } from './PageIcon';

export function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const trash = useTrash(workspace.id, open);
  const { pages } = useApp();
  const [tab, setTab] = useState<'trash' | 'archive'>('trash');
  const archived = pages.filter((p) => p.archivedAt);
  const unarchive = async (id: string) => {
    patchPageCache(workspace.id, id, { archivedAt: null });
    try {
      await api(`/api/pages/${id}`, { method: 'PATCH', body: { archived: false } });
      toast('Back in the sidebar');
    } catch (err) {
      toastError(err);
    }
    invalidatePages(workspace.id, id);
  };

  const restore = async (id: string) => {
    try {
      await api(`/api/pages/${id}/restore`, { method: 'POST' });
      invalidatePages(workspace.id, id);
      toast('Page restored');
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async (id: string, title: string) => {
    const ok = await confirmDialog({ title: `Delete “${title}” forever?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api(`/api/pages/${id}`, { method: 'DELETE' });
      invalidatePages(workspace.id, id);
    } catch (err) {
      toastError(err);
    }
  };

  const empty = async () => {
    const ok = await confirmDialog({ title: 'Empty trash?', message: 'All pages in the trash will be permanently deleted.', confirmLabel: 'Empty trash', danger: true });
    if (!ok) return;
    try {
      await api(`/api/workspaces/${workspace.id}/trash`, { method: 'DELETE' });
      invalidatePages(workspace.id);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={tab === 'trash' ? 'Trash' : 'Archive'} width={560}>
      <div className="flex gap-1 px-5 pb-2">
        {(['trash', 'archive'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-2.5 py-1 text-sm ${tab === t ? 'bg-active font-medium' : 'text-muted hover:bg-hover'}`}>
            {t === 'trash' ? 'Trash' : `Archive${archived.length ? ` · ${archived.length}` : ''}`}
          </button>
        ))}
      </div>
      {tab === 'archive' && (
        <div className="max-h-[56vh] overflow-y-auto px-2 pb-3">
          {!archived.length && <div className="py-12 text-center text-sm text-muted">Nothing archived. Archive a page from its ••• menu to take it out of the sidebar without deleting it.</div>}
          {archived.map((p) => (
            <div key={p.id} className="group flex items-center gap-3 rounded-md px-3 py-2 hover:bg-hover">
              <PageIcon page={p} />
              <button
                className="min-w-0 flex-1 text-start"
                onClick={() => {
                  onClose();
                  navigate(`/w/${workspace.id}/p/${p.id}`);
                }}
              >
                <div className="truncate text-sm">{pageTitle(p)}</div>
                <div className="text-xs text-faint">Archived {timeAgo(p.archivedAt!)}</div>
              </button>
              <Button size="sm" variant="ghost" onClick={() => unarchive(p.id)}>
                Unarchive
              </Button>
            </div>
          ))}
        </div>
      )}
      {tab === 'trash' && (
      <div className="max-h-[56vh] overflow-y-auto px-2 pb-2">
        {trash.isPending && (
          <div className="flex justify-center py-10 text-muted">
            <Spinner />
          </div>
        )}
        {trash.data?.length === 0 && <div className="py-12 text-center text-sm text-muted">The trash is empty.</div>}
        {trash.data?.map((p) => (
          <div key={p.id} className="group flex items-center gap-3 rounded-md px-3 py-2 hover:bg-hover">
            <PageIcon page={p} />
            <button
              className="min-w-0 flex-1 text-start"
              onClick={() => {
                onClose();
                navigate(`/w/${workspace.id}/p/${p.id}`);
              }}
            >
              <div className="truncate text-sm">{pageTitle(p)}</div>
              <div className="text-xs text-faint">Deleted {timeAgo(p.deletedAt)}</div>
            </button>
            <IconButton onClick={() => restore(p.id)} title="Restore">
              <RotateCcw size={15} />
            </IconButton>
            <IconButton onClick={() => remove(p.id, pageTitle(p))} title="Delete forever" className="hover:text-danger">
              <Trash2 size={15} />
            </IconButton>
          </div>
        ))}
      </div>
      )}
      {tab === 'trash' && !!trash.data?.length && (
        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="text-xs text-muted">Pages in the trash can be restored at any time.</span>
          <Button size="sm" variant="danger" onClick={empty}>
            Empty trash
          </Button>
        </div>
      )}
    </Dialog>
  );
}
