import { GitBranch, ListTree, Lock, LockOpen, MoreHorizontal, Zap } from 'lucide-react';
import { useState } from 'react';
import { type Anchor, IconButton, Menu, MenuDivider, MenuItem, toast } from '../components/ui';
import { AutomationsDialog } from './Automations';
import { useDb } from './context';

// The database's own settings: sub-items, dependencies, locking its views and properties, and automations.

export function DatabaseMenu() {
  const { db, actions, pageId } = useDb();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [automations, setAutomations] = useState(false);
  const s = db.settings;
  const has = (id: string | undefined) => !!id && db.fields.some((f) => f.id === id);
  const subOn = !!s.subItems && has(s.subItems.parentField);
  const depsOn = !!s.dependencies && has(s.dependencies.blockedByField);
  const rules = s.automations ?? [];

  const toggleSubItems = () => {
    if (subOn) return actions.setSetting('subItems', null);
    const { stored, listed } = actions.addSelfRelation(pageId, 'Parent item', 'Sub-items');
    actions.setSetting('subItems', { parentField: stored, childField: listed });
    toast('Sub-items on: right-click a row (or its ⋮⋮ menu) → Add sub-item');
  };
  const toggleDependencies = () => {
    if (depsOn) return actions.setSetting('dependencies', null);
    const { stored, listed } = actions.addSelfRelation(pageId, 'Blocked by', 'Blocking');
    actions.setSetting('dependencies', { blockedByField: stored, blockingField: listed });
    toast('Dependencies on: set “Blocked by” on a card; the timeline draws the arrows');
  };

  return (
    <>
      <IconButton className="size-7" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} title="Database settings">
        <MoreHorizontal size={16} />
      </IconButton>
      <Menu anchor={menu} onClose={() => setMenu(null)} align="end">
        <MenuItem icon={<ListTree size={15} />} label="Sub-items" hint={subOn ? 'On' : undefined} onClick={toggleSubItems} />
        <MenuItem icon={<GitBranch size={15} />} label="Dependencies" hint={depsOn ? 'On' : undefined} onClick={toggleDependencies} />
        <MenuItem icon={<Zap size={15} />} label="Automations…" hint={rules.length ? String(rules.filter((r) => r.enabled).length) : undefined} onClick={() => setAutomations(true)} />
        <MenuDivider />
        <MenuItem
          icon={s.locked ? <LockOpen size={15} /> : <Lock size={15} />}
          label={s.locked ? 'Unlock views and properties' : 'Lock views and properties'}
          onClick={() => actions.setSetting('locked', s.locked ? null : true)}
        />
      </Menu>
      {automations && <AutomationsDialog onClose={() => setAutomations(false)} />}
    </>
  );
}
