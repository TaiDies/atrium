import clsx from 'clsx';
import { Check, Search } from 'lucide-react';
import { useState } from 'react';
import { type Anchor, Avatar, Popover, toast } from '../components/ui';
import { useDirectory } from '../lib/directory';
import { useDb } from './context';
import { type Field, newId, type Row, todayISO } from './model';

// People in cells (person, created by, last edited by) and button properties.

/** Avatars (and names, when there's room) for a list of user ids. */
export function PeopleValue({ ids, compact }: { ids: unknown; compact?: boolean }) {
  const dir = useDirectory();
  const list = Array.isArray(ids) ? (ids as string[]) : typeof ids === 'string' && ids ? [ids] : [];
  if (!list.length) return null;
  const members = dir?.members ?? [];
  const people = list.map((id) => members.find((m) => m.id === id) ?? { id, name: id === dir?.user.id ? dir.user.name : 'Former member', color: '#868e96' });
  if (compact && people.length > 1) {
    return (
      <span className="flex -space-x-1.5" title={people.map((p) => p.name).join(', ')}>
        {people.slice(0, 4).map((p) => (
          <Avatar key={p.id} name={p.name} color={p.color} size={20} className="ring-2 ring-bg" />
        ))}
        {people.length > 4 && <span className="ps-2 text-xs text-muted">+{people.length - 4}</span>}
      </span>
    );
  }
  return (
    <span className={clsx('flex min-w-0 gap-x-2 gap-y-1', compact ? 'overflow-hidden' : 'flex-wrap')}>
      {people.map((p) => (
        <span key={p.id} className="inline-flex min-w-0 items-center gap-1.5 text-sm">
          <Avatar name={p.name} color={p.color} size={20} />
          <span className="truncate">{p.name}</span>
        </span>
      ))}
    </span>
  );
}

/** Choosing the people in a person property. */
export function PersonPicker({ anchor, onClose, selected, onChange }: { anchor: Anchor | null; onClose: () => void; selected: string[]; onChange: (ids: string[]) => void }) {
  const dir = useDirectory();
  const [q, setQ] = useState('');
  const members = (dir?.members ?? []).filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose} className="w-72 p-1.5">
      <div className="mb-1 flex items-center gap-2 rounded-md border border-line px-2">
        <Search size={13} className="text-faint" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" className="h-8 flex-1 bg-transparent text-sm outline-none" />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {members.map((m) => {
          const on = selected.includes(m.id);
          return (
            <button
              key={m.id}
              onClick={() => onChange(on ? selected.filter((x) => x !== m.id) : [...selected, m.id])}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover"
            >
              <Avatar name={m.name} color={m.color} size={22} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{m.name}</span>
                <span className="block truncate text-xs text-muted">{m.email}</span>
              </span>
              {on && <Check size={14} className="text-accent" />}
            </button>
          );
        })}
        {!members.length && <p className="px-2 py-3 text-xs text-muted">No one found.</p>}
      </div>
    </Popover>
  );
}

/** What "@today", "@now" and "@me" mean when a button runs. */
function fill(value: unknown, field: Field | undefined, me: string | undefined): unknown {
  if (value === '@today') return todayISO();
  if (value === '@now') return todayISO();
  if (value === '@me') return field?.type === 'person' ? (me ? [me] : []) : me;
  return value;
}

/** A button property: runs its actions on this card. */
export function ButtonCell({ field, row }: { field: Field; row: Row }) {
  const { db, actions, readOnly } = useDb();
  const dir = useDirectory();
  const config = field.button;
  const run = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (readOnly) return toast('You can only view this page');
    if (!config?.actions.length) return toast('This button does nothing yet — set it up from the property’s menu');
    for (const action of config.actions) {
      if (action.type === 'url' && action.url) {
        window.open(/^https?:\/\//i.test(action.url) ? action.url : `https://${action.url}`, '_blank', 'noopener');
      } else if (action.type === 'set') {
        const target = db.fields.find((f) => f.id === action.fieldId);
        if (!target) continue;
        let value = fill(action.value, target, dir?.user.id);
        // Checklists and people are added to rather than replaced.
        if (target.type === 'person' && Array.isArray(value)) {
          const current = Array.isArray(row.cells[target.id]) ? (row.cells[target.id] as string[]) : [];
          value = [...new Set([...current, ...(value as string[])])];
        }
        if (target.type === 'checklist' && typeof value === 'string') {
          const current = Array.isArray(row.cells[target.id]) ? (row.cells[target.id] as unknown[]) : [];
          value = [...current, { id: newId(), text: value, done: false }];
        }
        actions.updateCell(row.id, target.id, value);
      }
    }
  };
  return (
    <button onClick={run} className="max-w-full truncate rounded-md border border-line bg-bg px-2 py-0.5 text-xs font-medium hover:bg-hover">
      {config?.label || field.name}
    </button>
  );
}
