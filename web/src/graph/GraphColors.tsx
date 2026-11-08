import clsx from 'clsx';
import { Check, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input, toastError } from '../components/ui';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';

// The graph's colours mean something: pages belong to named groups ("People", "Projects",
// "Lessons"…), each with a colour and a description, listed in a legend on the graph. A page is put
// in a group by hand (right-click its dot), or a group takes pages in by rule — titles containing some
// text, or "under:Page" for the pages inside a page. Each kind of line can have a colour too.

export type LineKind = 'link' | 'child' | 'relation';
export interface GraphGroup {
  id: string;
  name: string;
  color: string;
  description: string;
  match: string;
}
export interface GraphStyle {
  links: Partial<Record<LineKind, string>>;
  groups: GraphGroup[];
}

/** The same names the server (and Claude) can use. */
export const PALETTE: { name: string; hex: string }[] = [
  { name: 'red', hex: '#ef4444' },
  { name: 'orange', hex: '#f97316' },
  { name: 'yellow', hex: '#eab308' },
  { name: 'green', hex: '#22c55e' },
  { name: 'teal', hex: '#14b8a6' },
  { name: 'blue', hex: '#3b82f6' },
  { name: 'purple', hex: '#a855f7' },
  { name: 'pink', hex: '#ec4899' },
  { name: 'gray', hex: '#9ca3af' },
];

export const LINE_KINDS: { kind: LineKind; label: string }[] = [
  { kind: 'link', label: 'Links' },
  { kind: 'child', label: 'Sub-pages' },
  { kind: 'relation', label: 'Relations' },
];

/** The group each page is in: the one it was put in, else the first whose rule it matches. */
export function pageGroups(nodes: { id: string; title: string; parentId?: string | null; group?: string | null }[], style: GraphStyle | undefined) {
  const out = new Map<string, GraphGroup>();
  const groups = style?.groups ?? [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const byTitle = new Map(nodes.map((n) => [(n.title || 'Untitled').toLowerCase(), n.id]));
  const parent = new Map(nodes.map((n) => [n.id, n.parentId ?? null]));
  const inside = (id: string, ancestor: string) => {
    for (let p = parent.get(id), i = 0; p && i < 50; p = parent.get(p), i++) if (p === ancestor) return true;
    return false;
  };
  const matches = (g: GraphGroup, n: { id: string; title: string }) => {
    const m = g.match.trim().toLowerCase();
    if (!m) return false;
    const under = /^under:\s*(.+)$/.exec(m);
    if (!under) return (n.title || 'Untitled').toLowerCase().includes(m);
    const top = byTitle.get(under[1].trim());
    return !!top && inside(n.id, top);
  };
  for (const n of nodes) {
    const g = (n.group && byId.get(n.group)) || groups.find((x) => matches(x, n));
    if (g) out.set(n.id, g);
  }
  return out;
}

export function Swatches({ value, onPick, allowNone = false }: { value: string | null | undefined; onPick: (hex: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1" dir="ltr">
      {allowNone && (
        <button
          onClick={() => onPick(null)}
          title="No colour"
          className={clsx('size-5 rounded-full border border-line bg-[linear-gradient(135deg,transparent_45%,var(--faint)_45%,var(--faint)_55%,transparent_55%)]', !value && 'ring-2 ring-accent ring-offset-1 ring-offset-surface')}
        />
      )}
      {PALETTE.map((c) => (
        <button
          key={c.name}
          onClick={() => onPick(c.hex)}
          title={c.name}
          style={{ background: c.hex }}
          className={clsx('size-5 rounded-full transition-transform hover:scale-110', value === c.hex && 'ring-2 ring-accent ring-offset-1 ring-offset-surface')}
        />
      ))}
      <label title="Any colour" className="relative size-5 cursor-pointer overflow-hidden rounded-full border border-line bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]">
        <input type="color" value={value ?? '#888888'} onChange={(e) => onPick(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  );
}

const saveStyle = async (workspaceId: string, style: GraphStyle) => {
  await api(`/api/workspaces/${workspaceId}/graph/style`, { method: 'PUT', body: style });
  await queryClient.invalidateQueries({ queryKey: ['graph', workspaceId] });
};

/** Which group one page is in (right-click or long-press its dot). */
export function PageGroupMenu({ workspaceId, style, page, onDone }: { workspaceId: string; style: GraphStyle; page: { id: string; title: string; group: string | null; shownIn: string | null }; onDone: () => void }) {
  const [name, setName] = useState('');
  const put = async (group: string | null) => {
    try {
      await api(`/api/pages/${page.id}/graph-group`, { method: 'PUT', body: { group } });
      await queryClient.invalidateQueries({ queryKey: ['graph', workspaceId] });
      onDone();
    } catch (err) {
      toastError(err);
    }
  };
  const make = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const color = PALETTE[style.groups.length % PALETTE.length].hex;
      await api(`/api/workspaces/${workspaceId}/graph/style`, { method: 'PUT', body: { ...style, groups: [...style.groups, { name: n, color, description: '', match: '' }] } });
      await put(n);
    } catch (err) {
      toastError(err);
    }
  };
  const row = (key: string, label: string, color: string | null, on: boolean, go: () => void, hint?: string) => (
    <button key={key} onClick={go} title={hint} className="atrium-menu-item flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover">
      <span className={clsx('size-3 shrink-0 rounded-full', !color && 'border border-line')} style={color ? { background: color } : undefined} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {on && <Check size={14} className="text-accent" />}
    </button>
  );
  return (
    <div className="w-64 p-1.5">
      <div className="truncate px-2 pt-1 pb-1.5 text-xs font-medium text-muted" data-no-translate>
        {page.title || 'Untitled'}
      </div>
      {style.groups.map((g) => row(g.id, g.name, g.color, page.shownIn === g.id, () => void put(g.id), g.description || undefined))}
      {row('none', 'No group', null, !page.shownIn, () => void put(null))}
      {!page.group && page.shownIn && <p className="px-2 pt-1 text-[11px] text-faint">In its group by title — pick one to choose by hand.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void make();
        }}
        className="mt-1 flex gap-1 border-t border-line px-1 pt-2"
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group…" className="h-8 min-w-0 flex-1 text-xs" />
        <button type="submit" disabled={!name.trim()} title="Make the group and put this page in it" className="rounded-md px-2 text-accent hover:bg-hover disabled:opacity-40">
          <Plus size={15} />
        </button>
      </form>
    </div>
  );
}

/** The Groups panel: what each colour means, and the colour of each kind of line. */
export function GroupsPanel({ workspaceId, style }: { workspaceId: string; style: GraphStyle }) {
  const [draft, setDraft] = useState<GraphStyle>(style);
  useEffect(() => setDraft(style), [style]);
  const save = async (next: GraphStyle) => {
    setDraft(next);
    try {
      await saveStyle(workspaceId, next);
    } catch (err) {
      toastError(err);
    }
  };
  const edit = (i: number, g: Partial<GraphGroup>) => ({ ...draft, groups: draft.groups.map((x, j) => (j === i ? { ...x, ...g } : x)) });

  return (
    <div className="max-h-[min(70vh,560px)] w-[23rem] max-w-[calc(100vw-2rem)] space-y-4 overflow-y-auto overscroll-contain p-3 text-sm">
      <section>
        <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Groups</h4>
        <p className="mb-2 text-xs text-faint">Each colour stands for a kind of page. Put a page in a group by right-clicking (or long-pressing) its dot, or let a group take pages in by title.</p>
        <div className="space-y-2.5">
          {draft.groups.map((g, i) => (
            <div key={g.id || i} className="space-y-1.5 rounded-lg border border-line p-2" style={{ borderInlineStartColor: g.color, borderInlineStartWidth: 3 }}>
              <div className="flex items-center gap-1.5">
                <Input
                  value={g.name}
                  onChange={(e) => setDraft(edit(i, { name: e.target.value }))}
                  onBlur={() => void save(draft)}
                  placeholder="Name, e.g. People"
                  className="h-8 min-w-0 flex-1 text-sm font-medium"
                />
                <button onClick={() => void save({ ...draft, groups: draft.groups.filter((_, j) => j !== i) })} title="Remove group" className="rounded p-1.5 text-faint hover:bg-hover hover:text-red-500">
                  <Trash2 size={14} />
                </button>
              </div>
              <Input
                value={g.description}
                onChange={(e) => setDraft(edit(i, { description: e.target.value }))}
                onBlur={() => void save(draft)}
                placeholder="What it means (shown in the legend)"
                className="h-8 text-xs"
              />
              <Swatches value={g.color} onPick={(c) => c && void save(edit(i, { color: c }))} />
              <Input
                value={g.match}
                onChange={(e) => setDraft(edit(i, { match: e.target.value }))}
                onBlur={() => void save(draft)}
                placeholder="Also take in: title contains… or under:Page"
                className="h-7 text-xs"
              />
            </div>
          ))}
          <button
            onClick={() => setDraft({ ...draft, groups: [...draft.groups, { id: '', name: '', color: PALETTE[draft.groups.length % PALETTE.length].hex, description: '', match: '' }] })}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-hover"
          >
            <Plus size={13} /> New group
          </button>
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Lines</h4>
        <div className="space-y-2">
          {LINE_KINDS.map(({ kind, label }) => (
            <div key={kind} className="flex items-center justify-between gap-2">
              <span className="w-20 shrink-0">{label}</span>
              <Swatches allowNone value={draft.links[kind]} onPick={(c) => void save({ ...draft, links: { ...draft.links, [kind]: c ?? undefined } })} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** The legend: what each colour means, how many pages it has; hover to light a group up, click to keep it lit. */
export function Legend({
  style,
  counts,
  pinned,
  onHover,
  onPin,
}: {
  style: GraphStyle;
  counts: Map<string, number>;
  pinned: string | null;
  onHover: (id: string | null) => void;
  onPin: (id: string | null) => void;
}) {
  const lines = LINE_KINDS.filter((l) => style.links[l.kind]);
  if (!style.groups.length && !lines.length) return null;
  return (
    <div className="absolute start-3 bottom-11 max-h-[45%] w-52 overflow-y-auto rounded-lg border border-line bg-surface/85 p-1.5 text-xs shadow-sm backdrop-blur">
      {style.groups.map((g) => (
        <button
          key={g.id}
          onMouseEnter={() => onHover(g.id)}
          onMouseLeave={() => onHover(null)}
          onClick={() => onPin(pinned === g.id ? null : g.id)}
          title={g.description || undefined}
          className={clsx('flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start hover:bg-hover', pinned === g.id && 'bg-hover')}
        >
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: g.color, boxShadow: pinned === g.id ? `0 0 0 3px ${g.color}40` : undefined }} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-fg" data-no-translate>
              {g.name}
            </span>
            {g.description && (
              <span className="block truncate text-[10.5px] text-faint" data-no-translate>
                {g.description}
              </span>
            )}
          </span>
          <span className="text-faint">{counts.get(g.id) ?? 0}</span>
        </button>
      ))}
      {lines.length > 0 && (
        <div className={clsx('space-y-1 px-1.5 py-1', style.groups.length > 0 && 'mt-1 border-t border-line pt-1.5')}>
          {lines.map((l) => (
            <div key={l.kind} className="flex items-center gap-2 text-muted">
              <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: style.links[l.kind] }} />
              {l.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
