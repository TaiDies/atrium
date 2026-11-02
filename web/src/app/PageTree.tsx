import clsx from 'clsx';
import { ChevronRight, Copy, Eye, Link2, Lock, MoreHorizontal, PackageOpen, Pencil, Plus, Star, StarOff, Trash2 } from 'lucide-react';
import { type DragEvent, type MouseEvent, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { type Anchor, Menu, MenuDivider, MenuItem, toastError } from '../components/ui';
import { canEdit, PAGE_TYPES, pageTitle, type PageSummary, archivedIds } from '../lib/api';
import { invalidatePages, setFavorite, updatePage } from '../lib/queries';
import { useApp } from './context';
import { ExportDialog } from './ExportDialog';
import { copyPageLink, descendantIds, duplicatePage, trashPage } from './pageActions';
import { PageIcon, PageTypeIcon } from './PageIcon';

type DropZone = 'before' | 'inside' | 'after';
const ROOT = '__root__';

export function PageTree({
  expanded,
  setExpanded,
  roots,
  personalOrder,
  onPersonalOrder,
}: {
  expanded: Set<string>;
  setExpanded: (fn: (p: Set<string>) => Set<string>) => void;
  /** Which top-level pages this tree shows (e.g. one teamspace's). */
  roots?: (p: PageSummary) => boolean;
  /** This person's own order of the top-level pages (null: the shared order). */
  personalOrder?: string[] | null;
  onPersonalOrder?: (ids: string[]) => void;
}) {
  const { pages, workspace } = useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; zone: DropZone } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const children = useMemo(() => {
    // Archived pages (and the pages inside them) stay out of the sidebar.
    const hidden = archivedIds(pages);
    const shown = pages.filter((p) => !hidden.has(p.id));
    const ids = new Set(shown.map((p) => p.id));
    const map = new Map<string, PageSummary[]>();
    for (const p of shown) {
      const key = p.parentId && ids.has(p.parentId) ? p.parentId : ROOT;
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const top = (map.get(ROOT) ?? []).filter((p) => !roots || roots(p));
    if (personalOrder) {
      const rank = new Map(personalOrder.map((id, i) => [id, i]));
      top.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    }
    map.set(ROOT, top);
    return map;
  }, [pages, roots, personalOrder]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const blocked = useMemo(() => (dragId ? descendantIds(pages, dragId) : new Set<string>()), [dragId, pages]);

  const onDrop = async (target: PageSummary, zone: DropZone) => {
    const id = dragId;
    setDragId(null);
    setDrop(null);
    if (!id || blocked.has(target.id)) return;
    let parentId: string | null;
    let position: number;
    if (zone === 'inside') {
      parentId = target.id;
      const kids = (children.get(target.id) ?? []).filter((p) => p.id !== id);
      position = kids.length ? kids[kids.length - 1].position + 1 : 0;
      setExpanded((prev) => new Set(prev).add(target.id));
    } else if (personalOrder && onPersonalOrder && !target.parentId && !pages.find((p) => p.id === id)?.parentId) {
      // Your own order: moving a top-level page only changes how you see it.
      const ids = (children.get(ROOT) ?? []).map((p) => p.id).filter((x) => x !== id);
      ids.splice(ids.indexOf(target.id) + (zone === 'after' ? 1 : 0), 0, id);
      onPersonalOrder(ids);
      return;
    } else {
      parentId = target.parentId;
      const siblings = (children.get(target.parentId ?? ROOT) ?? []).filter((p) => p.id !== id);
      const i = siblings.findIndex((p) => p.id === target.id);
      const neighbour = siblings[zone === 'before' ? i - 1 : i + 1];
      position = neighbour ? (neighbour.position + target.position) / 2 : target.position + (zone === 'before' ? -1 : 1);
    }
    try {
      await updatePage(workspace.id, id, { parentId, position });
    } catch (err) {
      toastError(err);
    }
    invalidatePages(workspace.id);
  };

  const render = (parentKey: string, depth: number): React.ReactNode =>
    (children.get(parentKey) ?? []).map((page) => {
      const kids = children.get(page.id) ?? [];
      const open = expanded.has(page.id);
      return (
        <div key={page.id}>
          <TreeRow
            page={page}
            depth={depth}
            open={open}
            hasChildren={kids.length > 0}
            onToggle={() => toggle(page.id)}
            renaming={renaming === page.id}
            onRename={() => setRenaming(page.id)}
            onRenameDone={() => setRenaming(null)}
            drop={drop?.id === page.id ? drop.zone : null}
            dragging={dragId === page.id}
            onDragStart={() => setDragId(page.id)}
            onDragEnd={() => {
              setDragId(null);
              setDrop(null);
            }}
            onDragOverZone={(zone) => {
              if (!dragId || blocked.has(page.id)) return setDrop(null);
              setDrop({ id: page.id, zone });
            }}
            onDropZone={(zone) => onDrop(page, zone)}
          />
          {open && (
            <div>
              {kids.length > 0 ? (
                render(page.id, depth + 1)
              ) : (
                <div className="py-1 text-xs text-faint" style={{ paddingLeft: 36 + (depth + 1) * 14 }}>
                  No pages inside
                </div>
              )}
            </div>
          )}
        </div>
      );
    });

  if (!(children.get(ROOT) ?? []).length) {
    return <div className="px-3 py-2 text-xs text-faint">No pages yet</div>;
  }
  return <div className="pb-2">{render(ROOT, 0)}</div>;
}

function TreeRow({
  page,
  depth,
  open,
  hasChildren,
  onToggle,
  renaming,
  onRename,
  onRenameDone,
  drop,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOverZone,
  onDropZone,
}: {
  page: PageSummary;
  depth: number;
  open: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  renaming: boolean;
  onRename: () => void;
  onRenameDone: () => void;
  drop: DropZone | null;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverZone: (zone: DropZone) => void;
  onDropZone: (zone: DropZone) => void;
}) {
  const navigate = useNavigate();
  const { pageId } = useParams();
  const { workspace, pages, newPage, canCreatePages } = useApp();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [addMenu, setAddMenu] = useState<Anchor | null>(null);
  const [exporting, setExporting] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const active = pageId === page.id;
  const editable = canEdit(page.access);

  const zoneFor = (e: DragEvent) => {
    const rect = rowRef.current!.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
  };

  const openMenu = (e: MouseEvent, at?: Anchor) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(at ?? (e.currentTarget as HTMLElement).getBoundingClientRect());
  };

  return (
    <>
      <div
        ref={rowRef}
        draggable={!renaming && editable}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', page.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => {
          e.preventDefault();
          onDragOverZone(zoneFor(e));
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDropZone(zoneFor(e));
        }}
        onClick={() => !renaming && navigate(`/w/${workspace.id}/p/${page.id}`)}
        onContextMenu={(e) => openMenu(e, { x: e.clientX, y: e.clientY })}
        className={clsx(
          'group relative mx-1 flex h-[30px] cursor-pointer items-center gap-1 rounded-md pe-1 text-sm select-none',
          active ? 'bg-active font-medium text-fg' : 'text-fg/85 hover:bg-hover',
          dragging && 'opacity-40',
          drop === 'inside' && 'bg-accent-soft ring-1 ring-accent',
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {drop === 'before' && <div className="pointer-events-none absolute -top-px end-1 start-1 h-0.5 rounded bg-accent" />}
        {drop === 'after' && <div className="pointer-events-none absolute end-1 -bottom-px start-1 h-0.5 rounded bg-accent" />}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-active hover:text-fg"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <ChevronRight size={14} className={clsx('transition-transform', open && 'rotate-90', !hasChildren && 'opacity-60')} />
        </button>
        <PageIcon page={page} />
        {renaming ? (
          <RenameInput page={page} onDone={onRenameDone} />
        ) : (
          <span className={clsx('ms-1 flex-1 truncate', !page.title && 'text-muted')}>{pageTitle(page)}</span>
        )}
        {!renaming && (page.restricted || page.access === 'view') && (
          <span className="shrink-0 text-faint group-hover:hidden" title={page.access === 'view' ? 'View only' : 'Has its own sharing settings'}>
            {page.access === 'view' ? <Eye size={12} /> : <Lock size={12} />}
          </span>
        )}
        {!renaming && (
          <div className={clsx('ms-auto flex items-center gap-0.5', menu || addMenu ? 'flex' : 'hidden group-hover:flex hover-reveal-flex')}>
            <button
              onClick={(e) => openMenu(e)}
              className="flex size-6 items-center justify-center rounded text-muted hover:bg-active hover:text-fg"
              aria-label="Page actions"
            >
              <MoreHorizontal size={15} />
            </button>
            {editable && canCreatePages && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setAddMenu((e.currentTarget as HTMLElement).getBoundingClientRect());
                }}
                className="flex size-6 items-center justify-center rounded text-muted hover:bg-active hover:text-fg"
                aria-label="Add a page inside"
              >
                <Plus size={15} />
              </button>
            )}
          </div>
        )}
      </div>

      <Menu anchor={menu} onClose={() => setMenu(null)}>
        {editable && <MenuItem icon={<Pencil size={15} />} label="Rename" onClick={onRename} />}
        <MenuItem
          icon={page.isFavorite ? <StarOff size={15} /> : <Star size={15} />}
          label={page.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => setFavorite(workspace.id, page.id, !page.isFavorite).catch(toastError)}
        />
        {editable && canCreatePages && (
          <MenuItem
            icon={<Copy size={15} />}
            label="Duplicate"
            onClick={async () => {
              try {
                const id = await duplicatePage(workspace.id, page.id);
                navigate(`/w/${workspace.id}/p/${id}`);
              } catch (err) {
                toastError(err);
              }
            }}
          />
        )}
        <MenuItem icon={<Link2 size={15} />} label="Copy link" onClick={() => copyPageLink(workspace.id, page.id)} />
        <MenuItem icon={<PackageOpen size={15} />} label="Export…" onClick={() => setExporting(true)} />
        {editable && (
          <>
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={15} />}
              label="Move to trash"
              danger
              onClick={async () => {
                const removed = await trashPage(workspace.id, pages, page.id);
                if (pageId && removed.has(pageId)) navigate(`/w/${workspace.id}`);
              }}
            />
          </>
        )}
      </Menu>
      {exporting && <ExportDialog page={page} onClose={() => setExporting(false)} />}

      <Menu anchor={addMenu} onClose={() => setAddMenu(null)}>
        {PAGE_TYPES.map((t) => (
          <MenuItem key={t.type} icon={<PageTypeIcon type={t.type} size={15} />} label={t.label} onClick={() => newPage({ parentId: page.id, type: t.type })} />
        ))}
      </Menu>
    </>
  );
}

function RenameInput({ page, onDone }: { page: PageSummary; onDone: () => void }) {
  const { workspace } = useApp();
  const [value, setValue] = useState(page.title);
  const commit = () => {
    onDone();
    if (value !== page.title) updatePage(workspace.id, page.id, { title: value }).catch(toastError);
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
      }}
      className="ms-1 h-6 min-w-0 flex-1 rounded border border-accent bg-bg px-1.5 text-sm outline-none"
    />
  );
}
