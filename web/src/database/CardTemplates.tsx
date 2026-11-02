import { ChevronDown, FileText, LayoutTemplate, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { type Anchor, Menu, MenuDivider, MenuItem, MenuLabel, toastError } from '../components/ui';
import { api } from '../lib/api';
import { useDb } from './context';
import { type CardTemplate, primaryField } from './model';

// The New button with card templates: start a card from a template (its properties and body), make
// and edit templates, and pick the one New uses.

/** Makes a card from a template; resolves to the new card's id once its body is in place. */
export function useNewFromTemplate() {
  const { pageId, actions } = useDb();
  return async (template: CardTemplate | null, cells: Record<string, unknown>, index?: number) => {
    if (!template) return actions.addRow(cells, index);
    const id = actions.addRow({ ...structuredClone(template.cells), ...cells }, index);
    try {
      // The body is copied before the card opens, so the two never mix.
      await api(`/api/pages/${pageId}/rows/${id}/copy`, { method: 'POST', body: { from: template.id } });
    } catch (err) {
      toastError(err);
    }
    return id;
  };
}

export function NewButton({ cells }: { cells: () => Record<string, unknown> }) {
  const { db, actions, openRow } = useDb();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const newFrom = useNewFromTemplate();
  const fallback = db.templates.find((t) => t.isDefault) ?? null;
  const pf = primaryField(db.fields);

  const create = async (template: CardTemplate | null) => openRow(await newFrom(template, cells()));
  const newTemplate = () => {
    const id = actions.addTemplate('New template', pf ? { [pf.id]: '' } : {});
    openRow(id);
  };

  return (
    <div className="ms-1 flex h-7 items-stretch overflow-hidden rounded-md bg-accent text-sm font-medium text-white">
      <button onClick={() => create(fallback)} className="flex items-center gap-1 px-2.5 hover:brightness-110" title={fallback ? `New card from “${fallback.name}”` : 'New card'}>
        <Plus size={14} /> New
      </button>
      <button onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} className="flex items-center border-s border-white/25 px-1 hover:brightness-110" title="Templates">
        <ChevronDown size={14} />
      </button>
      <Menu anchor={menu} onClose={() => setMenu(null)} align="end">
        <MenuLabel>Templates</MenuLabel>
        {db.templates.map((t) => (
          <div key={t.id} className="group flex items-center">
            <div className="min-w-0 flex-1">
              <MenuItem icon={<LayoutTemplate size={15} />} label={t.name || 'Untitled template'} hint={t.isDefault ? 'Default' : undefined} onClick={() => create(t)} />
            </div>
            <button
              onClick={() => openRow(t.id)}
              title="Edit template"
              className="me-1 rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg"
            >
              <Pencil size={13} />
            </button>
          </div>
        ))}
        {!db.templates.length && <p className="px-2.5 py-1.5 text-xs text-muted">Templates give new cards ready-made properties and content.</p>}
        <MenuItem icon={<FileText size={15} />} label="Empty card" onClick={() => create(null)} />
        <MenuDivider />
        {db.templates.length > 0 && (
          <>
            <MenuLabel>New uses</MenuLabel>
            <MenuItem label="An empty card" checked={!fallback} onClick={() => actions.setDefaultTemplate(null)} />
            {db.templates.map((t) => (
              <MenuItem key={t.id} label={t.name || 'Untitled template'} checked={t.isDefault} onClick={() => actions.setDefaultTemplate(t.id)} />
            ))}
            <MenuDivider />
          </>
        )}
        <MenuItem icon={<Plus size={15} />} label="New template" onClick={newTemplate} />
      </Menu>
    </div>
  );
}
