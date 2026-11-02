import { useQuery } from '@tanstack/react-query';
import { Copy, RefreshCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router';
import { DocumentEditor } from '../app/DocumentEditor';
import { toast } from '../components/ui';
import { api, type User } from '../lib/api';
import { useCollab } from '../lib/collab';
import { useDirectory } from '../lib/directory';
import { usePublicDoc } from '../lib/publicDoc';
import { newId } from '../database/model';

// A synced block: content kept in one place (a small document stored with the page it was made on)
// and shown in as many pages as you like. Editing any copy changes them all.

interface SyncedSource {
  pageId: string;
  syncId: string;
  pageTitle: string;
  preview: string;
}

/** Keeps the nested editor's keys, clicks and drags away from the page around it. */
function useIsolation() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const events = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'mousedown', 'dragstart', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend'];
    events.forEach((n) => el.addEventListener(n, stop));
    return () => events.forEach((n) => el.removeEventListener(n, stop));
  }, []);
  return ref;
}

function Chooser({ onSet }: { onSet: (p: { pageId: string; syncId: string }) => void }) {
  const dir = useDirectory();
  const { pageId } = useParams();
  const sources = useQuery({
    queryKey: ['synced-blocks', dir?.workspaceId],
    queryFn: () => api<{ blocks: SyncedSource[] }>(`/api/workspaces/${dir!.workspaceId}/synced-blocks`),
    enabled: !!dir?.workspaceId,
  });
  return (
    <div className="rounded-lg border border-dashed border-accent/60 p-3">
      <div className="mb-2 text-sm font-medium">Synced block</div>
      <button
        disabled={!pageId}
        onClick={() => pageId && onSet({ pageId, syncId: newId() })}
        className="mb-2 rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-white disabled:opacity-50"
      >
        New synced block
      </button>
      {!!sources.data?.blocks.length && (
        <>
          <div className="mt-1 mb-1 text-xs text-faint">Or show one that already exists:</div>
          <div className="max-h-48 overflow-y-auto">
            {sources.data.blocks.map((b) => (
              <button key={b.syncId} onClick={() => onSet({ pageId: b.pageId, syncId: b.syncId })} className="block w-full rounded-md px-2 py-1.5 text-start hover:bg-hover">
                <span className="block truncate text-sm">{b.preview || 'Empty synced block'}</span>
                <span className="block truncate text-xs text-muted">from {b.pageTitle || 'Untitled'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MemberSynced({ pageId, syncId, user, workspaceId, editable }: { pageId: string; syncId: string; user: User; workspaceId: string; editable: boolean }) {
  const { session, synced, denied } = useCollab(`${pageId}:sync_${syncId}`, user, () => {});
  if (denied) return <p className="px-2 py-1 text-sm text-muted">You don’t have access to the page this synced block comes from.</p>;
  if (!session || !synced) return <p className="px-2 py-1 text-sm text-faint">Loading…</p>;
  return <DocumentEditor session={session} user={user} workspaceId={workspaceId} parentPageId={pageId} className="pb-1" readOnly={!editable} />;
}

function PublicSynced({ token, pageId, syncId, user }: { token: string; pageId: string; syncId: string; user: User }) {
  const { session, error } = usePublicDoc(token, pageId, `sync_${syncId}`);
  if (error || !session) return null;
  return <DocumentEditor session={session} user={user} workspaceId="" parentPageId={pageId} className="pb-1" readOnly />;
}

export function SyncedBlockView({ pageId, syncId, editable, onSet }: { pageId: string; syncId: string; editable: boolean; onSet: (p: { pageId: string; syncId: string }) => void }) {
  const dir = useDirectory();
  const ref = useIsolation();
  const here = useParams().pageId;
  const source = dir?.pages.find((p) => p.id === pageId);
  if (!dir) return null;
  return (
    <div ref={ref} contentEditable={false} className="group/synced relative w-full rounded-md outline-1 outline-transparent hover:outline-accent/50 hover:outline-dashed">
      {!syncId ? (
        editable ? (
          <Chooser onSet={onSet} />
        ) : null
      ) : (
        <>
          <div className="pointer-events-none absolute -top-3 end-1 z-10 flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[11px] text-accent opacity-0 shadow-sm group-hover/synced:pointer-events-auto group-hover/synced:opacity-100">
            <RefreshCcw size={11} />
            {pageId === here ? 'Synced block' : `Synced from ${source ? source.title || 'Untitled' : 'another page'}`}
            {editable && (
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(`synced:${pageId}:${syncId}`).catch(() => {});
                  toast('To show it elsewhere: type /synced in another page and pick it from the list');
                }}
                className="ms-1 rounded p-0.5 hover:bg-hover"
                title="How to show it elsewhere"
              >
                <Copy size={11} />
              </button>
            )}
          </div>
          {dir.public ? (
            <PublicSynced token={dir.public.token} pageId={pageId} syncId={syncId} user={dir.user} />
          ) : (
            <MemberSynced pageId={pageId} syncId={syncId} user={dir.user} workspaceId={dir.workspaceId} editable={editable} />
          )}
        </>
      )}
    </div>
  );
}
