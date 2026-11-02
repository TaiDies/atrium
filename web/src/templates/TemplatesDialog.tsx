import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { LayoutTemplate, MoreHorizontal, Pencil, Repeat, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { type Built, buildProposal, type Proposal } from '../ai/build';
import { useApp } from '../app/context';
import { PageIcon } from '../app/PageIcon';
import { type Anchor, Button, confirmDialog, Dialog, Input, Menu, MenuDivider, MenuItem, toast, toastError } from '../components/ui';
import { api, type PageDetail, pageTitle } from '../lib/api';
import { invalidatePages } from '../lib/queries';
import { BUILTIN_TEMPLATES, type BuiltinTemplate } from './builtin';

// The template gallery (ready-made and the workspace's own), saving a page as a template, and
// making a template repeat.

export interface RepeatSettings {
  unit: 'day' | 'week' | 'month' | 'year';
  every: number;
  start: string;
  end: string | null;
}

export interface SavedTemplate {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  pageType: string;
  createdBy: string | null;
  createdByName: string | null;
  repeat: RepeatSettings | null;
  repeatParent: string | null;
  nextRun: string | null;
  size: number;
}

const templatesKey = (ws: string) => ['templates', ws];

function useTemplates(workspaceId: string) {
  return useQuery({
    queryKey: templatesKey(workspaceId),
    queryFn: async () => (await api<{ templates: SavedTemplate[] }>(`/api/workspaces/${workspaceId}/templates`)).templates,
  });
}

const UNIT_LABEL = { day: 'day', week: 'week', month: 'month', year: 'year' } as const;

export function repeatText(r: RepeatSettings) {
  return r.every === 1 ? `Every ${UNIT_LABEL[r.unit]}` : `Every ${r.every} ${UNIT_LABEL[r.unit]}s`;
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Puts a built-in template's pages under `parentId` (or at the top). */
function placed(proposal: Proposal, parentId: string | null): Proposal {
  return {
    ...proposal,
    documents: proposal.documents.map((d) => ({ ...d, parent: d.parent ?? parentId })),
    databases: (proposal.databases ?? []).map((d) => ({ ...d, parent: d.parent ?? parentId })),
  };
}

export function TemplatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspace, pages, canCreatePages, expand } = useApp();
  const { pageId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const saved = useTemplates(workspace.id);
  const [tab, setTab] = useState<'workspace' | 'builtin'>('builtin');
  const [inside, setInside] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: Anchor; t: SavedTemplate } | null>(null);
  const [repeating, setRepeating] = useState<SavedTemplate | null>(null);
  const current = pages.find((p) => p.id === pageId);
  const parentId = inside && current ? current.id : null;

  const opened = (id: string | undefined) => {
    invalidatePages(workspace.id);
    if (parentId) expand(parentId);
    onClose();
    if (id) navigate(`/w/${workspace.id}/p/${id}`);
  };

  const useBuiltin = async (t: BuiltinTemplate) => {
    setBusy(t.id);
    const made: Built = { pages: [], tasks: 0 };
    try {
      const proposal = placed(t.proposal, parentId);
      await buildProposal(
        workspace.id,
        proposal,
        { documents: new Set(proposal.documents.map((_, i) => i)), databases: new Set((proposal.databases ?? []).map((_, i) => i)), tasks: new Set() },
        pages.map((p) => ({ id: p.id, type: p.type, title: pageTitle(p) })),
        { color: 'blue', reminder: null },
        () => {},
        made,
      );
      opened(made.pages[0]?.id);
    } catch (err) {
      toastError(err);
      if (made.pages.length) invalidatePages(workspace.id);
    } finally {
      setBusy(null);
    }
  };

  const useSaved = async (t: SavedTemplate) => {
    setBusy(t.id);
    try {
      const { page } = await api<{ page: { id: string } }>(`/api/templates/${t.id}/use`, { method: 'POST', body: { parentId } });
      opened(page.id);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const rename = async (t: SavedTemplate) => {
    const name = prompt('Template name', t.name)?.trim();
    if (!name || name === t.name) return;
    try {
      await api(`/api/templates/${t.id}`, { method: 'PATCH', body: { name } });
      qc.invalidateQueries({ queryKey: templatesKey(workspace.id) });
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async (t: SavedTemplate) => {
    if (!(await confirmDialog({ title: `Delete “${t.name}”?`, message: 'Pages already made from it stay as they are.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api(`/api/templates/${t.id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: templatesKey(workspace.id) });
    } catch (err) {
      toastError(err);
    }
  };

  const list = saved.data ?? [];

  return (
    <Dialog open={open} onClose={onClose} title="Templates" width={760} maxHeight="84vh" top="8vh">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 pb-2">
        {(['builtin', 'workspace'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx('rounded-md px-2.5 py-1 text-sm', tab === t ? 'bg-active font-medium' : 'text-muted hover:bg-hover')}
          >
            {t === 'builtin' ? 'Ready-made' : `This workspace${list.length ? ` · ${list.length}` : ''}`}
          </button>
        ))}
        <div className="flex-1" />
        {current && canCreatePages && (
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={inside} onChange={(e) => setInside(e.target.checked)} />
            Add inside “{pageTitle(current)}”
          </label>
        )}
      </div>
      {!canCreatePages && <p className="mx-5 mt-3 rounded-md bg-hover px-3 py-2 text-xs text-muted">Only workspace owners add pages, so only they can use templates here.</p>}

      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
        {tab === 'builtin' &&
          BUILTIN_TEMPLATES.map((t) => (
            <div key={t.id} data-menu-scope className="flex flex-col rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">{t.icon}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted">{t.category}</span>
              </div>
              <p className="mt-1.5 flex-1 text-sm text-muted">{t.description}</p>
              <Button size="sm" className="mt-3 self-start" disabled={!canCreatePages || !!busy} loading={busy === t.id} onClick={() => useBuiltin(t)}>
                Use template
              </Button>
            </div>
          ))}
        {tab === 'workspace' && saved.isPending && <p className="text-sm text-muted">Loading…</p>}
        {tab === 'workspace' && !saved.isPending && !list.length && (
          <div className="col-span-full rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
            <LayoutTemplate size={22} className="mx-auto mb-2 text-faint" />
            No templates yet. Open a page, choose <b>•••</b> → <b>Save as template</b>, and it shows up here for everyone in the workspace.
          </div>
        )}
        {tab === 'workspace' &&
          list.map((t) => (
            <div key={t.id} className="flex flex-col rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <PageIcon page={{ icon: t.icon ?? "", type: t.pageType as PageDetail["type"] }} size={18} />
                <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                <button data-menu-button onClick={(e) => setMenu({ anchor: e.currentTarget.getBoundingClientRect(), t })} className="rounded p-1 text-muted hover:bg-hover" title="More">
                  <MoreHorizontal size={15} />
                </button>
              </div>
              {t.description && <p className="mt-1.5 text-sm text-muted">{t.description}</p>}
              <p className="mt-1.5 flex-1 text-xs text-faint">
                {t.createdByName ? `By ${t.createdByName}` : ''}
                {t.repeat && (
                  <span className="ms-1 inline-flex items-center gap-1 text-accent">
                    <Repeat size={11} /> {repeatText(t.repeat)}
                    {t.nextRun ? `, next ${t.nextRun}` : ''}
                  </span>
                )}
              </p>
              <Button size="sm" className="mt-3 self-start" disabled={!canCreatePages || !!busy} loading={busy === t.id} onClick={() => useSaved(t)}>
                Use template
              </Button>
            </div>
          ))}
      </div>

      <Menu anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} align="end">
        {menu && (
          <>
            {canCreatePages && <MenuItem icon={<Repeat size={15} />} label={menu.t.repeat ? 'Repeat settings…' : 'Repeat…'} onClick={() => setRepeating(menu.t)} />}
            <MenuItem icon={<Pencil size={15} />} label="Rename" onClick={() => rename(menu.t)} />
            <MenuDivider />
            <MenuItem icon={<Trash2 size={15} />} label="Delete" danger onClick={() => remove(menu.t)} />
          </>
        )}
      </Menu>
      {repeating && <RepeatTemplateDialog template={repeating} onClose={() => setRepeating(null)} />}
    </Dialog>
  );
}

/** Makes a template add a new page on each date of a pattern. */
function RepeatTemplateDialog({ template, onClose }: { template: SavedTemplate; onClose: () => void }) {
  const { workspace, pages } = useApp();
  const qc = useQueryClient();
  const r = template.repeat;
  const [unit, setUnit] = useState<RepeatSettings['unit']>(r?.unit ?? 'week');
  const [every, setEvery] = useState(r?.every ?? 1);
  const [start, setStart] = useState(r?.start ?? localDate());
  const [end, setEnd] = useState(r?.end ?? '');
  const [parent, setParent] = useState(template.repeatParent ?? '');
  const [busy, setBusy] = useState(false);
  const select = 'h-8 rounded-md border border-line bg-bg px-2 text-sm';

  const save = async (repeat: RepeatSettings | null) => {
    setBusy(true);
    try {
      await api(`/api/templates/${template.id}`, { method: 'PATCH', body: { repeat, repeatParent: repeat ? parent || null : null } });
      qc.invalidateQueries({ queryKey: templatesKey(workspace.id) });
      toast(repeat ? 'The template will repeat' : 'The template no longer repeats');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Repeat “${template.name}”`} width={420}>
      <div className="space-y-3 px-5 pb-5">
        <p className="text-sm text-muted">A new page is made from this template on each date, named “{template.name} — date”.</p>
        <div className="flex items-center gap-2 text-sm">
          Every
          <Input type="number" min={1} max={365} value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))} className="w-16" />
          <select value={unit} onChange={(e) => setUnit(e.target.value as RepeatSettings['unit'])} className={select}>
            {(['day', 'week', 'month', 'year'] as const).map((u) => (
              <option key={u} value={u}>
                {every === 1 ? u : `${u}s`}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 text-muted">Starting</span>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 text-muted">Until</span>
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          {end && (
            <button onClick={() => setEnd('')} className="text-xs text-muted hover:text-fg">
              Clear
            </button>
          )}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 text-muted">Add to</span>
          <select value={parent} onChange={(e) => setParent(e.target.value)} className={clsx(select, 'min-w-0 flex-1')}>
            <option value="">Top level</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {pageTitle(p)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          {r && (
            <Button variant="ghost" disabled={busy} onClick={() => save(null)}>
              Stop repeating
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={!start || (!!end && end < start)} onClick={() => save({ unit, every, start, end: end || null })}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** "Save as template" from a page's menu. */
export function SaveTemplateDialog({ page, open, onClose }: { page: PageDetail; open: boolean; onClose: () => void }) {
  const { workspace } = useApp();
  const qc = useQueryClient();
  const [name, setName] = useState(pageTitle(page));
  const [description, setDescription] = useState('');
  const [subpages, setSubpages] = useState(true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/pages/${page.id}/template`, { method: 'POST', body: { name: name.trim(), description, subpages } });
      qc.invalidateQueries({ queryKey: templatesKey(workspace.id) });
      toast('Saved as a template — find it under Templates in the sidebar');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Save as template" width={420}>
      <div className="space-y-3 px-5 pb-5">
        <p className="text-sm text-muted">Everyone in the workspace can make new pages from it. Later changes to this page don’t change the template.</p>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Name</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Description (optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={subpages} onChange={(e) => setSubpages(e.target.checked)} /> Include the pages inside it
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save template
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
