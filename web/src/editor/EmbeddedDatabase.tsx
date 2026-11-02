import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { PageIcon } from '../app/PageIcon';
import { DatabaseView } from '../database/DatabaseView';
import type { ViewType } from '../database/model';
import { pageTitle } from '../lib/api';
import { useCollab } from '../lib/collab';
import { useDirectory } from '../lib/directory';
import { usePublicDoc } from '../lib/publicDoc';

const DATABASE_TYPES = ['grid', 'board', 'calendar', 'timeline', 'chart', 'form', 'list', 'gallery', 'feed'];

/** Choosing which database a linked view shows. */
function DatabaseChooser({ onPick, editable }: { onPick: (pageId: string) => void; editable: boolean }) {
  const dir = useDirectory();
  const [q, setQ] = useState('');
  const databases = (dir?.pages ?? []).filter((p) => DATABASE_TYPES.includes(p.type) && pageTitle(p).toLowerCase().includes(q.trim().toLowerCase()));
  if (!editable) return <div className="rounded-md border border-dashed border-line px-3 py-4 text-sm text-faint italic">A linked view that hasn’t been set up yet.</div>;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 text-sm font-medium">Linked view of a database</div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a database…" className="mb-2 h-8 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent" />
      <div className="max-h-56 overflow-y-auto">
        {databases.map((p) => (
          <button key={p.id} onClick={() => onPick(p.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover">
            <PageIcon page={p} size={15} />
            <span className="truncate">{pageTitle(p)}</span>
          </button>
        ))}
        {!databases.length && <p className="px-2 py-2 text-xs text-muted">No databases found.</p>}
      </div>
    </div>
  );
}

/** A database page rendered inline inside a document (an inline grid, board, calendar…). */
export function EmbeddedDatabase({
  pageId,
  linked = false,
  viewId = '',
  onChange,
  editable = true,
}: {
  pageId: string;
  linked?: boolean;
  viewId?: string;
  onChange?: (props: { pageId?: string; viewId?: string }) => void;
  editable?: boolean;
}) {
  const dir = useDirectory();
  const page = dir?.pages.find((p) => p.id === pageId);
  if (!dir) return null;
  if (linked && !pageId) return <DatabaseChooser editable={editable} onPick={(id) => onChange?.({ pageId: id, viewId: '' })} />;
  if (!page) {
    return <div className="rounded-md border border-dashed border-line px-3 py-4 text-sm text-faint italic">This database was moved to the trash or deleted.</div>;
  }
  return (
    <div className="my-1 w-full">
      <button
        onClick={() => dir.navigate(`/w/${dir.workspaceId}/p/${page.id}`)}
        className="group mb-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-start text-lg font-semibold hover:bg-hover"
      >
        <PageIcon page={page} size={18} />
        {pageTitle(page)}
        <ArrowUpRight size={15} className="text-faint opacity-0 group-hover:opacity-100" />
      </button>
      <Session pageId={page.id} type={page.type as ViewType} linked={linked ? { viewId, onPick: (id) => onChange?.({ viewId: id }), editable } : undefined} />
    </div>
  );
}

/** A linked view: the view it shows, and choosing one. */
export interface LinkedView {
  viewId: string;
  onPick: (viewId: string) => void;
  editable: boolean;
}

function Session({ pageId, type, linked }: { pageId: string; type: ViewType; linked?: LinkedView }) {
  const dir = useDirectory()!;
  if (dir.public) return <PublicSession token={dir.public.token} pageId={pageId} type={type} linked={linked} />;
  return <MemberSession pageId={pageId} type={type} linked={linked} />;
}

/** On a published page: the database as it was last saved, read-only. */
function PublicSession({ token, pageId, type, linked }: { token: string; pageId: string; type: ViewType; linked?: LinkedView }) {
  const { session, error } = usePublicDoc(token, pageId);
  if (error) return <div className="text-sm text-muted">This database isn’t published.</div>;
  if (!session) return null;
  return <DatabaseView doc={session.doc} pageId={pageId} pageType={type} workspaceId="" embedded readOnly linked={linked} />;
}

function MemberSession({ pageId, type, linked }: { pageId: string; type: ViewType; linked?: LinkedView }) {
  const dir = useDirectory()!;
  const { session, synced, denied } = useCollab(pageId, dir.user, () => {});
  if (denied) return <div className="text-sm text-muted">You don't have access to this database.</div>;
  if (!session || !synced) {
    return (
      <div className="flex justify-center py-6 text-muted">
        <span className="inline-block size-4 animate-spin rounded-full border-2 border-current border-e-transparent" />
      </div>
    );
  }
  return <DatabaseView doc={session.doc} pageId={pageId} pageType={type} workspaceId={dir.workspaceId} embedded linked={linked} />;
}
