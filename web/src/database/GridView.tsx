import clsx from 'clsx';
import { ArrowDownToLine, ArrowUpToLine, ChevronRight, Copy, CornerDownRight, GripVertical, Maximize2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { type Anchor, Menu, MenuDivider, MenuItem } from '../components/ui';
import { type CalcFn, calcLabel, calcsFor, calculate } from './calcs';
import { CellEditor, FieldIcon } from './cells';
import { useDb } from './context';
import { ScrollX } from './ScrollX';
import { FieldMenu, NewFieldMenu } from './FieldMenu';
import { type Field, type Row, type View, viewRows, fieldKind } from './model';

const GUTTER = 44;

export function GridView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, openRow, readOnly, locked } = useDb();
  const fields = db.fields.filter((f) => f.primary || !view.hidden.includes(f.id));
  const [calcMenu, setCalcMenu] = useState<{ field: Field; anchor: Anchor } | null>(null);
  const rows = viewRows(db, view);
  const [fieldMenu, setFieldMenu] = useState<{ field: Field; anchor: Anchor } | null>(null);
  const [newField, setNewField] = useState<Anchor | null>(null);
  const [rowMenu, setRowMenu] = useState<{ row: Row; anchor: Anchor } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number | null } | null>(null);
  const [colDrag, setColDrag] = useState<{ id: string; over: number | null } | null>(null);
  const manualOrder = view.sorts.length === 0;
  const width = GUTTER + fields.reduce((sum, f) => sum + (f.width ?? 180), 0) + 120;

  const globalIndex = (row: Row) => db.rows.findIndex((r) => r.id === row.id);

  // Sub-items: cards with a parent show under it (folded until opened).
  const sub = db.settings.subItems && db.fields.some((f) => f.id === db.settings.subItems!.parentField) ? db.settings.subItems : null;
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const display = useMemo(() => {
    if (!sub) return rows.map((row) => ({ row, depth: 0, kids: 0 }));
    const visible = new Set(rows.map((r) => r.id));
    const parentOf = (r: Row) => {
      const v = r.cells[sub.parentField];
      const p = Array.isArray(v) && v.length ? String(v[0]) : null;
      return p && p !== r.id && visible.has(p) ? p : null;
    };
    const kids = new Map<string, Row[]>();
    for (const r of rows) {
      const p = parentOf(r);
      if (p) kids.set(p, [...(kids.get(p) ?? []), r]);
    }
    const out: { row: Row; depth: number; kids: number }[] = [];
    const placed = new Set<string>();
    const walk = (r: Row, depth: number) => {
      if (placed.has(r.id)) return;
      placed.add(r.id);
      out.push({ row: r, depth, kids: kids.get(r.id)?.length ?? 0 });
      if (unfolded.has(r.id)) for (const c of kids.get(r.id) ?? []) walk(c, depth + 1);
    };
    for (const r of rows) if (!parentOf(r)) walk(r, 0);
    return out;
  }, [rows, sub, unfolded]);
  const toggleFold = (id: string) =>
    setUnfolded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ScrollX className={clsx('pb-6', !embedded && 'px-6 sm:px-[54px]')}>
      <div style={{ minWidth: width }} className="text-sm">
        {/* Header */}
        <div className="flex border-b border-line" style={{ paddingLeft: GUTTER }}>
          {fields.map((f, i) => (
            <div
              key={f.id}
              className={clsx('relative shrink-0 border-e border-line', colDrag?.over === i && 'shadow-[inset_2px_0_0_var(--accent)]')}
              style={{ width: f.width ?? 180 }}
              onDragOver={(e) => {
                if (!colDrag) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setColDrag({ ...colDrag, over: e.clientX < rect.left + rect.width / 2 ? i : i + 1 });
              }}
              onDrop={(e) => {
                if (!colDrag || colDrag.over === null) return;
                e.preventDefault();
                const target = fields[colDrag.over] ?? null;
                const index = target ? db.fields.findIndex((x) => x.id === target.id) : db.fields.length;
                actions.moveField(colDrag.id, Math.max(1, index));
                setColDrag(null);
              }}
            >
              <button
                draggable={!f.primary && !locked}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', f.id);
                  setColDrag({ id: f.id, over: null });
                }}
                onDragEnd={() => setColDrag(null)}
                onClick={(e) => !locked && setFieldMenu({ field: f, anchor: e.currentTarget.getBoundingClientRect() })}
                className="flex h-9 w-full items-center gap-1.5 px-2 text-start text-muted hover:bg-hover"
              >
                <FieldIcon type={fieldKind(f)} />
                <span className="truncate font-medium">{f.name}</span>
              </button>
              {!locked && <ResizeHandle field={f} />}
            </div>
          ))}
          {!locked && (
            <button onClick={(e) => setNewField(e.currentTarget.getBoundingClientRect())} className="flex h-9 w-10 shrink-0 items-center justify-center text-muted hover:bg-hover" title="New property">
              <Plus size={15} />
            </button>
          )}
        </div>

        {/* Rows */}
        {display.map(({ row, depth, kids }, i) => (
          <div
            key={row.id}
            onContextMenu={(e) => {
              e.preventDefault();
              setRowMenu({ row, anchor: { x: e.clientX, y: e.clientY } });
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setDrag({ ...drag, over: e.clientY < rect.top + rect.height / 2 ? i : i + 1 });
            }}
            onDrop={(e) => {
              if (!drag || drag.over === null) return;
              e.preventDefault();
              const target = display[drag.over]?.row;
              actions.moveRow(drag.id, target ? globalIndex(target) : db.rows.length);
              setDrag(null);
            }}
            className={clsx(
              'group relative flex border-b border-line hover:bg-hover/60',
              drag?.id === row.id && 'opacity-40',
              drag?.over === i && 'shadow-[inset_0_2px_0_var(--accent)]',
              drag?.over === i + 1 && i === display.length - 1 && 'shadow-[inset_0_-2px_0_var(--accent)]',
            )}
          >
            <div className="flex shrink-0 items-center justify-end gap-0.5 pe-1 hover-reveal opacity-0 group-hover:opacity-100" style={{ width: GUTTER }}>
              <button
                onClick={() => actions.addRow({}, globalIndex(row) + 1)}
                className="rounded p-0.5 text-faint hover:bg-active hover:text-fg"
                title="Insert a row below"
              >
                <Plus size={14} />
              </button>
              <button
                draggable={manualOrder}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', row.id);
                  setDrag({ id: row.id, over: null });
                }}
                onDragEnd={() => setDrag(null)}
                onClick={(e) => setRowMenu({ row, anchor: e.currentTarget.getBoundingClientRect() })}
                className={clsx('rounded p-0.5 text-faint hover:bg-active hover:text-fg', manualOrder && 'cursor-grab')}
                title={manualOrder ? 'Drag to move, click for options' : 'Row options'}
              >
                <GripVertical size={14} />
              </button>
            </div>
            {fields.map((f) => (
              <div key={f.id} className="relative flex shrink-0 items-start border-e border-line" style={{ width: f.width ?? 180 }}>
                {f.primary && sub && (
                  <div className="flex h-8 shrink-0 items-center justify-end" style={{ width: depth * 18 + 22 }}>
                    {kids > 0 && (
                      <button onClick={() => toggleFold(row.id)} className="rounded p-0.5 text-faint hover:bg-active hover:text-fg" title={unfolded.has(row.id) ? 'Hide sub-items' : `Show ${kids} sub-item${kids === 1 ? '' : 's'}`}>
                        <ChevronRight size={14} className={clsx('transition-transform', unfolded.has(row.id) && 'rotate-90')} />
                      </button>
                    )}
                  </div>
                )}
                <CellEditor field={f} row={row} variant="grid" />
                {f.primary && (
                  <button
                    onClick={() => openRow(row.id)}
                    className="hover-reveal-flex absolute top-1 end-1 hidden items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-muted shadow-sm group-hover:flex hover:text-fg"
                  >
                    <Maximize2 size={11} /> Open
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}

        <button
          onClick={() => actions.addRow()}
          className="flex h-9 w-full items-center gap-1.5 border-b border-line text-start text-muted hover:bg-hover"
          style={{ paddingLeft: GUTTER + 8 }}
        >
          <Plus size={15} /> New row
        </button>
        {/* Totals: a calculation under each column, chosen per view. */}
        <div className="flex h-8 items-stretch text-xs text-faint" style={{ paddingLeft: GUTTER }}>
          {fields.map((f, i) => {
            const fn = view.calcs[f.id] as CalcFn | undefined;
            return (
              <button
                key={f.id}
                disabled={locked || !calcsFor(f).length}
                onClick={(e) => setCalcMenu({ field: f, anchor: e.currentTarget.getBoundingClientRect() })}
                className="group/calc flex shrink-0 items-center justify-end gap-1.5 truncate px-2 hover:bg-hover disabled:hover:bg-transparent"
                style={{ width: f.width ?? 180 }}
              >
                {fn ? (
                  <>
                    <span className="truncate">{calcLabel(fn)}</span>
                    <span className="font-medium text-muted">{calculate(fn, f, rows)}</span>
                  </>
                ) : i === 0 ? (
                  <span className="me-auto">
                    Count <span className="ms-1 text-muted">{rows.length}</span>
                    {rows.length !== db.rows.length && <span className="ms-1">of {db.rows.length}</span>}
                  </span>
                ) : (
                  !locked && <span className="opacity-0 group-hover/calc:opacity-100">Calculate</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <Menu anchor={calcMenu?.anchor ?? null} onClose={() => setCalcMenu(null)}>
        {calcMenu && (
          <>
            <MenuItem
              label="None"
              checked={!view.calcs[calcMenu.field.id]}
              onClick={() => {
                const { [calcMenu.field.id]: _, ...rest } = view.calcs;
                actions.updateView(view.id, { calcs: rest });
              }}
            />
            {calcsFor(calcMenu.field).map((c) => (
              <MenuItem key={c.fn} label={c.label} checked={view.calcs[calcMenu.field.id] === c.fn} onClick={() => actions.updateView(view.id, { calcs: { ...view.calcs, [calcMenu.field.id]: c.fn } })} />
            ))}
          </>
        )}
      </Menu>
      <FieldMenu field={fieldMenu?.field ?? null} view={view} anchor={fieldMenu?.anchor ?? null} onClose={() => setFieldMenu(null)} />
      <NewFieldMenu anchor={newField} onClose={() => setNewField(null)} onCreate={(type, name, extra) => actions.addField(type, name, undefined, extra)} />
      <Menu anchor={rowMenu?.anchor ?? null} onClose={() => setRowMenu(null)}>
        {rowMenu && (
          <>
            <MenuItem icon={<Maximize2 size={15} />} label="Open" onClick={() => openRow(rowMenu.row.id)} />
            <MenuItem icon={<ArrowUpToLine size={15} />} label="Insert above" onClick={() => actions.addRow({}, globalIndex(rowMenu.row))} />
            <MenuItem icon={<ArrowDownToLine size={15} />} label="Insert below" onClick={() => actions.addRow({}, globalIndex(rowMenu.row) + 1)} />
            {sub && (
              <MenuItem
                icon={<CornerDownRight size={15} />}
                label="Add sub-item"
                onClick={() => {
                  actions.addRow({ [sub.parentField]: [rowMenu.row.id] }, globalIndex(rowMenu.row) + 1);
                  setUnfolded((s) => new Set(s).add(rowMenu.row.id));
                }}
              />
            )}
            <MenuItem icon={<Copy size={15} />} label="Duplicate" onClick={() => actions.duplicateRow(rowMenu.row.id)} />
            <MenuDivider />
            <MenuItem icon={<Trash2 size={15} />} label="Delete" danger onClick={() => actions.deleteRow(rowMenu.row.id)} />
          </>
        )}
      </Menu>
    </ScrollX>
  );
}

function ResizeHandle({ field }: { field: Field }) {
  const { actions } = useDb();
  const start = useRef<{ x: number; w: number } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        start.current = { x: e.clientX, w: field.width ?? 180 };
        const move = (ev: MouseEvent) => start.current && setLive(Math.max(80, start.current.w + ev.clientX - start.current.x));
        const up = (ev: MouseEvent) => {
          if (start.current) actions.updateField(field.id, { width: Math.max(80, start.current.w + ev.clientX - start.current.x) });
          start.current = null;
          setLive(null);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      className="absolute top-0 -end-1 z-10 h-full w-2 cursor-col-resize hover:bg-accent/40"
      style={live ? { right: (field.width ?? 180) - live - 4 } : undefined}
    />
  );
}
