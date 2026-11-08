import { positionLabel } from '../lib/filePosition';
import { useOpenFile } from '../lib/openFile';
import clsx from 'clsx';
import {
  BookmarkCheck,
  Download,
  Eraser,
  ExternalLink,
  File as FileIcon,
  FileText,
  FileType2,
  Film,
  Grid2x2,
  Image as ImageIcon,
  LayoutList,
  MoreVertical,
  Music,
  NotebookPen,
  Pencil,
  Plus,
  Presentation,
  Search,
  Settings2,
  Sheet,
  Trash2,
  Upload,
} from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../app/context';
import { CleanupDialog } from './CleanupDialog';
import { type Anchor, confirmDialog, IconButton, Menu, MenuDivider, MenuItem, toast, toastError } from '../components/ui';
import { downloadUrl, uploadFile } from '../lib/api';
import { getLocal, setLocal } from '../lib/storage';
import { timeAgo } from '../lib/time';
import { deleteFile, type FileKind, isOffice, kindOf, newNote, newOfficeFile, type OfficeKind, refreshFiles, renameFile, usePreview, useWorkspaceFiles, type WorkspaceFile } from './api';
import { FileSettingsDialog } from './FileSettingsDialog';
import { isInkItem } from './ink';
import { InkItems } from './InkSvg';
import { loadPdfjs, pdfAssets } from './pdf';
import { SidebarIcon } from '../notifications/Notifications';

type Filter = 'all' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'note' | 'image' | 'media' | 'other' | 'unlinked';
type Sort = 'modified' | 'created' | 'name' | 'size';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Documents' },
  { id: 'spreadsheet', label: 'Spreadsheets' },
  { id: 'presentation', label: 'Presentations' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'note', label: 'Notes' },
  { id: 'image', label: 'Images' },
  { id: 'media', label: 'Video & audio' },
  { id: 'other', label: 'Other files' },
  { id: 'unlinked', label: 'Not on any page' },
];

const matches = (f: WorkspaceFile, filter: Filter) => {
  const k = kindOf(f);
  if (filter === 'all') return true;
  if (filter === 'unlinked') return f.locations.length === 0;
  if (filter === 'media') return k === 'video' || k === 'audio';
  return k === filter;
};

/**
 * The Files screen: every document, spreadsheet, presentation, PDF, note and other file in the workspace
 * (including everything attached to pages and cards) as thumbnails, with a + to make a new one.
 */
export function NotesPage() {
  const { workspace, sidebarOpen, toggleSidebar } = useApp();
  const [cleaning, setCleaning] = useState(false);
  const files = useWorkspaceFiles(workspace.id);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>(() => getLocal<Sort>('atrium-notes-sort', 'modified'));
  const [layout, setLayout] = useState<'grid' | 'list'>(() => getLocal('atrium-notes-layout', 'grid'));
  const [fab, setFab] = useState<Anchor | null>(null);
  const [settings, setSettings] = useState<WorkspaceFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setLocal('atrium-notes-sort', sort), [sort]);
  useEffect(() => setLocal('atrium-notes-layout', layout), [layout]);
  useEffect(() => {
    document.title = `Files · ${workspace.name}`;
  }, [workspace.name]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = (files.data ?? []).filter(
      (f) =>
        matches(f, filter) &&
        (!needle || f.name.toLowerCase().includes(needle) || f.locations.some((l) => `${l.pageTitle} ${l.rowTitle ?? ''}`.toLowerCase().includes(needle))),
    );
    const by: Record<Sort, (a: WorkspaceFile, b: WorkspaceFile) => number> = {
      modified: (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
      created: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      size: (a, b) => b.size - a.size,
    };
    return out.sort(by[sort]);
  }, [files.data, q, filter, sort]);

  const openFile = useOpenFile();
  const open = (f: WorkspaceFile) => openFile(`/api/files/${f.id}`, f.name);

  const createOffice = async (kind: OfficeKind) => {
    try {
      const file = await newOfficeFile(workspace.id, kind);
      await refreshFiles(workspace.id);
      openFile(`/api/files/${file.id}`);
    } catch (err) {
      toastError(err);
    }
  };

  const createNote = async () => {
    try {
      const note = await newNote(workspace.id);
      await refreshFiles(workspace.id);
      openFile(`/api/files/${note.id}`);
    } catch (err) {
      toastError(err);
    }
  };

  const upload = async (picked: File[]) => {
    if (!picked.length) return;
    setUploading((n) => n + picked.length);
    let done = 0;
    for (const file of picked) {
      try {
        await uploadFile(workspace.id, file);
        done++;
      } catch (err) {
        toastError(err);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (done) toast(done === 1 ? 'File added' : `${done} files added`);
    refreshFiles(workspace.id);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload([...e.dataTransfer.files]);
  };

  const counts = useMemo(() => {
    const c = {} as Record<Filter, number>;
    for (const f of FILTERS) c[f.id] = (files.data ?? []).filter((file) => matches(file, f.id)).length;
    return c;
  }, [files.data]);

  return (
    <div
      className="relative h-full overflow-y-auto"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      {!sidebarOpen && (
        <div className="px-3 pt-2">
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        </div>
      )}
      {cleaning && <CleanupDialog workspaceId={workspace.id} isOwner={workspace.role === 'owner'} onClose={() => setCleaning(false)} />}
      <div className="mx-auto max-w-[1200px] px-4 pt-8 pb-32 sm:px-8 sm:pt-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Files</h1>
            <p className="mt-1 text-sm text-muted">
              {files.data ? `${files.data.length} ${files.data.length === 1 ? 'item' : 'items'}` : 'Loading…'}
              {uploading > 0 && ` · uploading ${uploading}…`}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 sm:w-64 sm:flex-none">
              <Search size={15} className="shrink-0 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes and files" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="h-9 shrink-0 rounded-lg border border-line bg-surface px-2 text-sm"
              aria-label="Sort by"
            >
              <option value="modified">Date modified</option>
              <option value="created">Date added</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
            <IconButton onClick={() => setLayout(layout === 'grid' ? 'list' : 'grid')} title={layout === 'grid' ? 'List view' : 'Grid view'} className="shrink-0">
              {layout === 'grid' ? <LayoutList size={17} /> : <Grid2x2 size={17} />}
            </IconButton>
            <IconButton onClick={() => setCleaning(true)} title="Delete unused files" className="shrink-0">
              <Eraser size={17} />
            </IconButton>
          </div>
        </div>

        <div className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={clsx(
                'h-8 shrink-0 rounded-full border px-3 text-sm whitespace-nowrap transition-colors',
                filter === f.id ? 'border-accent bg-accent text-white' : 'border-line text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {f.label}
              {f.id !== 'all' && counts[f.id] > 0 && <span className={clsx('ml-1.5 text-xs', filter === f.id ? 'text-white/80' : 'text-faint')}>{counts[f.id]}</span>}
            </button>
          ))}
        </div>

        {files.isPending && (
          <div className="flex justify-center py-20 text-muted">
            <span className="inline-block size-6 animate-spin rounded-full border-2 border-current border-r-transparent" />
          </div>
        )}
        {files.data && list.length === 0 && (
          <div className="mt-8 flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-16 text-center">
            <NotebookPen size={36} className="text-faint" />
            <div className="mt-3 font-medium">{q || filter !== 'all' ? 'Nothing matches' : 'No notes yet'}</div>
            <p className="mt-1 max-w-sm text-sm text-muted">
              {q || filter !== 'all' ? 'Try another search or filter.' : 'Make a handwritten note, or drop PDFs and images here. Files you attach to pages show up here too.'}
            </p>
            {!q && filter === 'all' && (
              <button onClick={createNote} className="mt-5 flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:brightness-110">
                <Plus size={16} /> New note
              </button>
            )}
          </div>
        )}

        {layout === 'grid' ? (
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {list.map((f) => (
              <NoteCard key={f.id} file={f} onOpen={() => open(f)} onSettings={() => setSettings(f)} />
            ))}
          </div>
        ) : (
          <div className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {list.map((f) => (
              <NoteRow key={f.id} file={f} onOpen={() => open(f)} onSettings={() => setSettings(f)} />
            ))}
          </div>
        )}
      </div>

      {/* The floating "+" button, like a notes app's home screen. */}
      <button
        onClick={(e) => setFab(e.currentTarget.getBoundingClientRect())}
        data-fab
        className="fixed right-5 bottom-5 z-20 flex size-14 items-center justify-center rounded-2xl bg-accent text-white shadow-pop transition-transform hover:scale-105 active:scale-95 sm:right-8 sm:bottom-8"
        title="New file"
        aria-label="New file"
      >
        <Plus size={26} />
      </button>
      <Menu anchor={fab} onClose={() => setFab(null)} align="end">
        <MenuItem icon={<FileType2 size={15} />} label="New document" onClick={() => createOffice('document')} />
        <MenuItem icon={<Sheet size={15} />} label="New spreadsheet" onClick={() => createOffice('spreadsheet')} />
        <MenuItem icon={<Presentation size={15} />} label="New presentation" onClick={() => createOffice('presentation')} />
        <MenuItem icon={<NotebookPen size={15} />} label="New handwritten note" onClick={createNote} />
        <MenuDivider />
        <MenuItem icon={<Upload size={15} />} label="Upload files" onClick={() => input.current?.click()} />
      </Menu>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          upload([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-accent/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center shadow-pop">
            <Upload size={28} className="mx-auto text-accent" />
            <div className="mt-2 font-medium">Drop to add to Files</div>
          </div>
        </div>
      )}

      {settings && (
        <FileSettingsDialog
          file={(files.data ?? []).find((f) => f.id === settings.id) ?? settings}
          onClose={() => setSettings(null)}
        />
      )}
    </div>
  );
}

function kindLabel(k: FileKind) {
  return { note: 'Note', pdf: 'PDF', document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', image: 'Image', video: 'Video', audio: 'Audio', other: 'File' }[k];
}

function KindIcon({ kind, size = 16 }: { kind: FileKind; size?: number }) {
  if (kind === 'note') return <NotebookPen size={size} />;
  if (kind === 'document') return <FileType2 size={size} />;
  if (kind === 'spreadsheet') return <Sheet size={size} />;
  if (kind === 'presentation') return <Presentation size={size} />;
  if (kind === 'pdf') return <FileText size={size} />;
  if (kind === 'image') return <ImageIcon size={size} />;
  if (kind === 'video') return <Film size={size} />;
  if (kind === 'audio') return <Music size={size} />;
  return <FileIcon size={size} />;
}

function locationText(f: WorkspaceFile) {
  if (!f.locations.length) return null;
  const l = f.locations[0];
  const label = l.rowTitle ? `${l.pageTitle} › ${l.rowTitle}` : l.pageTitle;
  return f.locations.length > 1 ? `${label} +${f.locations.length - 1}` : label;
}

/** The ⋮ menu shared by grid cards and list rows. */
function useFileMenu(file: WorkspaceFile, onOpen: () => void, onSettings: () => void) {
  const { workspace, user } = useApp();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const canDelete = workspace.role === 'owner' || file.uploadedBy === user.id;

  const rename = async () => {
    const name = prompt('Rename', file.name)?.trim();
    if (!name || name === file.name) return;
    try {
      await renameFile(file.id, name);
      refreshFiles(workspace.id);
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete “${file.name}”?`,
      message: file.locations.length
        ? 'It will also be removed from the pages and cards it is on. This cannot be undone.'
        : 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFile(file.id);
      toast('Deleted');
      refreshFiles(workspace.id);
    } catch (err) {
      toastError(err);
    }
  };

  const menu = (
    <Menu anchor={anchor} onClose={() => setAnchor(null)} align="end">
      <MenuItem icon={<ExternalLink size={15} />} label="Open" onClick={onOpen} />
      <MenuItem icon={<Pencil size={15} />} label="Rename" onClick={rename} />
      <MenuItem icon={<Settings2 size={15} />} label="Settings & location" onClick={onSettings} />
      <MenuItem icon={<Download size={15} />} label="Download" onClick={() => (location.href = downloadUrl(file.url))} />
      {canDelete && (
        <>
          <MenuDivider />
          <MenuItem icon={<Trash2 size={15} />} label="Delete" danger onClick={remove} />
        </>
      )}
    </Menu>
  );
  return { menu, openMenu: (e: React.MouseEvent<HTMLElement>) => (e.stopPropagation(), setAnchor(e.currentTarget.getBoundingClientRect())) };
}

/** "Page 12 of 40" — where this person stopped in the file, if they've opened it before. */
function StoppedAt({ file }: { file: WorkspaceFile }) {
  const label = positionLabel(file.position?.position);
  if (!label) return null;
  return (
    <span className="mt-0.5 flex items-center gap-1 truncate text-xs font-medium text-accent" title={`You stopped here ${timeAgo(file.position!.updatedAt)}`}>
      <BookmarkCheck size={11} className="shrink-0" /> {label}
    </span>
  );
}

function NoteCard({ file, onOpen, onSettings }: { file: WorkspaceFile; onOpen: () => void; onSettings: () => void }) {
  const kind = kindOf(file);
  const { menu, openMenu } = useFileMenu(file, onOpen, onSettings);
  const where = locationText(file);
  return (
    <div data-menu-scope className="group min-w-0">
      <button
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e);
        }}
        className="relative block aspect-[3/4] w-full overflow-hidden rounded-xl border border-line bg-white text-left shadow-sm transition-shadow hover:shadow-pop"
      >
        <Thumbnail file={file} />
        {file.strokes > 0 && (
          <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white" title="Has handwriting">
            <Pencil size={10} /> {file.strokes}
          </span>
        )}
      </button>
      <div className="mt-2 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={file.name}>
            {file.name.replace(/\.pdf$/i, kind === 'note' ? '' : '.pdf')}
          </div>
          <div className="truncate text-xs text-faint">{timeAgo(file.updatedAt)}</div>
          <StoppedAt file={file} />
          {where && (
            <div className="mt-0.5 truncate text-xs text-muted" title={where}>
              {where}
            </div>
          )}
        </div>
        <button data-menu-button onClick={openMenu} className="hover-reveal flex size-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg" aria-label="More">
          <MoreVertical size={16} />
        </button>
      </div>
      {menu}
    </div>
  );
}

function NoteRow({ file, onOpen, onSettings }: { file: WorkspaceFile; onOpen: () => void; onSettings: () => void }) {
  const kind = kindOf(file);
  const { menu, openMenu } = useFileMenu(file, onOpen, onSettings);
  const where = locationText(file);
  return (
    <div data-menu-scope className="group flex items-center gap-3 bg-surface px-3 py-2 hover:bg-hover">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sidebar text-muted">
          <KindIcon kind={kind} size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{file.name}</span>
          <span className="block truncate text-xs text-faint">
            {kindLabel(kind)} · {timeAgo(file.updatedAt)}
            {where ? ` · ${where}` : ''}
          </span>
          <StoppedAt file={file} />
        </span>
      </button>
      <button data-menu-button onClick={openMenu} className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-active hover:text-fg" aria-label="More">
        <MoreVertical size={16} />
      </button>
      {menu}
    </div>
  );
}

/** A page-shaped preview: the first page of a PDF (with its handwriting), an image, or an icon. */
function Thumbnail({ file }: { file: WorkspaceFile }) {
  const kind = kindOf(file);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  // Office files are previewed through the server's PDF rendering of them (empty new files have none yet).
  const pdfLike = kind === 'pdf' || kind === 'note' || (isOffice(kind) && file.size > 0 && !/\.(txt|md|markdown)$/i.test(file.name));
  const preview = usePreview(file.id, visible && (kind === 'pdf' || kind === 'note') && file.strokes > 0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !pdfLike || !canvas.current) return;
    let cancelled = false;
    let destroy: (() => void) | null = null;
    (async () => {
      const pdfjs = await loadPdfjs();
      const task = pdfjs.getDocument({ url: isOffice(kind) ? `/api/files/${file.id}/preview.pdf?v=${encodeURIComponent(file.updatedAt)}` : file.url, withCredentials: true, ...pdfAssets() });
      destroy = () => task.destroy();
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const width = (box.current?.clientWidth || 200) * Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: width / base.width });
      const c = canvas.current!;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      setAspect(base.height / base.width);
      await page.render({ canvas: c, viewport }).promise;
    })().catch(() => {});
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [visible, kind, pdfLike, file.url, file.id, file.updatedAt]);

  if (kind === 'image') {
    return <div ref={box} className="size-full">{visible && <img src={file.url} alt="" className="size-full object-cover" loading="lazy" />}</div>;
  }
  if (!pdfLike) {
    return (
      <div ref={box} className="flex size-full flex-col items-center justify-center gap-2 bg-sidebar text-muted">
        <KindIcon kind={kind} size={30} />
        <span className="text-xs uppercase">{file.name.split('.').pop()?.slice(0, 6)}</span>
      </div>
    );
  }
  return (
    <div ref={box} className="relative size-full">
      <canvas ref={canvas} className="absolute top-0 left-0 w-full" />
      {aspect && preview.data && (
        <svg viewBox={`0 0 1 ${aspect}`} className="absolute top-0 left-0 w-full" style={{ aspectRatio: `1 / ${aspect}` }}>
          <InkItems items={preview.data.strokes.filter(isInkItem)} />
        </svg>
      )}
      {!aspect && <div className="absolute inset-0 flex items-center justify-center text-faint"><KindIcon kind={kind} size={26} /></div>}
    </div>
  );
}
