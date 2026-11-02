import clsx from 'clsx';
import { Check, Search } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../app/context';
import { Avatar } from '../components/ui';
import { useMembers } from '../lib/queries';

/** Picking people from the workspace (yourself left out). */
export function PeoplePicker({ value, onChange, single = false, exclude = [] }: { value: string[]; onChange: (ids: string[]) => void; single?: boolean; exclude?: string[] }) {
  const { workspace, user } = useApp();
  const members = useMembers(workspace.id);
  const [q, setQ] = useState('');
  const people = (members.data?.members ?? []).filter((m) => m.id !== user.id && !exclude.includes(m.id) && `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) => onChange(single ? [id] : value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="rounded-lg border border-line">
      <label className="flex items-center gap-2 border-b border-line px-2.5">
        <Search size={14} className="text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find people" className="h-9 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <div className="max-h-52 overflow-y-auto p-1">
        {people.length === 0 && <p className="p-2 text-sm text-muted">No one else here yet.</p>}
        {people.map((m) => (
          <button key={m.id} type="button" onClick={() => toggle(m.id)} className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover', value.includes(m.id) && 'bg-accent/10')}>
            <Avatar name={m.name} color={m.color} size={22} />
            <span className="min-w-0 flex-1">
              <span className="block truncate" data-no-translate>
                {m.name}
              </span>
              <span className="block truncate text-xs text-faint">{m.email}</span>
            </span>
            {value.includes(m.id) && <Check size={15} className="text-accent" />}
          </button>
        ))}
      </div>
    </div>
  );
}
