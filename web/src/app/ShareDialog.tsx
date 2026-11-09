import { publicOrigin } from '../lib/native';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Globe, Link2, Lock } from 'lucide-react';
import { useState } from 'react';
import { GuestsSection } from './GuestsSection';
import { Avatar, Dialog, Spinner, toast, toastError } from '../components/ui';
import { api, pageTitle, type PageDetail, type Role } from '../lib/api';
import { invalidatePages, queryClient } from '../lib/queries';
import { useApp } from './context';
import { copyPageLink } from './pageActions';

type Level = 'edit' | 'view' | 'none';

interface SharingMember {
  id: string;
  name: string;
  email: string;
  color: string;
  role: Role;
  level: Level | null;
}

interface Sharing {
  defaultAccess: Level | null;
  inheritedDefault: Level;
  members: SharingMember[];
}

const LABELS: Record<Level, string> = { edit: 'Can edit', view: 'Can view', none: 'No access' };

export function ShareDialog({ page, open, onClose }: { page: PageDetail; open: boolean; onClose: () => void }) {
  const { workspace, user } = useApp();
  const key = ['sharing', page.id];
  const sharing = useQuery({ queryKey: key, queryFn: () => api<Sharing>(`/api/pages/${page.id}/permissions`), enabled: open });
  const [saving, setSaving] = useState(false);

  const save = async (next: { defaultAccess: Level | null; members: { userId: string; level: Level | null }[] }) => {
    setSaving(true);
    try {
      await api(`/api/pages/${page.id}/permissions`, { method: 'PUT', body: next });
      await queryClient.invalidateQueries({ queryKey: key });
      invalidatePages(workspace.id, page.id);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  const data = sharing.data;
  const generalValue = data?.defaultAccess ?? 'inherit';
  const effectiveDefault = data?.defaultAccess ?? data?.inheritedDefault ?? 'edit';

  return (
    <Dialog open={open} onClose={onClose} title={`Share “${pageTitle(page)}”`} width={520}>
      <div className="px-5 pb-5">
        {!data ? (
          <div className="flex justify-center py-10 text-muted">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-line p-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent">
                {effectiveDefault === 'none' ? <Lock size={17} /> : <Globe size={17} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Everyone in {workspace.name}</div>
                <div className="text-xs text-muted">
                  {generalValue === 'inherit' ? `Same as the parent page (${LABELS[data.inheritedDefault].toLowerCase()})` : 'Applies to members without their own setting below'}
                </div>
              </div>
              <select
                value={generalValue}
                disabled={saving}
                onChange={(e) => save({ defaultAccess: e.target.value === 'inherit' ? null : (e.target.value as Level), members: [] })}
                className="h-8 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
              >
                <option value="inherit">{page.parentId ? 'Inherit from parent' : 'Default (can edit)'}</option>
                <option value="edit">Can edit</option>
                <option value="view">Can view</option>
                <option value="none">No access</option>
              </select>
            </div>

            <div className="mt-4 mb-1 text-xs font-medium text-faint">People</div>
            <div className="max-h-[40vh] divide-y divide-line overflow-y-auto">
              {data.members.map((m) => {
                const fixed = m.role === 'owner' || m.id === user.id;
                return (
                  <div key={m.id} className="flex items-center gap-3 py-2.5">
                    <Avatar name={m.name} color={m.color} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        {m.name} {m.id === user.id && <span className="text-faint">(you)</span>}
                      </div>
                      <div className="truncate text-xs text-muted">{m.email}</div>
                    </div>
                    {fixed ? (
                      <span className="text-xs text-muted">{m.role === 'owner' ? 'Workspace owner' : 'Full access'}</span>
                    ) : (
                      <select
                        value={m.level ?? 'default'}
                        disabled={saving}
                        onChange={(e) =>
                          save({ defaultAccess: data.defaultAccess, members: [{ userId: m.id, level: e.target.value === 'default' ? null : (e.target.value as Level) }] })
                        }
                        className="h-8 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
                      >
                        <option value="default">Default ({LABELS[effectiveDefault].toLowerCase()})</option>
                        <option value="edit">Can edit</option>
                        <option value="view">Can view</option>
                        <option value="none">No access</option>
                      </select>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-muted">Sub-pages follow these settings unless they have their own.</span>
              <button
                onClick={() => copyPageLink(workspace.id, page.id)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-accent hover:bg-accent-soft"
              >
                <Link2 size={14} /> Copy link
              </button>
            </div>
            <GuestsSection page={page} />
            <PublishSection page={page} />
          </>
        )}
      </div>
    </Dialog>
  );
}

interface PublishState {
  published: boolean;
  token: string | null;
  subpages: boolean;
  allowIndex: boolean;
  via: { id: string; title: string; token: string } | null;
}

/** Publishing the page to the web: a link anyone can read, no account needed. */
function PublishSection({ page }: { page: PageDetail }) {
  const key = ['publish', page.id];
  const state = useQuery({ queryKey: key, queryFn: () => api<PublishState>(`/api/pages/${page.id}/publish`) });
  const [busy, setBusy] = useState(false);
  const canManage = page.access === 'manage';
  const data = state.data;
  const url = data?.token ? `${publicOrigin()}/share/${data.token}` : '';

  const save = async (next: { published: boolean; subpages: boolean; allowIndex: boolean }) => {
    setBusy(true);
    try {
      await api(`/api/pages/${page.id}/publish`, { method: 'PUT', body: next });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast('Could not copy the link', 'error');
    }
  };

  if (!data) return null;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Globe size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Publish to the web</div>
          <div className="text-xs text-muted">
            {data.published ? 'Anyone with the link can read this page.' : data.via ? `Already public as part of “${data.via.title || 'Untitled'}”.` : 'Make a read-only link that works without an account.'}
          </div>
        </div>
        {canManage && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.published}
              disabled={busy}
              onChange={(e) => save({ published: e.target.checked, subpages: data.subpages, allowIndex: data.allowIndex })}
            />
            {data.published ? 'On' : 'Off'}
          </label>
        )}
      </div>
      {data.published && (
        <div className="mt-3 space-y-2 ps-12">
          <div className="flex items-center gap-1.5">
            <input readOnly value={url} onFocus={(e) => e.target.select()} className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-xs text-muted outline-none" />
            <button onClick={copy} className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-accent hover:bg-accent-soft">
              <Link2 size={14} /> Copy
            </button>
            <a href={url} target="_blank" rel="noreferrer" className="flex h-8 items-center rounded-md px-2 text-muted hover:bg-hover" title="Open">
              <ExternalLink size={14} />
            </a>
          </div>
          {canManage && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={data.subpages} disabled={busy} onChange={(e) => save({ published: true, subpages: e.target.checked, allowIndex: data.allowIndex })} />
                Include the pages inside it
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={data.allowIndex} disabled={busy} onChange={(e) => save({ published: true, subpages: data.subpages, allowIndex: e.target.checked })} />
                Let search engines find it
              </label>
            </>
          )}
          <p className="text-xs text-faint">Only people who can reach this server can open the link. To share with anyone on the internet, the server needs a public address.</p>
        </div>
      )}
    </div>
  );
}
