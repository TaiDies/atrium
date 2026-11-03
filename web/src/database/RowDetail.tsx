import clsx from 'clsx';
import { ArrowLeft, Check, Copy, Layers, LayoutTemplate, Link2, Maximize2, Minimize2, MoreHorizontal, Plus, Repeat, Trash2, X } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppContext } from '../app/context';
import { DocumentEditor } from '../app/DocumentEditor';
import { FlashcardsDialog } from '../study/Flashcards';
import { CardRepeatDialog } from '../calendar/CardDialog';
import { PageIcon } from '../app/PageIcon';
import { type Anchor, Dialog, IconButton, Menu, MenuDivider, MenuItem, toast } from '../components/ui';
import { useCollab } from '../lib/collab';
import { pageTitle } from '../lib/api';
import { useDirectory } from '../lib/directory';
import { usePublicDoc } from '../lib/publicDoc';
import { CellEditor, FieldIcon } from './cells';
import { useDb } from './context';
import { FieldMenu, NewFieldMenu } from './FieldMenu';
import { type Field, primaryField, type Row, templateAsRow, fieldKind } from './model';

/**
 * A database row opened as a page: its properties, then a full block editor. It opens as a centred
 * dialog and can be expanded to fill the content area like any other page (`?full=1`).
 */
export function RowDetail({ rowId, full, onToggleFull, onClose }: { rowId: string; full: boolean; onToggleFull: (full: boolean) => void; onClose: () => void }) {
  const { db, actions, pageId, openRow, readOnly } = useDb();
  const dir = useDirectory();
  // A card template opens here too, to edit what new cards start with.
  const template = db.templates.find((t) => t.id === rowId);
  const row = db.rows.find((r) => r.id === rowId) ?? (template && templateAsRow(template));
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [repeating, setRepeating] = useState(false);
  const [studying, setStudying] = useState(false);
  const app = useContext(AppContext);
  const pf = primaryField(db.fields);
  const repeats = !!row?.repeat;
  const rowTitle = (row && pf && typeof row.cells[pf.id] === 'string' && (row.cells[pf.id] as string).trim()) || 'Untitled';
  const database = dir?.pages.find((p) => p.id === pageId);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[data-af-popover], .bn-suggestion-menu')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, onClose]);

  const toolbar = (
    <>
      {row && (
        <IconButton onClick={() => onToggleFull(!full)} title={full ? 'Open as a popup' : 'Expand to full page'}>
          {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </IconButton>
      )}
      {row && (
        <IconButton onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} title="More">
          <MoreHorizontal size={17} />
        </IconButton>
      )}
      <IconButton onClick={onClose} title="Close">
        <X size={17} />
      </IconButton>
    </>
  );

  const body = row ? (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={full ? 'mx-auto w-full max-w-(--page-width) pt-6 sm:pt-10' : undefined}>
        {template && <TemplateBanner id={template.id} name={template.name} />}
        <RowHeader row={row} />
        <RowDocument pageId={pageId} rowId={row.id} />
      </div>
    </div>
  ) : (
    <div className="flex flex-1 items-center justify-center text-sm text-muted">This row was deleted.</div>
  );

  const repeatDialog = (
    <>
      {repeating && <CardRepeatDialog pageId={pageId} rowId={rowId} onClose={() => setRepeating(false)} />}
      {studying && app && <FlashcardsDialog pageId={pageId} rowId={rowId} pageTitle={rowTitle} workspaceId={app.workspace.id} onClose={() => setStudying(false)} />}
    </>
  );
  const moreMenu = template ? (
    <Menu anchor={menu} onClose={() => setMenu(null)} align="end">
      <MenuItem icon={full ? <Minimize2 size={15} /> : <Maximize2 size={15} />} label={full ? 'Open as a popup' : 'Expand to full page'} onClick={() => onToggleFull(!full)} />
      {!readOnly && (
        <MenuItem
          icon={<Check size={15} />}
          label={template.isDefault ? 'Stop using for New' : 'Use for the New button'}
          onClick={() => actions.setDefaultTemplate(template.isDefault ? null : template.id)}
        />
      )}
      <MenuDivider />
      <MenuItem
        icon={<Trash2 size={15} />}
        label="Delete template"
        danger
        onClick={() => {
          actions.deleteTemplate(rowId);
          onClose();
        }}
      />
    </Menu>
  ) : (
    <Menu anchor={menu} onClose={() => setMenu(null)} align="end">
      <MenuItem icon={full ? <Minimize2 size={15} /> : <Maximize2 size={15} />} label={full ? 'Open as a popup' : 'Expand to full page'} onClick={() => onToggleFull(!full)} />
      {!readOnly && <MenuItem icon={<Repeat size={15} />} label={repeats ? 'Repeat settings…' : 'Repeat…'} onClick={() => setRepeating(true)} />}
      {app && <MenuItem icon={<Layers size={15} />} label="Flashcards & quiz" onClick={() => setStudying(true)} />}
      <MenuItem
        icon={<Copy size={15} />}
        label="Duplicate"
        onClick={() => {
          const id = actions.duplicateRow(rowId);
          if (id) openRow(id);
        }}
      />
      <MenuItem
        icon={<Link2 size={15} />}
        label="Copy link"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${location.origin}${location.pathname}?row=${pageId}:${rowId}${full ? '&full=1' : ''}`);
            toast('Link copied');
          } catch {
            toast('Could not copy the link', 'error');
          }
        }}
      />
      <MenuDivider />
      <MenuItem
        icon={<Trash2 size={15} />}
        label="Delete"
        danger
        onClick={() => {
          actions.deleteRow(rowId);
          onClose();
        }}
      />
    </Menu>
  );

  if (full) {
    const host = document.getElementById('app-main');
    const page = (
      <div className={clsx('z-40 flex flex-col bg-bg', host ? 'absolute inset-0' : 'fixed inset-0')} role="region" aria-label={rowTitle}>
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
          <button
            onClick={onClose}
            className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-fg"
            title="Back to the database"
          >
            <ArrowLeft size={15} className="shrink-0" />
            {database && <PageIcon page={database} size={15} />}
            <span className="max-w-[40vw] truncate">{database ? pageTitle(database) : 'Database'}</span>
          </button>
          <span className="text-faint">/</span>
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{rowTitle}</span>
          {toolbar}
        </div>
        {body}
        {moreMenu}
        {repeatDialog}
      </div>
    );
    return host ? createPortal(page, host) : page;
  }

  return (
    <Dialog open onClose={onClose} width={920} maxHeight="90vh" top="5vh" className="h-[90vh]">
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center justify-end gap-1 px-3">{toolbar}</div>
        {body}
      </div>
      {moreMenu}
      {repeatDialog}
    </Dialog>
  );
}

function RowHeader({ row }: { row: Row }) {
  const { db, actions, readOnly, locked } = useDb();
  const pf = primaryField(db.fields);
  const [fieldMenu, setFieldMenu] = useState<{ field: Field; anchor: Anchor } | null>(null);
  const [newField, setNewField] = useState<Anchor | null>(null);
  const others = db.fields.filter((f) => f.id !== pf?.id);

  return (
    <div className="px-6 sm:px-[54px]">
      {pf && <TitleField row={row} field={pf} />}
      <div className="mt-3 space-y-0.5">
        {others.map((f) => (
          <div key={f.id} className="flex items-start gap-2">
            <button
              onClick={(e) => !locked && setFieldMenu({ field: f, anchor: e.currentTarget.getBoundingClientRect() })}
              className="flex h-8 w-40 shrink-0 items-center gap-2 rounded-md px-2 text-start text-sm text-muted hover:bg-hover"
            >
              <FieldIcon type={fieldKind(f)} />
              <span className="truncate">{f.name}</span>
            </button>
            <div className="min-w-0 flex-1">
              <CellEditor field={f} row={row} variant="detail" />
            </div>
          </div>
        ))}
        {!readOnly && !locked && (
          <button
            onClick={(e) => setNewField(e.currentTarget.getBoundingClientRect())}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-fg"
          >
            <Plus size={14} /> Add property
          </button>
        )}
      </div>
      <div className="mt-4 mb-2 h-px bg-line" />
      <FieldMenu field={fieldMenu?.field ?? null} anchor={fieldMenu?.anchor ?? null} onClose={() => setFieldMenu(null)} />
      <NewFieldMenu anchor={newField} onClose={() => setNewField(null)} onCreate={(type, name, extra) => actions.addField(type, name, undefined, extra)} />
    </div>
  );
}

function TitleField({ row, field }: { row: Row; field: Field }) {
  const { actions } = useDb();
  const remote = typeof row.cells[field.id] === 'string' ? (row.cells[field.id] as string) : '';
  const [value, setValue] = useState(remote);
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!focused.current) setValue(remote);
  }, [remote]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      autoFocus={!remote}
      placeholder="Untitled"
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onChange={(e) => {
        const v = e.target.value.replace(/\n/g, '');
        setValue(v);
        actions.updateCell(row.id, field.id, v);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
      className="block w-full resize-none overflow-hidden bg-transparent text-[32px] leading-tight font-bold tracking-tight outline-none placeholder:text-faint/60"
    />
  );
}

function RowDocument({ pageId, rowId }: { pageId: string; rowId: string }) {
  const dir = useDirectory();
  if (!dir) return null;
  if (dir.public) return <PublicRowDocument token={dir.public.token} pageId={pageId} rowId={rowId} user={dir.user} />;
  return <RowDocumentInner pageId={pageId} rowId={rowId} workspaceId={dir.workspaceId} user={dir.user} />;
}

function RowDocumentInner({ pageId, rowId, workspaceId, user }: { pageId: string; rowId: string; workspaceId: string; user: NonNullable<ReturnType<typeof useDirectory>>['user'] }) {
  const { session, synced, denied } = useCollab(`${pageId}:${rowId}`, user, () => {});
  if (denied) return <div className="px-[54px] py-6 text-sm text-muted">You don't have access to this row.</div>;
  if (!session || !synced) {
    return (
      <div className="flex justify-center py-10 text-muted">
        <span className="inline-block size-5 animate-spin rounded-full border-2 border-current border-e-transparent" />
      </div>
    );
  }
  return <DocumentEditor session={session} user={user} workspaceId={workspaceId} parentPageId={pageId} className="pb-24" />;
}

/** A card's page on a page published to the web. */
function PublicRowDocument({ token, pageId, rowId, user }: { token: string; pageId: string; rowId: string; user: NonNullable<ReturnType<typeof useDirectory>>['user'] }) {
  const { session, error } = usePublicDoc(token, pageId, rowId);
  if (error) return <div className="px-[54px] py-6 text-sm text-muted">This card couldn’t be loaded.</div>;
  if (!session) return null;
  return <DocumentEditor session={session} user={user} workspaceId="" parentPageId={pageId} className="pb-24" readOnly />;
}

/** Shown above a card template being edited, with its name. */
function TemplateBanner({ id, name }: { id: string; name: string }) {
  const { actions, readOnly } = useDb();
  return (
    <div className="mx-6 mb-4 flex items-center gap-2 rounded-lg bg-accent/10 px-3 py-2 text-sm sm:mx-[54px]">
      <LayoutTemplate size={15} className="shrink-0 text-accent" />
      <span className="shrink-0 text-muted">Editing template</span>
      <input
        key={id}
        defaultValue={name}
        readOnly={readOnly}
        onBlur={(e) => e.target.value.trim() !== name && actions.renameTemplate(id, e.target.value.trim() || 'Untitled template')}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="min-w-0 flex-1 rounded bg-transparent px-1 font-medium outline-none focus:bg-bg"
        aria-label="Template name"
      />
      <span className="hidden shrink-0 text-xs text-muted sm:inline">New cards from it start with these properties and this content.</span>
    </div>
  );
}
