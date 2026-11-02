import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownUp, ChevronDown, Copy, Eye, EyeOff, ListFilter, Pencil, Plus, Trash2, X, Lock } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import * as Y from 'yjs';
import { PageTypeIcon } from '../app/PageIcon';
import { type Anchor, confirmDialog, Menu, MenuDivider, MenuItem, MenuLabel, Popover, toast } from '../components/ui';
import { getLocal, setLocal } from '../lib/storage';
import { BoardView } from './BoardView';
import { CalendarView } from './CalendarView';
import { FieldIcon, OptionTag } from './cells';
import { ChartView } from './ChartView';
import { FormBuilderView } from './FormView';
import { api } from '../lib/api';
import { getDirectory, useDirectory } from '../lib/directory';
import { DatabaseContext, type DatabaseContextValue, useDb } from './context';
import { GridView } from './GridView';
import { FeedView, GalleryView, ListView } from './CardViews';
import { type Filter, filterOpsFor, newId, type TaskItem, useDatabase, type View, VIEW_TYPES, type ViewType, fieldKind, RELATIVE_DATES, todayISO } from './model';
import type { LinkedView } from '../editor/EmbeddedDatabase';
import { NewButton } from './CardTemplates';
import { DatabaseMenu } from './DatabaseMenu';
import { RowDetail } from './RowDetail';
import { computeDatabase, useRelated } from './computed';
import { TimelineView } from './TimelineView';

export function ViewIcon({ type, size = 15 }: { type: ViewType; size?: number }) {
  return <PageTypeIcon type={type} size={size} className="shrink-0" />;
}

export function DatabaseView({
  doc,
  pageId,
  pageType,
  workspaceId,
  embedded,
  readOnly = false,
  linked,
}: {
  doc: Y.Doc;
  pageId: string;
  pageType: ViewType;
  workspaceId: string;
  embedded?: boolean;
  readOnly?: boolean;
  /** A linked view in a document: only this one view (chosen once). */
  linked?: LinkedView;
}) {
  const { db: stored, actions: liveActions } = useDatabase(doc, pageType);
  // Relations, rollups and formulas, worked out from the stored values (and other databases).
  const fetched = useRelated(stored, pageId);
  // Relations within this database (sub-items, dependencies…) use its live rows.
  const related = useMemo(() => {
    if (!stored.fields.some((f) => f.relation?.pageId === pageId)) return fetched;
    const map = new Map(fetched);
    map.set(pageId, { id: pageId, title: '', icon: '', fields: stored.fields, rows: stored.rows });
    return map;
  }, [fetched, stored, pageId]);
  // "Files & media" properties that also show the files attached inside each card's page.
  const wantsFiles = stored.fields.some((f) => f.type === 'media' && f.autoFiles);
  const cardFiles = useQuery({
    queryKey: ['card-files', pageId],
    queryFn: () => api<{ files: Record<string, { url: string; name: string; type: string }[]> }>(`/api/pages/${pageId}/rows/files`),
    enabled: wantsFiles && !getDirectory()?.public,
    refetchInterval: 15_000,
  });
  // "Tasks" properties: the tasks inside each card's page.
  const wantsTasks = stored.fields.some((f) => f.type === 'tasks');
  const cardTasks = useQuery({
    queryKey: ['card-tasks', pageId],
    queryFn: () => api<{ tasks: Record<string, TaskItem[]> }>(`/api/pages/${pageId}/rows/tasks`),
    enabled: wantsTasks && !getDirectory()?.public,
    refetchInterval: 15_000,
  });
  const db = useMemo(() => {
    const computed = computeDatabase(stored, related);
    const files = wantsFiles ? cardFiles.data?.files : undefined;
    const tasks = wantsTasks ? cardTasks.data?.tasks : undefined;
    if (!files && !tasks) return computed;
    const auto = computed.fields.filter((f) => f.type === 'media' && f.autoFiles);
    const taskFields = computed.fields.filter((f) => f.type === 'tasks');
    return {
      ...computed,
      rows: computed.rows.map((r) => {
        const extra = files?.[r.id];
        const own = tasks?.[r.id];
        if (!extra?.length && !own?.length) return r;
        const cells = { ...r.cells };
        for (const f of taskFields) cells[f.id] = own ?? [];
        if (!extra?.length) return { ...r, cells };
        for (const f of auto) {
          const own = Array.isArray(cells[f.id]) ? (cells[f.id] as { url: string }[]) : [];
          const seen = new Set(own.map((m) => m.url));
          cells[f.id] = [...own, ...extra.filter((m) => !seen.has(m.url))];
        }
        return { ...r, cells };
      }),
    };
  }, [stored, related, cardFiles.data, wantsFiles, cardTasks.data, wantsTasks]);
  // Viewers can browse everything, but changes are refused (the server ignores them too).
  const actions = useMemo(
    () =>
      readOnly
        ? (new Proxy(liveActions, {
            get: (target, key) => {
              const value = target[key as keyof typeof target];
              if (typeof value !== 'function') return value;
              return () => {
                toast('You can only view this page');
                return null;
              };
            },
          }) as typeof liveActions)
        : liveActions,
    [liveActions, readOnly],
  );
  const [params, setParams] = useSearchParams();
  const [viewId, setViewId] = useState<string | null>(() => getLocal<string | null>(`af-view-${pageId}`, null));
  const view = linked ? db.views.find((v) => v.id === linked.viewId) : (db.views.find((v) => v.id === viewId) ?? db.views[0]);

  const rowParam = params.get('row');
  const openRowId = rowParam?.startsWith(`${pageId}:`) ? rowParam.slice(pageId.length + 1) : null;

  const value = useMemo<DatabaseContextValue>(
    () => ({
      pageId,
      workspaceId,
      db,
      actions,
      readOnly,
      locked: readOnly || !!db.settings.locked,
      related,
      openRow: (rowId) =>
        rowId &&
        setParams((p) => {
          const next = new URLSearchParams(p);
          next.set('row', `${pageId}:${rowId}`);
          return next;
        }),
    }),
    [pageId, workspaceId, db, actions, readOnly, setParams, related],
  );

  const selectView = (id: string) => {
    setViewId(id);
    setLocal(`af-view-${pageId}`, id);
  };

  if (!view && linked) {
    return (
      <DatabaseContext.Provider value={value}>
        <LinkedViewChooser linked={linked} />
      </DatabaseContext.Provider>
    );
  }
  if (!view) return null;

  return (
    <DatabaseContext.Provider value={value}>
      <div className={clsx(!embedded && 'px-6 sm:px-[54px]')}>
        <Toolbar view={view} onSelectView={selectView} embedded={embedded} only={!!linked} />
      </div>
      {view.type === 'grid' && <GridView view={view} embedded={embedded} />}
      {view.type === 'board' && <BoardView view={view} embedded={embedded} />}
      {view.type === 'calendar' && <CalendarView view={view} embedded={embedded} />}
      {view.type === 'timeline' && <TimelineView view={view} embedded={embedded} />}
      {view.type === 'chart' && <ChartView view={view} embedded={embedded} />}
      {view.type === 'form' && <FormBuilderView view={view} embedded={embedded} />}
      {view.type === 'list' && <ListView view={view} embedded={embedded} />}
      {view.type === 'gallery' && <GalleryView view={view} embedded={embedded} />}
      {view.type === 'feed' && <FeedView view={view} embedded={embedded} />}
      {openRowId && (
        <RowDetail
          rowId={openRowId}
          full={params.get('full') === '1'}
          onToggleFull={(full) =>
            setParams((p) => {
              const next = new URLSearchParams(p);
              if (full) next.set('full', '1');
              else next.delete('full');
              return next;
            })
          }
          onClose={() =>
            setParams((p) => {
              const next = new URLSearchParams(p);
              next.delete('row');
              next.delete('full');
              return next;
            })
          }
        />
      )}
    </DatabaseContext.Provider>
  );
}

/** Choosing (or making) the view a linked view shows. */
function LinkedViewChooser({ linked }: { linked: LinkedView }) {
  const { db, actions } = useDb();
  if (!linked.editable) return <div className="text-sm text-muted">The view this linked view showed was deleted.</div>;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 text-sm font-medium">Show which view?</div>
      <div className="flex flex-wrap gap-1.5">
        {db.views.map((v) => (
          <button key={v.id} onClick={() => linked.onPick(v.id)} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-sm hover:bg-hover">
            <ViewIcon type={v.type} /> {v.name}
          </button>
        ))}
      </div>
      <div className="mt-3 mb-1 text-xs text-faint">Or a new view just for here, with its own filters and sorts:</div>
      <div className="flex flex-wrap gap-1.5">
        {VIEW_TYPES.filter((t) => t.type !== 'form').map((t) => (
          <button key={t.type} onClick={() => linked.onPick(actions.addView(t.type))} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted hover:bg-hover hover:text-fg">
            <ViewIcon type={t.type} /> {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toolbar({ view, onSelectView, embedded, only }: { view: View; onSelectView: (id: string) => void; embedded?: boolean; only?: boolean }) {
  const { db, actions, readOnly, locked } = useDb();
  const [addMenu, setAddMenu] = useState<Anchor | null>(null);
  const lockedNote = () => toast('Views and properties are locked — unlock them from the ••• menu');
  const [tabMenu, setTabMenu] = useState<{ anchor: Anchor; view: View } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ kind: 'filter' | 'sort' | 'props' | 'group'; anchor: Anchor } | null>(null);
  const settingsLabel: Partial<Record<ViewType, string>> = { board: 'Group', calendar: 'Date field', timeline: 'Dates', gallery: 'Cover' };

  const newRowCells = () => {
    const cells: Record<string, unknown> = {};
    // New rows land in the first visible group / today so they show up in the current view.
    if (view.type === 'board' && view.groupBy) {
      const field = db.fields.find((f) => f.id === view.groupBy);
      if (field?.options?.[0]) cells[field.id] = field.options[0].id;
    }
    if ((view.type === 'calendar' || view.type === 'timeline') && view.dateField) {
      const d = new Date();
      cells[view.dateField] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (view.type === 'timeline' && view.endField) cells[view.endField] = cells[view.dateField];
    }
    return cells;
  };

  return (
    <div className={clsx('flex flex-wrap items-center gap-2 border-b border-line', embedded ? 'pb-1' : 'pb-1.5')}>
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {(only ? [view] : db.views).map((v) =>
          renaming === v.id ? (
            <input
              key={v.id}
              autoFocus
              defaultValue={v.name}
              onBlur={(e) => {
                actions.updateView(v.id, { name: e.target.value.trim() || v.name });
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="h-7 w-32 rounded border border-accent bg-bg px-2 text-sm outline-none"
            />
          ) : (
            <button
              key={v.id}
              onClick={(e) => (v.id === view.id ? !locked && setTabMenu({ anchor: e.currentTarget.getBoundingClientRect(), view: v }) : onSelectView(v.id))}
              onDoubleClick={() => !locked && setRenaming(v.id)}
              className={clsx(
                'relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm',
                v.id === view.id ? 'font-medium text-fg after:absolute after:end-1 after:-bottom-[7px] after:start-1 after:h-0.5 after:rounded after:bg-accent' : 'text-muted hover:bg-hover',
              )}
            >
              <ViewIcon type={v.type} />
              {v.name}
            </button>
          ),
        )}
        {!locked && !only && (
          <button onClick={(e) => setAddMenu(e.currentTarget.getBoundingClientRect())} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover" title="Add a view">
            <Plus size={15} />
          </button>
        )}
      </div>

      <div className="flex max-w-full flex-wrap items-center gap-0.5">
        {view.type !== 'form' && (
          <>
            <ToolButton active={view.filters.length > 0} onClick={(e) => (locked && !readOnly ? lockedNote() : setPanel({ kind: 'filter', anchor: e }))}>
              <ListFilter size={15} /> Filter{view.filters.length ? ` · ${view.filters.length}` : ''}
            </ToolButton>
            <ToolButton active={view.sorts.length > 0} onClick={(e) => (locked && !readOnly ? lockedNote() : setPanel({ kind: 'sort', anchor: e }))}>
              <ArrowDownUp size={15} /> Sort{view.sorts.length ? ` · ${view.sorts.length}` : ''}
            </ToolButton>
          </>
        )}
        {settingsLabel[view.type] && (
          <ToolButton onClick={(e) => (locked && !readOnly ? lockedNote() : setPanel({ kind: 'group', anchor: e }))}>
            {settingsLabel[view.type]} <ChevronDown size={13} />
          </ToolButton>
        )}
        {view.type !== 'form' && view.type !== 'chart' && (
          <ToolButton onClick={(e) => (locked && !readOnly ? lockedNote() : setPanel({ kind: 'props', anchor: e }))}>
            <Eye size={15} /> Properties
          </ToolButton>
        )}
        {readOnly ? (
          <span className="ms-1 flex h-7 items-center gap-1 rounded-md bg-hover px-2.5 text-xs text-muted">
            <Eye size={13} /> View only
          </span>
        ) : (
          <>
            {db.settings.locked && (
              <span className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted" title="Views and properties are locked">
                <Lock size={13} />
              </span>
            )}
            <DatabaseMenu />
            {view.type !== 'form' && <NewButton cells={newRowCells} />}
          </>
        )}
      </div>

      <Menu anchor={addMenu} onClose={() => setAddMenu(null)}>
        <MenuLabel>Add a view</MenuLabel>
        {VIEW_TYPES.map((t) => (
          <MenuItem key={t.type} icon={<ViewIcon type={t.type} />} label={t.label} onClick={() => onSelectView(actions.addView(t.type))} />
        ))}
      </Menu>

      <Menu anchor={tabMenu?.anchor ?? null} onClose={() => setTabMenu(null)}>
        {tabMenu && (
          <>
            <MenuItem icon={<Pencil size={15} />} label="Rename" onClick={() => setRenaming(tabMenu.view.id)} />
            <MenuItem
              icon={<Copy size={15} />}
              label="Duplicate"
              onClick={() => {
                const id = actions.duplicateView(tabMenu.view.id);
                if (id) onSelectView(id);
              }}
            />
            {db.views.length > 1 && (
              <>
                <MenuDivider />
                <MenuItem
                  icon={<Trash2 size={15} />}
                  label="Delete view"
                  danger
                  onClick={async () => {
                    const v = tabMenu.view;
                    if (await confirmDialog({ title: `Delete the “${v.name}” view?`, message: 'The data stays; only this view is removed.', confirmLabel: 'Delete', danger: true })) {
                      actions.deleteView(v.id);
                    }
                  }}
                />
              </>
            )}
          </>
        )}
      </Menu>

      <Popover anchor={panel?.anchor ?? null} onClose={() => setPanel(null)} align="end" className="w-[340px] p-2">
        {panel?.kind === 'filter' && <FilterPanel view={view} />}
        {panel?.kind === 'sort' && <SortPanel view={view} />}
        {panel?.kind === 'props' && <PropertiesPanel view={view} />}
        {panel?.kind === 'group' && <GroupPanel view={view} />}
      </Popover>
    </div>
  );
}

function ToolButton({ children, onClick, active }: { children: ReactNode; onClick: (anchor: DOMRect) => void; active?: boolean }) {
  return (
    <button
      onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
      className={clsx('flex h-7 items-center gap-1.5 rounded-md px-2 text-sm', active ? 'text-accent hover:bg-accent-soft' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      {children}
    </button>
  );
}

const selectCls = 'h-8 min-w-0 rounded-md border border-line bg-bg px-1.5 text-sm outline-none focus:border-accent';

/** A date filter's value: a relative period (moves with the calendar) or a fixed date. */
function DateFilterValue({ value, onChange }: { value: unknown; onChange: (v: string) => void }) {
  const v = String(value ?? '');
  const relative = v.startsWith('@') || v === '';
  return (
    <span className="flex min-w-0 flex-1 gap-1">
      <select value={relative ? v : 'exact'} onChange={(e) => onChange(e.target.value === 'exact' ? todayISO() : e.target.value)} className={clsx(selectCls, 'min-w-0 flex-1')}>
        <option value="">Choose…</option>
        {RELATIVE_DATES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
        <option value="exact">Exact date…</option>
      </select>
      {!relative && <input type="date" value={v.slice(0, 10)} onChange={(e) => onChange(e.target.value)} className={clsx(selectCls, 'w-32 px-1')} />}
    </span>
  );
}

function FilterPanel({ view }: { view: View }) {
  const { db, actions } = useDb();
  const dir = useDirectory();
  const update = (filters: Filter[]) => actions.updateView(view.id, { filters });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-xs font-medium text-faint">
        <span className="flex-1">Filters</span>
        {view.filters.length > 1 && (
          <select value={view.filterMode} onChange={(e) => actions.updateView(view.id, { filterMode: e.target.value as View['filterMode'] })} className={clsx(selectCls, 'h-6 text-xs')}>
            <option value="and">Match all</option>
            <option value="or">Match any</option>
          </select>
        )}
      </div>
      {view.filters.length === 0 && <div className="px-1 text-sm text-muted">No filters applied.</div>}
      {view.filters.map((f) => {
        const field = db.fields.find((x) => x.id === f.fieldId);
        if (!field) return null;
        const ops = filterOpsFor(field.type);
        const op = ops.find((o) => o.op === f.op) ?? ops[0];
        const patch = (p: Partial<Filter>) => update(view.filters.map((x) => (x.id === f.id ? { ...x, ...p } : x)));
        return (
          <div key={f.id} className="flex items-center gap-1">
            <select value={f.fieldId} onChange={(e) => patch({ fieldId: e.target.value, op: filterOpsFor(db.fields.find((x) => x.id === e.target.value)!.type)[0].op, value: undefined })} className={clsx(selectCls, 'w-28')}>
              {db.fields.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <select value={op.op} onChange={(e) => patch({ op: e.target.value as Filter['op'] })} className={clsx(selectCls, 'w-24')}>
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {op.needsValue &&
              (field.type === 'date' || field.type === 'created_time' || field.type === 'last_edited' ? (
                <DateFilterValue value={f.value} onChange={(value) => patch({ value })} />
              ) : field.type === 'person' || field.type === 'created_by' || field.type === 'edited_by' ? (
                <select value={String(f.value ?? '')} onChange={(e) => patch({ value: e.target.value })} className={clsx(selectCls, 'flex-1')}>
                  <option value="">Choose…</option>
                  <option value="@me">Me (whoever is looking)</option>
                  {(dir?.members ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : field.type === 'select' || field.type === 'multi_select' ? (
                <select value={String(f.value ?? '')} onChange={(e) => patch({ value: e.target.value })} className={clsx(selectCls, 'flex-1')}>
                  <option value="">Choose…</option>
                  {field.options?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : field.type === 'checkbox' ? (
                <select value={f.value ? 'true' : 'false'} onChange={(e) => patch({ value: e.target.value === 'true' })} className={clsx(selectCls, 'flex-1')}>
                  <option value="true">Checked</option>
                  <option value="false">Unchecked</option>
                </select>
              ) : (
                <input
                  type={field.type === 'number' || field.type === 'unique_id' ? 'number' : 'text'}
                  value={String(f.value ?? '')}
                  onChange={(e) => patch({ value: e.target.value })}
                  placeholder="Value"
                  className={clsx(selectCls, 'flex-1 px-2')}
                />
              ))}
            <button onClick={() => update(view.filters.filter((x) => x.id !== f.id))} className="rounded p-1 text-muted hover:bg-hover hover:text-danger">
              <X size={14} />
            </button>
          </div>
        );
      })}
      <button
        onClick={() => {
          const field = db.fields[0];
          update([...view.filters, { id: newId(), fieldId: field.id, op: filterOpsFor(field.type)[0].op }]);
        }}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
      >
        <Plus size={14} /> Add filter
      </button>
    </div>
  );
}

function SortPanel({ view }: { view: View }) {
  const { db, actions } = useDb();
  const update = (sorts: View['sorts']) => actions.updateView(view.id, { sorts });
  const unused = db.fields.filter((f) => !view.sorts.some((s) => s.fieldId === f.id));
  return (
    <div className="space-y-2">
      <div className="px-1 text-xs font-medium text-faint">Sort</div>
      {view.sorts.length === 0 && <div className="px-1 text-sm text-muted">Rows are in manual order.</div>}
      {view.sorts.map((s, i) => (
        <div key={s.fieldId} className="flex items-center gap-1">
          <select value={s.fieldId} onChange={(e) => update(view.sorts.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)))} className={clsx(selectCls, 'flex-1')}>
            {db.fields
              .filter((f) => f.id === s.fieldId || unused.includes(f))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
          <select value={s.dir} onChange={(e) => update(view.sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)))} className={clsx(selectCls, 'w-32')}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button onClick={() => update(view.sorts.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:bg-hover hover:text-danger">
            <X size={14} />
          </button>
        </div>
      ))}
      {unused.length > 0 && (
        <button
          onClick={() => update([...view.sorts, { fieldId: unused[0].id, dir: 'asc' }])}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
        >
          <Plus size={14} /> Add sort
        </button>
      )}
    </div>
  );
}

function PropertiesPanel({ view }: { view: View }) {
  const { db, actions } = useDb();
  const toggle = (id: string) =>
    actions.updateView(view.id, { hidden: view.hidden.includes(id) ? view.hidden.filter((x) => x !== id) : [...view.hidden, id] });
  return (
    <div>
      <div className="px-1 pb-1 text-xs font-medium text-faint">Properties shown in this view</div>
      {db.fields.map((f) => {
        const hidden = view.hidden.includes(f.id) && !f.primary;
        return (
          <button
            key={f.id}
            disabled={f.primary}
            onClick={() => toggle(f.id)}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-hover disabled:hover:bg-transparent"
          >
            <FieldIcon type={fieldKind(f)} className="text-muted" />
            <span className={clsx('flex-1 truncate', hidden && 'text-muted')}>{f.name}</span>
            {f.primary ? <span className="text-xs text-faint">Always shown</span> : hidden ? <EyeOff size={14} className="text-faint" /> : <Eye size={14} className="text-muted" />}
          </button>
        );
      })}
    </div>
  );
}

/** View-specific settings: board grouping, calendar/timeline dates, gallery cover. */
function GroupPanel({ view }: { view: View }) {
  if (view.type === 'timeline') {
    return (
      <div className="space-y-3">
        <FieldPicker view={view} label="Start date" setting="dateField" fieldType="date" newName="Start" />
        <FieldPicker view={view} label="End date (optional)" setting="endField" fieldType="date" newName="End" allowNone />
      </div>
    );
  }
  if (view.type === 'gallery') {
    return <FieldPicker view={view} label="Card cover image from" setting="coverField" fieldType="media" newName="Cover" allowNone />;
  }
  if (view.type === 'calendar') return <FieldPicker view={view} label="Show rows on the calendar by" setting="dateField" fieldType="date" newName="Date" />;
  return (
    <div className="space-y-3">
      <FieldPicker view={view} label="Group cards by" setting="groupBy" fieldType="select" newName="Status" />
      <SwimlanePicker view={view} />
    </div>
  );
}

/** A board's swimlanes: rows of the board split by a second property. */
function SwimlanePicker({ view }: { view: View }) {
  const { db, actions } = useDb();
  const candidates = db.fields.filter((f) => f.id !== view.groupBy && (f.type === 'select' || f.type === 'person' || f.type === 'checkbox'));
  return (
    <label className="block">
      <span className="block px-1 pb-1 text-xs font-medium text-faint">Swimlanes (rows) by</span>
      <select value={view.subGroupBy ?? ''} onChange={(e) => actions.updateView(view.id, { subGroupBy: e.target.value || null })} className={clsx(selectCls, 'w-full')}>
        <option value="">None</option>
        {candidates.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function FieldPicker({
  view,
  label,
  setting,
  fieldType,
  newName,
  allowNone,
}: {
  view: View;
  label: string;
  setting: 'groupBy' | 'dateField' | 'endField' | 'coverField';
  fieldType: 'select' | 'date' | 'media';
  newName: string;
  allowNone?: boolean;
}) {
  const { db, actions } = useDb();
  const candidates = db.fields.filter((f) => f.type === fieldType);
  const current = view[setting];
  const isBoard = fieldType === 'select';
  return (
    <div>
      <div className="px-1 pb-1 text-xs font-medium text-faint">{label}</div>
      {allowNone && (
        <button
          onClick={() => actions.updateView(view.id, { [setting]: null })}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm text-muted hover:bg-hover"
        >
          <span className="flex-1">None</span>
          {!current && <span className="text-accent">✓</span>}
        </button>
      )}
      {candidates.map((f) => (
        <button
          key={f.id}
          onClick={() => actions.updateView(view.id, { [setting]: f.id })}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-hover"
        >
          <FieldIcon type={fieldKind(f)} className="text-muted" />
          <span className="flex-1">{f.name}</span>
          {isBoard && (
            <span className="flex gap-1">
              {f.options?.slice(0, 3).map((o) => (
                <OptionTag key={o.id} option={o} />
              ))}
            </span>
          )}
          {current === f.id && <span className="text-accent">✓</span>}
        </button>
      ))}
      <button
        onClick={() => {
          const id = actions.addField(fieldType, newName);
          if (id) actions.updateView(view.id, { [setting]: id });
        }}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
      >
        <Plus size={14} /> New {fieldType === 'media' ? 'files & media' : fieldType} property
      </button>
    </div>
  );
}
