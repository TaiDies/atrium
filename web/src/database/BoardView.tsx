import clsx from 'clsx';
import { ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useDirectory } from '../lib/directory';
import { useRef, useState } from 'react';
import { type Anchor, confirmDialog, IconButton, Menu, MenuDivider, MenuItem, MenuLabel } from '../components/ui';
import { CellDisplay } from './cells';
import { useDb } from './context';
import { ScrollX } from './ScrollX';
import { type Field, isEmptyValue, OPTION_COLORS, type Row, rowTitle, type SelectOption, type View, viewRows } from './model';

interface Group {
  id: string | null;
  option: SelectOption | null;
  rows: Row[];
}

interface Lane {
  key: string;
  label: string;
  color: string | null;
  rows: Row[];
  /** What a card dropped into this lane gets. */
  patch: Record<string, unknown>;
}

/** Swimlanes: the board split into rows by a second property. */
function lanesFor(field: Field | undefined, rows: Row[], members: { id: string; name: string }[]): Lane[] | null {
  if (!field) return null;
  if (field.type === 'select') {
    return [
      ...(field.options ?? []).map((o) => ({ key: o.id, label: o.name || 'Untitled', color: OPTION_COLORS[o.color] ?? null, rows: rows.filter((r) => r.cells[field.id] === o.id), patch: { [field.id]: o.id } })),
      { key: '__none', label: `No ${field.name}`, color: null, rows: rows.filter((r) => !field.options?.some((o) => o.id === r.cells[field.id])), patch: { [field.id]: null } },
    ];
  }
  if (field.type === 'checkbox') {
    return [
      { key: 'yes', label: field.name, color: null, rows: rows.filter((r) => !!r.cells[field.id]), patch: { [field.id]: true } },
      { key: 'no', label: `Not ${field.name.toLowerCase()}`, color: null, rows: rows.filter((r) => !r.cells[field.id]), patch: { [field.id]: false } },
    ];
  }
  if (field.type === 'person') {
    const people = (r: Row) => (Array.isArray(r.cells[field.id]) ? (r.cells[field.id] as string[]) : []);
    const ids = [...new Set(rows.flatMap(people))];
    return [
      ...ids.map((id) => ({ key: id, label: members.find((m) => m.id === id)?.name ?? 'Former member', color: null, rows: rows.filter((r) => people(r)[0] === id), patch: { [field.id]: [id] } })),
      { key: '__none', label: 'Nobody', color: null, rows: rows.filter((r) => !people(r).length), patch: { [field.id]: [] } },
    ];
  }
  return null;
}

export function BoardView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, locked } = useDb();
  const dir = useDirectory();
  const field = db.fields.find((f) => f.id === view.groupBy && f.type === 'select');
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [target, setTarget] = useState<{ lane: string; group: string | null; index: number } | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [groupTarget, setGroupTarget] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!field) {
    return (
      <div className={clsx('py-12 text-center text-sm text-muted', !embedded && 'px-6')}>
        Choose a single-select property to group cards by, using <b>Group</b> in the toolbar.
      </div>
    );
  }

  const rows = viewRows(db, view);
  const subField = db.fields.find((f) => f.id === view.subGroupBy && f.id !== field.id);
  const lanes = lanesFor(subField, rows, dir?.members ?? []) ?? [{ key: '__all', label: '', color: null, rows, patch: {} }];
  const groupsOf = (laneRows: Row[]): Group[] => [
    { id: null, option: null, rows: laneRows.filter((r) => !field.options?.some((o) => o.id === r.cells[field.id])) },
    ...(field.options ?? []).map((o) => ({ id: o.id, option: o, rows: laneRows.filter((r) => r.cells[field.id] === o.id) })),
  ];
  const cardFields = db.fields.filter((f) => !f.primary && f.id !== field.id && f.id !== subField?.id && !view.hidden.includes(f.id));

  const drop = () => {
    const lane = target && lanes.find((l) => l.key === target.lane);
    if (dragCard && target && lane) {
      const group = groupsOf(lane.rows).find((g) => g.id === target.group)!;
      const others = group.rows.filter((r) => r.id !== dragCard);
      const before = others[target.index];
      const last = others[others.length - 1];
      const index = before
        ? db.rows.findIndex((r) => r.id === before.id)
        : last
          ? db.rows.findIndex((r) => r.id === last.id) + 1
          : db.rows.length;
      actions.moveRow(dragCard, index, { [field.id]: target.group, ...lane.patch });
    }
    setDragCard(null);
    setTarget(null);
  };

  const board = (lane: Lane, first: boolean) => {
    const groups = groupsOf(lane.rows);
    return (
      <div className="flex items-start gap-3">
        {groups.map((g, gi) => (
          <div
            key={g.id ?? 'none'}
            className="relative"
            onDragOver={(e) => {
              if (!dragGroup || g.id === null) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setGroupTarget(e.clientX < rect.left + rect.width / 2 ? gi - 1 : gi);
            }}
            onDrop={(e) => {
              if (!dragGroup || groupTarget === null) return;
              e.preventDefault();
              actions.moveOption(field.id, dragGroup, groupTarget);
              setDragGroup(null);
              setGroupTarget(null);
            }}
          >
            {dragGroup && groupTarget === gi - 1 && g.id !== null && <div className="absolute top-0 -start-2 h-full w-0.5 rounded bg-accent" />}
            <Column
              field={field}
              group={g}
              cardFields={cardFields}
              lanePatch={lane.patch}
              showHeader={first}
              dimmed={dragGroup === g.id}
              onGroupDragStart={() => g.id && setDragGroup(g.id)}
              onDragEnd={() => {
                setDragCard(null);
                setTarget(null);
                setDragGroup(null);
                setGroupTarget(null);
              }}
              dragCard={dragCard}
              targetIndex={target?.lane === lane.key && target.group === g.id ? target.index : null}
              onCardDragStart={setDragCard}
              onTarget={(index) => dragCard && setTarget({ lane: lane.key, group: g.id, index })}
              onDrop={drop}
            />
          </div>
        ))}
        {first && !locked && <AddGroup onAdd={(name) => actions.addOption(field.id, name)} />}
      </div>
    );
  };

  return (
    <ScrollX className={clsx('pt-3 pb-8', !embedded && 'px-6 sm:px-[54px]')}>
      {lanes.length === 1 && lanes[0].key === '__all' ? (
        <div className="min-h-[40vh]">{board(lanes[0], true)}</div>
      ) : (
        <div className="space-y-2">
          {lanes.map((lane, i) => (
            <div key={lane.key} className="rounded-xl border border-line/70">
              <button
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c);
                    if (next.has(lane.key)) next.delete(lane.key);
                    else next.add(lane.key);
                    return next;
                  })
                }
                className="sticky start-0 flex items-center gap-2 px-3 py-2 text-sm font-medium"
              >
                <ChevronRight size={14} className={clsx('text-faint transition-transform', !collapsed.has(lane.key) && 'rotate-90')} />
                <span className="rounded-md px-1.5 py-0.5" style={lane.color ? { background: lane.color } : undefined}>
                  {lane.label}
                </span>
                <span className="text-xs text-faint">{lane.rows.length}</span>
              </button>
              {!collapsed.has(lane.key) && <div className="px-1.5 pb-2">{board(lane, i === 0)}</div>}
            </div>
          ))}
        </div>
      )}
    </ScrollX>
  );
}

function Column({
  field,
  group,
  cardFields,
  lanePatch,
  showHeader,
  dimmed,
  onGroupDragStart,
  onDragEnd,
  dragCard,
  targetIndex,
  onCardDragStart,
  onTarget,
  onDrop,
}: {
  field: Field;
  group: Group;
  cardFields: Field[];
  lanePatch: Record<string, unknown>;
  /** Swimlanes repeat the columns; only the top lane can rearrange them. */
  showHeader: boolean;
  dimmed: boolean;
  onGroupDragStart: () => void;
  onDragEnd: () => void;
  dragCard: string | null;
  targetIndex: number | null;
  onCardDragStart: (id: string) => void;
  onTarget: (index: number) => void;
  onDrop: () => void;
}) {
  const { db, actions, openRow, locked } = useDb();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState<'top' | 'bottom' | null>(null);
  const color = group.option ? OPTION_COLORS[group.option.color] ?? OPTION_COLORS.gray : 'transparent';
  const pf = db.fields.find((f) => f.primary) ?? db.fields[0];

  const addCard = (title: string, where: 'top' | 'bottom') => {
    const cells: Record<string, unknown> = { [pf.id]: title, ...lanePatch };
    if (group.id) cells[field.id] = group.id;
    const index = where === 'top' && group.rows[0] ? db.rows.findIndex((r) => r.id === group.rows[0].id) : undefined;
    actions.addRow(cells, index);
  };

  return (
    <div
      className={clsx('flex w-[260px] shrink-0 flex-col rounded-xl p-1.5 transition-opacity', dimmed && 'opacity-40')}
      onDragOver={(e) => {
        if (!dragCard) return;
        e.preventDefault();
        if (targetIndex === null) onTarget(group.rows.length);
      }}
      onDrop={(e) => {
        if (!dragCard) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop();
      }}
    >
      <div
        draggable={!!group.id && !renaming && showHeader}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', group.id ?? '');
          onGroupDragStart();
        }}
        onDragEnd={onDragEnd}
        data-menu-scope
        className={clsx('group mb-1 flex h-8 items-center gap-1.5 px-1', group.id && showHeader && 'cursor-grab active:cursor-grabbing')}
      >
        {renaming && group.option ? (
          <input
            autoFocus
            defaultValue={group.option.name}
            onBlur={(e) => {
              if (e.target.value.trim()) actions.updateOption(field.id, group.option!.id, { name: e.target.value.trim() });
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="h-7 min-w-0 flex-1 rounded border border-accent bg-bg px-2 text-sm outline-none"
          />
        ) : (
          <span className="flex min-w-0 items-center rounded-md px-1.5 py-0.5 text-sm font-medium" style={{ background: color }} onDoubleClick={() => group.option && setRenaming(true)}>
            <span className="truncate">{group.option ? group.option.name || 'Untitled' : `No ${field.name}`}</span>
          </span>
        )}
        <span className="text-xs text-faint">{group.rows.length}</span>
        <div className="ms-auto flex hover-reveal opacity-0 transition-opacity group-hover:opacity-100">
          {group.option && !locked && (
            <IconButton data-menu-button className="size-6" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} title="Group options">
              <MoreHorizontal size={15} />
            </IconButton>
          )}
          <IconButton className="size-6" onClick={() => setAdding('top')} title="New card at the top">
            <Plus size={15} />
          </IconButton>
        </div>
      </div>

      {adding === 'top' && <NewCardInput onAdd={(t) => addCard(t, 'top')} onClose={() => setAdding(null)} />}

      <div className="flex flex-col gap-1.5">
        {group.rows.map((row, i) => (
          <div
            key={row.id}
            className="relative"
            onDragOver={(e) => {
              if (!dragCard) return;
              e.preventDefault();
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              onTarget(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
            }}
          >
            {targetIndex === i && <DropLine className="-top-1" />}
            {targetIndex === i + 1 && i === group.rows.length - 1 && <DropLine className="-bottom-1" />}
            <Card row={row} fields={cardFields} dragging={dragCard === row.id} onDragStart={() => onCardDragStart(row.id)} onDragEnd={onDragEnd} onOpen={() => openRow(row.id)} />
          </div>
        ))}
        {group.rows.length === 0 && targetIndex === 0 && <DropLine className="relative" />}
      </div>

      {adding === 'bottom' ? (
        <NewCardInput onAdd={(t) => addCard(t, 'bottom')} onClose={() => setAdding(null)} />
      ) : (
        <button onClick={() => setAdding('bottom')} className="mt-1 flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-fg">
          <Plus size={15} /> New
        </button>
      )}

      <Menu anchor={menu} onClose={() => setMenu(null)}>
        {group.option && (
          <>
            <MenuItem icon={<Pencil size={15} />} label="Rename" onClick={() => setRenaming(true)} />
            <MenuDivider />
            <MenuLabel>Color</MenuLabel>
            <div className="grid grid-cols-5 gap-1.5 px-2 pb-2">
              {Object.entries(OPTION_COLORS).map(([key, bg]) => (
                <button
                  key={key}
                  title={key}
                  onClick={() => actions.updateOption(field.id, group.option!.id, { color: key })}
                  className={clsx('h-5 rounded', group.option!.color === key && 'ring-2 ring-accent')}
                  style={{ background: bg }}
                />
              ))}
            </div>
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={15} />}
              label="Delete group"
              danger
              onClick={async () => {
                const opt = group.option!;
                if (
                  group.rows.length === 0 ||
                  (await confirmDialog({ title: `Delete “${opt.name}”?`, message: `Its ${group.rows.length} card(s) will move to “No ${field.name}”.`, confirmLabel: 'Delete', danger: true }))
                ) {
                  actions.deleteOption(field.id, opt.id);
                }
              }}
            />
          </>
        )}
      </Menu>
    </div>
  );
}

function Card({ row, fields, dragging, onDragStart, onDragEnd, onOpen }: { row: Row; fields: Field[]; dragging: boolean; onDragStart: () => void; onDragEnd: () => void; onOpen: () => void }) {
  const { db } = useDb();
  const title = rowTitle(db.fields, row);
  const props = fields.filter((f) => f.type === 'created_time' || f.type === 'last_edited' || !isEmptyValue(row.cells[f.id]));
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={clsx(
        'cursor-pointer rounded-lg border border-line bg-card px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:border-faint/60',
        dragging && 'opacity-40',
      )}
    >
      <div className={clsx('text-sm font-medium break-words', !title && 'text-faint')}>{title || 'Untitled'}</div>
      {props.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {props.map((f) => (
            <div key={f.id} className="flex min-w-0">
              <CellDisplay field={f} row={row} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DropLine({ className }: { className?: string }) {
  return <div className={clsx('pointer-events-none absolute end-0 start-0 h-0.5 rounded bg-accent', className)} />;
}

function NewCardInput({ onAdd, onClose }: { onAdd: (title: string) => void; onClose: () => void }) {
  const [value, setValue] = useState('');
  const closed = useRef(false);
  return (
    <input
      autoFocus
      value={value}
      placeholder="Card title…"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) {
          onAdd(value.trim());
          setValue('');
        }
        if (e.key === 'Escape') {
          closed.current = true;
          onClose();
        }
      }}
      onBlur={() => {
        if (closed.current) return;
        if (value.trim()) onAdd(value.trim());
        onClose();
      }}
      className="my-1 h-9 w-full rounded-lg border border-accent bg-card px-3 text-sm outline-none"
    />
  );
}

function AddGroup({ onAdd }: { onAdd: (name: string) => void }) {
  const [adding, setAdding] = useState(false);
  if (adding) {
    return (
      <div className="w-[260px] shrink-0 p-1.5">
        <input
          autoFocus
          placeholder="Group name…"
          onKeyDown={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (e.key === 'Enter' && v) {
              onAdd(v);
              setAdding(false);
            }
            if (e.key === 'Escape') setAdding(false);
          }}
          onBlur={(e) => {
            if (e.target.value.trim()) onAdd(e.target.value.trim());
            setAdding(false);
          }}
          className="h-8 w-full rounded-md border border-accent bg-bg px-2 text-sm outline-none"
        />
      </div>
    );
  }
  return (
    <button onClick={() => setAdding(true)} className="flex h-9 w-[200px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:bg-hover hover:text-fg">
      <Plus size={15} /> New group
    </button>
  );
}
