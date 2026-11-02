import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Archive, ArrowUpRight, BadgeCheck, Bell, CloudDownload, History, Lock, MoveHorizontal, RotateCcw, Text } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { Button, confirmDialog, Dialog, MenuDivider, MenuItem, Popover, toast, toastError } from '../components/ui';
import { DatabaseView } from '../database/DatabaseView';
import type { ViewType } from '../database/model';
import { api, canEdit, type PageDetail, pageTitle } from '../lib/api';
import { type CollabSession, downloadForOffline } from '../lib/collab';
import { offlinePages, setKeptOffline } from '../lib/offline';
import { TeamspaceMenuItems } from './Teamspaces';
import { invalidatePages, patchPageCache, queryClient } from '../lib/queries';
import { timeAgo } from '../lib/time';
import { useApp } from './context';
import { DocumentEditor } from './DocumentEditor';
import { PageIcon } from './PageIcon';

// More about a page: locking it, archiving, verifying (wiki pages), its layout, its history and the
// pages that link to it.

/** Changes one of the page's settings (locked, archived, verified, layout…). */
async function patchPage(workspaceId: string, page: PageDetail, patch: Record<string, unknown>, cache: Partial<PageDetail>) {
  patchPageCache(workspaceId, page.id, cache);
  try {
    await api(`/api/pages/${page.id}`, { method: 'PATCH', body: patch });
  } catch (err) {
    toastError(err);
  }
  invalidatePages(workspaceId, page.id);
}

const FOREVER = '9999';

/** Whether a page is somewhere inside another. */
export function isInside(pages: { id: string; parentId: string | null }[], id: string, ancestor: string): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (let p = byId.get(id), depth = 0; p?.parentId && depth < 100; p = byId.get(p.parentId), depth++) if (p.parentId === ancestor) return true;
  return false;
}

/** Badges under a page's title: locked, archived, verified, and how many pages link here. */
export function PageBadges({ page }: { page: PageDetail }) {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const editable = canEdit(page.access);
  const [linksAt, setLinksAt] = useState<DOMRect | null>(null);
  const backlinks = useQuery({
    queryKey: ['backlinks', page.id],
    queryFn: () => api<{ backlinks: { id: string; title: string; icon: string; type: string; rowId: string }[] }>(`/api/pages/${page.id}/backlinks`),
  });
  const links = backlinks.data?.backlinks ?? [];
  const verified = page.verifiedUntil ? new Date(page.verifiedUntil) : null;
  const expired = verified && verified.getTime() < Date.now();
  const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs';
  if (!page.locked && !page.archivedAt && !verified && !links.length) return null;
  return (
    <div className="mt-1 mb-1 flex flex-wrap items-center gap-1.5">
      {page.locked && (
        <button
          disabled={!editable}
          onClick={() => patchPage(workspace.id, page, { locked: false }, { locked: false })}
          className={clsx(chip, 'bg-hover text-muted', editable && 'hover:text-fg')}
          title={editable ? 'Locked against accidental edits — click to unlock' : 'Locked'}
        >
          <Lock size={12} /> Locked
        </button>
      )}
      {page.archivedAt && (
        <button
          disabled={!editable}
          onClick={() => patchPage(workspace.id, page, { archived: false }, { archivedAt: null })}
          className={clsx(chip, 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}
          title={editable ? 'Archived — click to put it back in the sidebar' : 'Archived'}
        >
          <Archive size={12} /> Archived
        </button>
      )}
      {verified && (
        <span
          className={clsx(chip, expired ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-green-500/12 text-green-700 dark:text-green-400')}
          title={`${expired ? 'Verification expired' : 'Verified'}${page.verifiedByName ? ` by ${page.verifiedByName}` : ''}${verified.getFullYear() < 9000 ? ` · until ${verified.toLocaleDateString()}` : ''}`}
        >
          <BadgeCheck size={12} /> {expired ? 'Verification expired' : 'Verified'}
        </span>
      )}
      {links.length > 0 && (
        <button onClick={(e) => setLinksAt(e.currentTarget.getBoundingClientRect())} className={clsx(chip, 'text-muted hover:bg-hover hover:text-fg')}>
          <ArrowUpRight size={12} /> {links.length} backlink{links.length === 1 ? '' : 's'}
        </button>
      )}
      <Popover anchor={linksAt} onClose={() => setLinksAt(null)} className="w-72 p-1">
        <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-faint">Pages that link here</div>
        {links.map((l) => (
          <button
            key={`${l.id}:${l.rowId}`}
            onClick={() => {
              setLinksAt(null);
              navigate(`/w/${workspace.id}/p/${l.id}${l.rowId ? `?row=${l.id}:${l.rowId}` : ''}`);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover"
          >
            <PageIcon page={l as never} size={14} />
            <span className="truncate">
              {pageTitle(l)}
              {l.rowId ? <span className="text-faint"> · a card</span> : null}
            </span>
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** The page's own settings in its ••• menu. */
export function PageSettingsItems({ page, onHistory }: { page: PageDetail; onHistory: () => void }) {
  const { workspace, user, pages } = useApp();
  const [kept, setKept] = useState(() => offlinePages(user.id).includes(page.id));
  const editable = canEdit(page.access);
  const layout = page.layout ?? {};
  const verified = page.verifiedUntil && new Date(page.verifiedUntil).getTime() > Date.now();
  const verify = (days: number | null) =>
    patchPage(workspace.id, page, { verifiedDays: days }, { verifiedUntil: days === null ? null : days === 0 ? `${FOREVER}-12-31` : new Date(Date.now() + days * 86_400_000).toISOString() });
  return (
    <>
      <MenuItem icon={<History size={15} />} label="Page history" onClick={onHistory} />
      <MenuItem
        icon={<CloudDownload size={15} />}
        label="Keep offline"
        checked={kept}
        onClick={() => {
          setKeptOffline(user.id, page.id, !kept);
          setKept(!kept);
          if (!kept) {
            const inside = pages.filter((p) => p.id === page.id || isInside(pages, p.id, page.id)).map((p) => p.id);
            void downloadForOffline(inside, user).then(() => toast(`Kept on this device: ${inside.length} page${inside.length === 1 ? '' : 's'}`));
          }
        }}
      />
      <FollowItem page={page} />
      <TeamspaceMenuItems page={page} />
      {editable && (
        <>
          <MenuItem icon={<Lock size={15} />} label={page.locked ? 'Unlock page' : 'Lock page'} onClick={() => patchPage(workspace.id, page, { locked: !page.locked }, { locked: !page.locked })} />
          {page.type === 'document' && (
            <>
              <MenuItem
                icon={<MoveHorizontal size={15} />}
                label="Full width"
                checked={!!layout.fullWidth}
                onClick={() => patchPage(workspace.id, page, { layout: { ...layout, fullWidth: !layout.fullWidth } }, { layout: { ...layout, fullWidth: !layout.fullWidth } })}
              />
              <MenuItem
                icon={<Text size={15} />}
                label="Small text"
                checked={!!layout.smallText}
                onClick={() => patchPage(workspace.id, page, { layout: { ...layout, smallText: !layout.smallText } }, { layout: { ...layout, smallText: !layout.smallText } })}
              />
            </>
          )}
          {verified ? (
            <MenuItem icon={<BadgeCheck size={15} />} label="Remove verification" onClick={() => verify(null)} />
          ) : (
            <>
              <MenuItem icon={<BadgeCheck size={15} />} label="Verify for 30 days" onClick={() => verify(30)} />
              <MenuItem icon={<BadgeCheck size={15} />} label="Verify for 90 days" onClick={() => verify(90)} />
              <MenuItem icon={<BadgeCheck size={15} />} label="Verify with no end" onClick={() => verify(0)} />
            </>
          )}
          <MenuItem
            icon={<Archive size={15} />}
            label={page.archivedAt ? 'Unarchive' : 'Archive'}
            onClick={() => {
              patchPage(workspace.id, page, { archived: !page.archivedAt }, { archivedAt: page.archivedAt ? null : new Date().toISOString() });
              toast(page.archivedAt ? 'Back in the sidebar' : 'Archived: out of the sidebar, still in search and links (find it under Trash → Archive)');
            }}
          />
          <MenuDivider />
        </>
      )}
    </>
  );
}

interface Version {
  id: number;
  createdAt: string;
  editorName: string | null;
}

function VersionPreview({ page, versionId, rowId }: { page: PageDetail; versionId: number; rowId?: string }) {
  const { user } = useApp();
  const [session, setSession] = useState<CollabSession | null>(null);
  useEffect(() => {
    const doc = new Y.Doc();
    let alive = true;
    setSession(null);
    fetch(`/api/pages/${page.id}/versions/${versionId}`, { credentials: 'same-origin' })
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!alive) return;
        Y.applyUpdate(doc, new Uint8Array(buf));
        setSession({ doc, provider: { awareness: new Awareness(doc) } } as unknown as CollabSession);
      })
      .catch(() => {});
    return () => {
      alive = false;
      doc.destroy();
    };
  }, [page.id, versionId]);
  if (!session) return <div className="p-6 text-sm text-muted">Loading…</div>;
  if (page.type !== 'document' && !rowId) return <DatabaseView doc={session.doc} pageId={page.id} pageType={page.type as ViewType} workspaceId={page.workspaceId} readOnly embedded />;
  return <DocumentEditor key={versionId} session={session} user={user} workspaceId={page.workspaceId} parentPageId={page.id} readOnly className="pb-10" />;
}

/** Earlier versions of a page (or card), to look at and bring back. */
export function HistoryDialog({ page, rowId, onClose }: { page: PageDetail; rowId?: string; onClose: () => void }) {
  const versions = useQuery({
    queryKey: ['versions', page.id, rowId ?? ''],
    queryFn: () => api<{ versions: Version[] }>(`/api/pages/${page.id}/versions${rowId ? `?row=${rowId}` : ''}`),
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const list = versions.data?.versions ?? [];
  const current = selected ?? list[0]?.id ?? null;
  const restore = async () => {
    if (current === null) return;
    const v = list.find((x) => x.id === current);
    if (!(await confirmDialog({ title: 'Restore this version?', message: `The page goes back to how it was ${v ? timeAgo(v.createdAt) : ''}. The current version is kept in the history, so this can be undone.`, confirmLabel: 'Restore' }))) return;
    setBusy(true);
    try {
      await api(`/api/pages/${page.id}/versions/${current}/restore`, { method: 'POST' });
      toast('Version restored');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Page history" width={1000} maxHeight="88vh" top="5vh" className="h-[88vh]">
      <div className="flex h-full min-h-0 border-t border-line">
        <div className="w-56 shrink-0 overflow-y-auto border-e border-line p-1.5">
          {versions.isPending && <p className="p-2 text-sm text-muted">Loading…</p>}
          {!versions.isPending && !list.length && <p className="p-2 text-sm text-muted">No earlier versions yet. Versions are kept as the page is edited (every 10 minutes or so).</p>}
          {list.map((v) => (
            <button key={v.id} onClick={() => setSelected(v.id)} className={clsx('block w-full rounded-md px-2 py-1.5 text-start', current === v.id ? 'bg-active' : 'hover:bg-hover')}>
              <span className="block text-sm">{new Date(v.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <span className="block truncate text-xs text-muted">{v.editorName ?? 'Someone'}</span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2">
            <span className="flex-1 text-sm text-muted">{current !== null ? 'Read-only preview' : ''}</span>
            {canEdit(page.access) && current !== null && (
              <Button size="sm" variant="primary" loading={busy} onClick={restore}>
                <RotateCcw size={14} /> Restore this version
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-4">{current !== null && <VersionPreview page={page} versionId={current} rowId={rowId} />}</div>
        </div>
      </div>
    </Dialog>
  );
}

/** Following a page: its changes show under the bell's Updates. */
function FollowItem({ page }: { page: PageDetail }) {
  const key = ['follow', page.id];
  const state = useQuery({ queryKey: key, queryFn: () => api<{ following: boolean }>(`/api/pages/${page.id}/follow`) });
  const following = !!state.data?.following;
  return (
    <MenuItem
      icon={<Bell size={15} />}
      label="Follow"
      checked={following}
      onClick={async () => {
        try {
          await api(`/api/pages/${page.id}/follow`, { method: 'PUT', body: { following: !following } });
          queryClient.setQueryData(key, { following: !following });
          toast(following ? 'Unfollowed' : 'Following — changes show under 🔔 → Updates');
        } catch (err) {
          toastError(err);
        }
      }}
    />
  );
}
