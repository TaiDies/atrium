import { useQuery } from '@tanstack/react-query';
import { ArrowDownUp, Check, MoreHorizontal, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { EmojiPicker } from '../components/EmojiPicker';
import { type Anchor, Avatar, Button, confirmDialog, Dialog, IconButton, Input, Menu, MenuItem, toastError } from '../components/ui';
import { api, type PageSummary } from '../lib/api';
import { createPage, invalidatePages, queryClient, useMembers } from '../lib/queries';
import { useApp } from './context';
import { PageTree } from './PageTree';

// Teamspaces: groups of pages for some of the workspace's members (owners see them all), each with its
// own section in the sidebar. And each person's own order of the sidebar's pages.

export interface Teamspace {
  id: string;
  name: string;
  icon: string | null;
  memberIds: string[];
}

export const teamspacesKey = (ws: string) => ['teamspaces', ws];

export function useTeamspaces(workspaceId: string) {
  return useQuery({ queryKey: teamspacesKey(workspaceId), queryFn: async () => (await api<{ teamspaces: Teamspace[] }>(`/api/workspaces/${workspaceId}/teamspaces`)).teamspaces });
}

const orderKey = (ws: string) => ['sidebar-order', ws];

function useSidebarOrder(workspaceId: string) {
  return useQuery({ queryKey: orderKey(workspaceId), queryFn: async () => (await api<{ pageIds: string[] | null }>(`/api/workspaces/${workspaceId}/sidebar-order`)).pageIds });
}

async function saveOrder(workspaceId: string, pageIds: string[] | null) {
  queryClient.setQueryData(orderKey(workspaceId), pageIds);
  try {
    await api(`/api/workspaces/${workspaceId}/sidebar-order`, { method: 'PUT', body: { pageIds } });
  } catch (err) {
    toastError(err);
  }
}

/** A page made at the top of a teamspace. */
async function newTeamspacePage(workspaceId: string, teamspaceId: string) {
  const page = await createPage(workspaceId, { parentId: null, type: 'document' });
  await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { teamspaceId } });
  invalidatePages(workspaceId);
  return page;
}

function SectionHeader({ title, icon, actions, open, onToggle }: { title: string; icon?: string | null; actions?: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <div className="group flex h-7 items-center px-3">
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-xs font-medium text-faint hover:text-muted">
        {icon && <span className="text-sm leading-none">{icon}</span>}
        <span className="truncate">{title}</span>
      </button>
      <div className="hover-reveal flex opacity-0 transition-opacity group-hover:opacity-100">{actions}</div>
    </div>
  );
}

/** The sidebar's page sections: one per teamspace, then the workspace's own pages. */
export function SidebarPageSections({
  expanded,
  setExpanded,
  addPageButton,
}: {
  expanded: Set<string>;
  setExpanded: (fn: (p: Set<string>) => Set<string>) => void;
  addPageButton: React.ReactNode;
}) {
  const { workspace, canCreatePages } = useApp();
  const teamspaces = useTeamspaces(workspace.id);
  const order = useSidebarOrder(workspace.id);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ anchor: Anchor; ts: Teamspace | null } | null>(null);
  const [managing, setManaging] = useState<Teamspace | 'new' | null>(null);
  const list = teamspaces.data ?? [];
  const ids = new Set(list.map((t) => t.id));
  const toggle = (key: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const personal = order.data ?? null;

  return (
    <>
      {list.map((ts) => (
        <div key={ts.id} className="mb-2">
          <SectionHeader
            title={ts.name}
            icon={ts.icon}
            open={!closed.has(ts.id)}
            onToggle={() => toggle(ts.id)}
            actions={
              <>
                {canCreatePages && (
                  <IconButton className="size-6" title={`Add a page to ${ts.name}`} onClick={() => newTeamspacePage(workspace.id, ts.id).catch(toastError)}>
                    <Plus size={15} />
                  </IconButton>
                )}
                {canCreatePages && (
                  <IconButton className="size-6" title="Teamspace settings" onClick={() => setManaging(ts)}>
                    <MoreHorizontal size={15} />
                  </IconButton>
                )}
              </>
            }
          />
          {!closed.has(ts.id) && <PageTree expanded={expanded} setExpanded={setExpanded} roots={(p) => p.teamspaceId === ts.id} />}
        </div>
      ))}
      <div className="mb-2">
        <SectionHeader
          title={list.length ? 'Workspace' : 'Pages'}
          open={!closed.has('pages')}
          onToggle={() => toggle('pages')}
          actions={
            <>
              <IconButton className="size-6" title="Sidebar order and teamspaces" onClick={(e) => setMenu({ anchor: e.currentTarget.getBoundingClientRect(), ts: null })}>
                <ArrowDownUp size={14} />
              </IconButton>
              {addPageButton}
            </>
          }
        />
        {!closed.has('pages') && (
          <PageTree
            expanded={expanded}
            setExpanded={setExpanded}
            roots={(p: PageSummary) => !p.teamspaceId || !ids.has(p.teamspaceId)}
            personalOrder={personal}
            onPersonalOrder={(next) => saveOrder(workspace.id, next)}
          />
        )}
      </div>
      <Menu anchor={menu?.anchor ?? null} onClose={() => setMenu(null)}>
        <MenuItem label="Shared order" checked={!personal} onClick={() => saveOrder(workspace.id, null)} />
        <MenuItem label="My own order (drag to arrange)" checked={!!personal} onClick={() => !personal && saveOrder(workspace.id, [])} />
        {canCreatePages && <MenuItem icon={<Users size={15} />} label="New teamspace…" onClick={() => setManaging('new')} />}
      </Menu>
      {managing && <TeamspaceDialog teamspace={managing === 'new' ? null : managing} onClose={() => setManaging(null)} />}
    </>
  );
}

/** Making or changing a teamspace: its name, icon and members. */
function TeamspaceDialog({ teamspace, onClose }: { teamspace: Teamspace | null; onClose: () => void }) {
  const { workspace, user } = useApp();
  const members = useMembers(workspace.id, true);
  const [name, setName] = useState(teamspace?.name ?? '');
  const [icon, setIcon] = useState(teamspace?.icon ?? '👥');
  const [picked, setPicked] = useState<Set<string>>(new Set(teamspace?.memberIds ?? [user.id]));
  const [iconAt, setIconAt] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), icon, memberIds: [...picked] };
      if (teamspace) await api(`/api/teamspaces/${teamspace.id}`, { method: 'PATCH', body });
      else await api(`/api/workspaces/${workspace.id}/teamspaces`, { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: teamspacesKey(workspace.id) });
      invalidatePages(workspace.id);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!teamspace) return;
    if (!(await confirmDialog({ title: `Delete “${teamspace.name}”?`, message: 'Its pages stay, and go back to the whole workspace.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api(`/api/teamspaces/${teamspace.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: teamspacesKey(workspace.id) });
      invalidatePages(workspace.id);
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Dialog open onClose={onClose} title={teamspace ? 'Teamspace settings' : 'New teamspace'} width={460}>
      <div className="space-y-3 px-5 pb-5">
        <p className="text-sm text-muted">Pages in a teamspace are seen only by its members (and workspace owners). It gets its own section in the sidebar.</p>
        <div className="flex items-center gap-2">
          <button onClick={(e) => setIconAt(e.currentTarget.getBoundingClientRect())} className="flex size-9 items-center justify-center rounded-md border border-line text-lg hover:bg-hover">
            {icon}
          </button>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marketing, Year 12, Family" className="flex-1" />
        </div>
        <EmojiPicker anchor={iconAt} onClose={() => setIconAt(null)} onPick={setIcon} />
        <div>
          <div className="mb-1 text-xs font-medium text-faint">Members</div>
          <div className="max-h-60 overflow-y-auto rounded-md border border-line">
            {(members.data?.members ?? []).map((m) => (
              <button
                key={m.id}
                onClick={() =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  })
                }
                className="flex w-full items-center gap-2 px-2 py-1.5 text-start text-sm hover:bg-hover"
              >
                <Avatar name={m.name} color={m.color} size={22} />
                <span className="min-w-0 flex-1 truncate">
                  {m.name} <span className="text-xs text-muted">{m.email}</span>
                </span>
                {picked.has(m.id) && <Check size={14} className="text-accent" />}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between pt-1">
          {teamspace ? (
            <Button variant="ghost" onClick={remove}>
              <Trash2 size={14} /> Delete
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            {teamspace ? 'Save' : 'Create teamspace'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** "Move to teamspace" for a top-level page's ••• menu. */
export function TeamspaceMenuItems({ page }: { page: PageSummary }) {
  const { workspace, canCreatePages } = useApp();
  const teamspaces = useTeamspaces(workspace.id);
  if (!canCreatePages || page.parentId || !teamspaces.data?.length) return null;
  const move = async (teamspaceId: string | null) => {
    try {
      await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { teamspaceId } });
      invalidatePages(workspace.id, page.id);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <>
      {teamspaces.data.map((t) => (
        <MenuItem key={t.id} icon={<span className="text-sm">{t.icon ?? '👥'}</span>} label={`Move to ${t.name}`} checked={page.teamspaceId === t.id} onClick={() => move(t.id)} />
      ))}
      {page.teamspaceId && <MenuItem icon={<Users size={15} />} label="Move to the whole workspace" onClick={() => move(null)} />}
    </>
  );
}
