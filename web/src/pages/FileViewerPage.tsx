import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Pencil,
  Moon,
  Sun,
  ArrowLeft,
  Circle,
  Download,
  Eraser,
  FilePlus2,
  FileText,
  Hand,
  Highlighter,
  Keyboard,
  Minus,
  MoveUpRight,
  PenLine,
  Plus,
  Redo2,
  ScanLine,
  Shapes,
  Slash,
  Square,
  Triangle,
  Type,
  Undo2,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import * as Y from 'yjs';
import { getLocal, setLocal } from '../lib/storage';
import { useTheme } from '../lib/theme';
import { type Anchor, Menu, MenuItem, Popover, toastError } from '../components/ui';
import { api, downloadUrl } from '../lib/api';
import { type CollabSession, useCollab } from '../lib/collab';
import { useMe } from '../lib/queries';
import { type FilePosition, type SavedPosition, usePositionSaver } from '../lib/filePosition';
import {
  flattenPdf,
  HIGHLIGHTER_COLORS,
  HIGHLIGHTER_SIZES,
  hits,
  type InkItem,
  isInkItem,
  LOCAL,
  metaOf,
  PEN_COLORS,
  PEN_SIZES,
  type ShapeKind,
  strokesOf,
  TEXT_SIZES,
} from '../notes/ink';
import { type InkActions, InkLayer, type InkMode, type InkSettings } from '../notes/InkLayer';
import { isOffice, kindOf } from '../notes/api';
import { loadPdfjs, pdfAssets } from '../notes/pdf';

const OfficeView = lazy(() => import('../office/OfficeView'));
const ImageEditor = lazy(() => import('../media/ImageEditor'));
const VideoEditor = lazy(() => import('../media/VideoEditor'));
import 'pdfjs-dist/web/pdf_viewer.css';

interface FileInfo {
  id: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
  isNote: boolean;
  url: string;
  /** Where this person stopped in it. */
  position?: SavedPosition | null;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Opens an uploaded file in a tab of its own. PDFs are drawn with PDF.js rather than handed to the
 * browser, so they display everywhere (including Android Chrome and browsers set to "download PDFs"),
 * and can be written on with a pen, highlighter and eraser — shared live with everyone viewing the file.
 */
/** The viewer as its own page (/file/:id), or on top of a page (`overlay`, closed with `onClose`). */
export function FileViewerPage({ overlay }: { overlay?: { fileId: string; name?: string | null; onClose: () => void } } = {}) {
  const params = useParams();
  const fileId = overlay?.fileId ?? params.fileId ?? '';
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['file-info', fileId], queryFn: () => api<FileInfo>(`/api/files/${fileId}/info`), retry: false });
  const name = info.data?.name ?? (overlay ? overlay.name : search.get('name')) ?? 'File';

  useEffect(() => {
    const before = document.title;
    document.title = name;
    // On top of a page: give the page its title back when closed.
    return () => {
      if (overlay) document.title = before;
    };
  }, [name, overlay]);

  const file = info.data;
  // Handwritten notes are PDFs; documents, spreadsheets and presentations open in their editors.
  const detected = file ? kindOf(file) : null;
  const kind = detected === 'note' ? 'pdf' : detected;
  const office = !!kind && isOffice(kind);
  // Pictures and videos can be edited quickly (crop, turn, trim…).
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  const editable = !!file && (kind === 'image' || kind === 'video');

  const back = () => {
    if (overlay) return overlay.onClose();
    // Opened from inside the app: go back; opened in a new tab: go to the workspace's notes.
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else if (file) navigate(`/w/${file.workspaceId}/files`);
    else navigate('/');
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-sidebar">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg px-2 sm:px-3">
        <button onClick={back} className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg" title="Back" aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <FileText size={18} className="shrink-0 text-muted max-sm:hidden" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name}</div>
          {file && <div className="truncate text-xs text-muted">{formatSize(file.size)}</div>}
        </div>
        {file && editable && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm hover:bg-hover"
            title={kind === 'image' ? 'Crop, turn, flip, change the colours or the size' : 'Trim, take the sound out, turn or flip'}
          >
            <Pencil size={15} /> Edit
          </button>
        )}
        {file && kind !== 'pdf' && !office && !editing && <DownloadLink file={file} />}
        {file && (kind === 'pdf' || office) && <span id="viewer-actions" className="flex shrink-0 items-center gap-2" />}
      </header>
      <main className="min-h-0 flex-1">
        {info.isPending && <Spinner />}
        {info.isError && <Message text="This file doesn't exist or you don't have access to it." />}
        {file && kind === 'pdf' && <InkedPdf file={file} />}
        {file && office && (
          <Suspense fallback={<Spinner />}>
            <OfficeView
              key={file.id}
              file={file}
              kind={kind as 'document' | 'spreadsheet' | 'presentation'}
              renderOriginal={() => <PdfViewer file={file} ink={null} src={`/api/files/${file.id}/preview.pdf?v=${file.size}`} />}
            />
          </Suspense>
        )}
        {file && editing && (
          <Suspense fallback={<Spinner />}>
            {kind === 'image' ? (
              <ImageEditor
                file={file}
                onDone={(saved) => {
                  setEditing(false);
                  if (saved) setVersion((v) => v + 1);
                }}
              />
            ) : (
              <VideoEditor
                file={file}
                onDone={(saved) => {
                  setEditing(false);
                  if (saved) setVersion((v) => v + 1);
                }}
              />
            )}
          </Suspense>
        )}
        {file && kind !== 'pdf' && !office && !editing && (
          <div key={version} className="h-full overflow-auto">
            {kind === 'image' && (
              <div className="flex min-h-full items-center justify-center p-4">
                <img src={version ? `${file.url}?v=${version}` : file.url} alt={file.name} className="max-h-[calc(100vh-6rem)] max-w-full rounded shadow-pop" />
              </div>
            )}
            {kind === 'video' && (
              <div className="flex min-h-full items-center justify-center p-4">
                <Media file={file} kind="video" className="max-h-[calc(100vh-6rem)] max-w-full rounded" />
              </div>
            )}
            {kind === 'audio' && (
              <div className="flex min-h-full items-center justify-center p-4">
                <Media file={file} kind="audio" className="w-full max-w-lg" />
              </div>
            )}
            {kind === 'other' && <Message text="This file type can't be previewed. Use Download to save it." />}
          </div>
        )}
      </main>
    </div>
  );
}

/** A video or audio file that starts where this person stopped, and remembers where they stop. */
function Media({ file, kind, className }: { file: FileInfo; kind: 'video' | 'audio'; className: string }) {
  const savePlace = usePositionSaver(file.id);
  const start = useRef(file.position?.position.kind === 'time' ? file.position.position.seconds : 0);
  const props = {
    src: file.url,
    controls: true,
    className,
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      // Near the very end counts as finished: start again from the beginning.
      if (start.current > 0 && (!el.duration || start.current < el.duration - 3)) el.currentTime = start.current;
    },
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      if (el.duration) savePlace({ kind: 'time', seconds: Math.round(el.currentTime), duration: Math.round(el.duration) });
    },
  };
  return kind === 'video' ? <video {...props} /> : <audio {...props} />;
}

function DownloadLink({ file }: { file: FileInfo }) {
  return (
    <a
      href={downloadUrl(file.url)}
      download={file.name}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white hover:brightness-110"
    >
      <Download size={15} /> <span className="max-sm:hidden">Download</span>
    </a>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-16 text-muted">
      <span className="inline-block size-6 animate-spin rounded-full border-2 border-current border-e-transparent" />
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <div className="px-6 py-16 text-center text-sm text-muted">{text}</div>;
}

/** Connects to the file's live handwriting document, then shows the PDF with it. */
function InkedPdf({ file }: { file: FileInfo }) {
  const me = useMe();
  if (!me.data) return <Spinner />;
  return <InkedPdfInner file={file} user={me.data} />;
}

function InkedPdfInner({ file, user }: { file: FileInfo; user: NonNullable<ReturnType<typeof useMe>['data']> }) {
  const { session, synced, denied } = useCollab(`file:${file.id}`, user, () => {});
  return <PdfViewer file={file} ink={session && synced && !denied ? session : null} />;
}

type Zoom = number | 'fit';

const TOOL_KEY = 'af-ink-tool';

/** `recent` holds the custom colours picked for a tool, newest first. */
interface ToolPrefs {
  pen: { color: string; size: number; recent?: string[] };
  highlighter: { color: string; size: number; recent?: string[] };
  shape: { color: string; size: number; kind: ShapeKind; recent?: string[] };
  text: { color: string; size: number; recent?: string[] };
  finger: boolean;
  detectShapes: boolean;
}

const DEFAULT_PREFS: ToolPrefs = {
  pen: { color: PEN_COLORS[0], size: 1 },
  highlighter: { color: HIGHLIGHTER_COLORS[0], size: 1 },
  shape: { color: PEN_COLORS[0], size: 1, kind: 'rect' },
  text: { color: PEN_COLORS[0], size: 1 },
  finger: true,
  detectShapes: true,
};

function loadToolPrefs(): ToolPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(TOOL_KEY) ?? '{}') as Partial<ToolPrefs>;
    return {
      ...DEFAULT_PREFS,
      ...saved,
      pen: { ...DEFAULT_PREFS.pen, ...saved.pen },
      highlighter: { ...DEFAULT_PREFS.highlighter, ...saved.highlighter },
      shape: { ...DEFAULT_PREFS.shape, ...saved.shape },
      text: { ...DEFAULT_PREFS.text, ...saved.text },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const SHAPES: { kind: ShapeKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'line', label: 'Line', icon: <Slash size={16} /> },
  { kind: 'arrow', label: 'Arrow', icon: <MoveUpRight size={16} /> },
  { kind: 'rect', label: 'Rectangle', icon: <Square size={16} /> },
  { kind: 'ellipse', label: 'Ellipse', icon: <Circle size={16} /> },
  { kind: 'polygon', label: 'Triangle', icon: <Triangle size={16} /> },
];

const SHORTCUTS: [string, string][] = [
  ['V or Esc', 'Read and select text'],
  ['P', 'Pen'],
  ['H', 'Highlighter'],
  ['E', 'Eraser'],
  ['T', 'Text'],
  ['S', 'Shapes (press again for the next shape)'],
  ['[  ]', 'Smaller / bigger'],
  ['Shift while drawing', 'Straight line'],
  ['Shift with a shape', 'Square, circle or 45° line'],
  ['Hold still at the end', 'Turn the stroke into a shape, then drag to resize'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
];

/** Everything drawn or typed on the file, re-read whenever anyone changes it. */
function useInk(doc: Y.Doc | null) {
  const [items, setItems] = useState<InkItem[]>([]);
  const [extraPages, setExtraPages] = useState(0);
  useEffect(() => {
    if (!doc) return;
    const arr = strokesOf(doc);
    const meta = metaOf(doc);
    const read = () => setItems(arr.toArray().filter(isInkItem));
    const readMeta = () => setExtraPages(Math.max(0, Math.min(200, Number(meta.get('extraPages') ?? 0) || 0)));
    read();
    readMeta();
    arr.observe(read);
    meta.observe(readMeta);
    return () => {
      arr.unobserve(read);
      meta.unobserve(readMeta);
    };
  }, [doc]);
  return { items, extraPages };
}

/** A PDF, with handwriting when `ink` is given. `src` shows another PDF of the file (e.g. an office file's exact layout). */
function PdfViewer({ file, ink, src }: { file: FileInfo; ink: CollabSession | null; src?: string }) {
  const url = src ?? file.url;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState<Zoom>('fit');
  // Dark pages: the PDF drawn with its colours inverted (works for scanned pages too). Starts on in dark mode.
  const { resolved: appTheme } = useTheme();
  const [darkPages, setDarkPagesState] = useState<boolean>(() => getLocal<boolean | null>('af-pdf-dark', null) ?? appTheme === 'dark');
  const setDarkPages = (v: boolean) => {
    setDarkPagesState(v);
    setLocal('af-pdf-dark', v);
  };
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [lastSize, setLastSize] = useState<{ w: number; h: number } | null>(null);
  const [firstSize, setFirstSize] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<InkMode>(file.isNote ? 'pen' : 'read');
  const [prefs, setPrefs] = useState(loadToolPrefs);
  const [downloadMenu, setDownloadMenu] = useState<Anchor | null>(null);
  const [helpAnchor, setHelpAnchor] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const { items, extraPages } = useInk(ink?.doc ?? null);
  const undo = useMemo(() => (ink ? new Y.UndoManager([strokesOf(ink.doc), metaOf(ink.doc)], { trackedOrigins: new Set([LOCAL]) }) : null), [ink]);
  const [history, setHistory] = useState({ undo: false, redo: false });

  useEffect(() => {
    if (!undo) return;
    const update = () => setHistory({ undo: undo.canUndo(), redo: undo.canRedo() });
    undo.on('stack-item-added', update);
    undo.on('stack-item-popped', update);
    undo.on('stack-cleared', update);
    return () => undo.destroy();
  }, [undo]);

  useEffect(() => {
    try {
      localStorage.setItem(TOOL_KEY, JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

  useEffect(() => {
    let cancelled = false;
    let loading: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const task = pdfjs.getDocument({ url, withCredentials: true, ...pdfAssets() });
        loading = task;
        const loaded = await task.promise;
        const last = (await loaded.getPage(loaded.numPages)).getViewport({ scale: 1 });
        const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        setLastSize({ w: last.width, h: last.height });
        setFirstSize({ w: first.width, h: first.height });
        setDoc(loaded);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      loading?.destroy();
    };
  }, [url]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tool = mode === 'pen' || mode === 'highlighter' || mode === 'shape' || mode === 'text' ? mode : null;
  const colors = tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const sizes = tool === 'highlighter' ? HIGHLIGHTER_SIZES : tool === 'text' ? TEXT_SIZES : PEN_SIZES;
  const current = tool ? prefs[tool] : null;
  const setCurrent = (patch: Partial<{ color: string; size: number; kind: ShapeKind; recent: string[] }>) =>
    tool && setPrefs((p) => ({ ...p, [tool]: { ...p[tool], ...patch } }));
  /** A colour from the colour picker: used now, and kept among the tool's recent colours. */
  const pickCustom = (color: string) => {
    if (!tool) return;
    const c = color.toLowerCase();
    setPrefs((p) => {
      const recent = colors.includes(c) ? (p[tool].recent ?? []) : [c, ...(p[tool].recent ?? []).filter((r) => r !== c)].slice(0, 4);
      return { ...p, [tool]: { ...p[tool], color: c, recent } };
    });
  };

  // Keyboard: tool keys, [ ] for size, Ctrl/⌘+Z to undo and Ctrl/⌘+Shift+Z or Ctrl+Y to redo.
  useEffect(() => {
    if (!ink) return;
    const onKey = (e: KeyboardEvent) => {
      // Typing in a field (the text tool, the zoom box…) never switches tools.
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z' && !e.shiftKey) undo?.undo();
        else if ((k === 'z' && e.shiftKey) || k === 'y') undo?.redo();
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      const tools: Record<string, InkMode> = { v: 'read', escape: 'read', p: 'pen', h: 'highlighter', e: 'eraser', t: 'text' };
      if (tools[k]) setMode(tools[k]);
      else if (k === 's') {
        if (mode === 'shape') {
          const i = SHAPES.findIndex((s) => s.kind === prefs.shape.kind);
          setPrefs((p) => ({ ...p, shape: { ...p.shape, kind: SHAPES[(i + 1) % SHAPES.length].kind } }));
        }
        setMode('shape');
      } else if ((k === '[' || k === ']') && tool) {
        const next = Math.max(0, Math.min(sizes.length - 1, prefs[tool].size + (k === ']' ? 1 : -1)));
        setPrefs((p) => ({ ...p, [tool]: { ...p[tool], size: next } }));
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ink, undo, mode, prefs, tool, sizes.length]);

  const byPage = useMemo(() => {
    const map = new Map<number, InkItem[]>();
    for (const s of items) map.set(s.page, [...(map.get(s.page) ?? []), s]);
    return map;
  }, [items]);

  const actions = useMemo<InkActions>(() => {
    const arr = ink ? strokesOf(ink.doc) : null;
    const indexOf = (id: string) => (arr ? arr.toArray().findIndex((i) => i?.id === id) : -1);
    return {
      add: (item) => ink && ink.doc.transact(() => arr!.push([item]), LOCAL),
      update: (id, item) =>
        ink &&
        ink.doc.transact(() => {
          const i = indexOf(id);
          if (i < 0) return;
          arr!.delete(i, 1);
          arr!.insert(i, [item]);
        }, LOCAL),
      remove: (id) =>
        ink &&
        ink.doc.transact(() => {
          const i = indexOf(id);
          if (i >= 0) arr!.delete(i, 1);
        }, LOCAL),
      eraseAt: (pageIndex, x, y, radius) => {
        if (!ink) return;
        const doomed: number[] = [];
        arr!.toArray().forEach((s, i) => s?.page === pageIndex && hits(s, x, y, radius) && doomed.push(i));
        if (!doomed.length) return;
        ink.doc.transact(() => {
          for (const i of doomed.reverse()) arr!.delete(i, 1);
        }, LOCAL);
      },
    };
  }, [ink]);

  // A stylus was used: stop fingers drawing, so a resting palm or a scrolling finger doesn't leave marks.
  const onPen = useCallback(() => setPrefs((p) => (p.finger ? { ...p, finger: false } : p)), []);

  const addPage = () => {
    if (!ink) return;
    ink.doc.transact(() => metaOf(ink.doc).set('extraPages', extraPages + 1), LOCAL);
    const total = (doc?.numPages ?? 0) + extraPages + 1;
    setTimeout(() => document.getElementById(`ink-page-${total}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  };

  const downloadWithNotes = async () => {
    setBusy(true);
    try {
      const bytes = await flattenPdf(file.url, items, extraPages);
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = file.name.replace(/\.pdf$/i, '') + ' (with notes).pdf';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const total = (doc?.numPages ?? 0) + extraPages;
  // ----- Where you are: saved per person, restored on any device; zoom keeps the middle of the screen in place -----
  const pageEl = useCallback((n: number) => scroller.current?.querySelector<HTMLElement>(`#ink-page-${n}`) ?? null, []);
  /** The page at a point down the pages (in scroll coordinates), and how far down it that point is. */
  const pageAt = useCallback(
    (y: number) => {
      const count = scroller.current?.querySelectorAll('[id^="ink-page-"]').length ?? 0;
      let lo = 1;
      let hi = count;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const el = pageEl(mid);
        if (el && el.offsetTop <= y) lo = mid;
        else hi = mid - 1;
      }
      const el = pageEl(lo);
      return el ? { page: lo, offset: Math.min(1, Math.max(0, (y - el.offsetTop) / el.offsetHeight)), el } : null;
    },
    [pageEl],
  );
  const savePlace = usePositionSaver(src ? null : file.id);
  const restoreTo = useRef<FilePosition | null>(src ? null : (file.position?.position ?? null));
  const restored = useRef(!restoreTo.current || restoreTo.current.kind !== 'page');
  const touched = useRef(false);

  // Back to where this person stopped: re-applied while the pages above it get their real sizes.
  useEffect(() => {
    const target = restoreTo.current;
    if (!doc || width === 0 || restored.current || target?.kind !== 'page') return;
    const apply = () => {
      const el = scroller.current;
      const page = pageEl(Math.min(target.page, total));
      if (!el || !page || touched.current) return;
      el.scrollTop = page.offsetTop + target.offset * page.offsetHeight - 8;
    };
    const timers = [0, 150, 400, 900, 1600].map((ms) => setTimeout(apply, ms));
    const done = setTimeout(() => (restored.current = true), 1700);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(done);
    };
  }, [doc, width, total, pageEl]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (!restored.current || frame) return;
      frame = setTimeout(() => {
        frame = undefined;
        const at = pageAt(el.scrollTop + 8);
        if (at && total > 0) savePlace({ kind: 'page', page: at.page, pages: total, offset: Math.round(at.offset * 1000) / 1000 });
      }, 120);
    };
    const touch = () => {
      touched.current = true;
      restored.current = true;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.addEventListener(t, touch, { passive: true });
    return () => {
      clearTimeout(frame);
      el.removeEventListener('scroll', onScroll);
      for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.removeEventListener(t, touch);
    };
  }, [pageAt, savePlace, total]);

  /** The zoom as a number, even when fitting the width (so zooming from Fit doesn't jump). */
  const zoomNow = useCallback(() => {
    if (zoom !== 'fit') return zoom;
    const first = pageEl(1);
    return first && firstSize ? first.offsetWidth / firstSize.w / (96 / 72) : 1;
  }, [zoom, firstSize, pageEl]);
  const anchor = useRef<{ page: number; fy: number; fx: number } | null>(null);
  /** Zooms keeping what's in the middle of the screen in the middle. */
  const zoomTo = useCallback(
    (next: Zoom) => {
      const el = scroller.current;
      if (el) {
        const at = pageAt(el.scrollTop + el.clientHeight / 2);
        if (at) anchor.current = { page: at.page, fy: at.offset, fx: Math.min(1, Math.max(0, (el.scrollLeft + el.clientWidth / 2 - at.el.offsetLeft) / at.el.offsetWidth)) };
      }
      setZoom(typeof next === 'number' ? Math.min(4, Math.max(0.25, next)) : next);
    },
    [pageAt],
  );
  const zoomBy = (factor: number) => zoomTo(zoomNow() * factor);
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scroller.current;
    anchor.current = null;
    if (!a || !el) return;
    const page = pageEl(a.page);
    if (!page) return;
    el.scrollTop = page.offsetTop + a.fy * page.offsetHeight - el.clientHeight / 2;
    el.scrollLeft = page.offsetLeft + a.fx * page.offsetWidth - el.clientWidth / 2;
  }, [zoom, pageEl]);

  // Ctrl + mouse wheel (and pinching a touchpad) zooms the pages; pinching with two fingers too.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let factor = 1;
    let frame = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      factor *= Math.exp(-e.deltaY * 0.0025);
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          const f = factor;
          factor = 1;
          zoomTo(zoomNow() * f);
        });
    };
    let pinch: { d: number; f: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      pinch = { d: dist(e.touches), f: 1 };
      const c = content.current;
      if (c) c.style.transformOrigin = `${el.scrollLeft + el.clientWidth / 2}px ${el.scrollTop + el.clientHeight / 2}px`;
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.f = dist(e.touches) / pinch.d;
      if (content.current) content.current.style.transform = `scale(${pinch.f})`;
    };
    const onEnd = () => {
      if (!pinch) return;
      const f = pinch.f;
      pinch = null;
      if (content.current) content.current.style.transform = '';
      if (Math.abs(f - 1) > 0.02) zoomTo(zoomNow() * f);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [zoomTo, zoomNow]);

  if (error) return <Message text="This PDF couldn't be displayed. Use Download to save it." />;

  const strokeSizes = mode === 'highlighter' ? HIGHLIGHTER_SIZES : PEN_SIZES;
  const strokePrefs = mode === 'highlighter' ? prefs.highlighter : mode === 'shape' ? prefs.shape : prefs.pen;
  const inkSettings: InkSettings = {
    mode,
    color: strokePrefs.color,
    width: strokeSizes[Math.min(strokeSizes.length - 1, strokePrefs.size)],
    finger: prefs.finger,
    shape: prefs.shape.kind,
    detectShapes: prefs.detectShapes,
    textColor: prefs.text.color,
    textSize: TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, prefs.text.size)],
  };

  return (
    <div className="flex h-full flex-col">
      {!src && (
      <HeaderPortal>
        <button
          onClick={(e) => setDownloadMenu(e.currentTarget.getBoundingClientRect())}
          disabled={busy}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white hover:brightness-110 disabled:opacity-60"
        >
          <Download size={15} /> <span className="max-sm:hidden">{busy ? 'Preparing…' : 'Download'}</span>
        </button>
        <Menu anchor={downloadMenu} onClose={() => setDownloadMenu(null)} align="end">
          <MenuItem icon={<PenLine size={15} />} label="With my notes" onClick={downloadWithNotes} />
          <MenuItem icon={<Download size={15} />} label="Original file" onClick={() => (location.href = downloadUrl(file.url))} />
        </Menu>
      </HeaderPortal>
      )}

      {ink && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-bg px-2 py-1.5 lg:justify-center">
          <ToolButton label="Read and select text (V)" active={mode === 'read'} onClick={() => setMode('read')}>
            <Hand size={17} />
          </ToolButton>
          <ToolButton label="Pen (P)" active={mode === 'pen'} onClick={() => setMode('pen')}>
            <PenLine size={17} />
          </ToolButton>
          <ToolButton label="Highlighter (H)" active={mode === 'highlighter'} onClick={() => setMode('highlighter')}>
            <Highlighter size={17} />
          </ToolButton>
          <ToolButton label="Shapes (S)" active={mode === 'shape'} onClick={() => setMode('shape')}>
            <Shapes size={17} />
          </ToolButton>
          <ToolButton label="Text (T)" active={mode === 'text'} onClick={() => setMode('text')}>
            <Type size={17} />
          </ToolButton>
          <ToolButton label="Eraser (E)" active={mode === 'eraser'} onClick={() => setMode('eraser')}>
            <Eraser size={17} />
          </ToolButton>
          {mode === 'shape' && (
            <>
              <Divider />
              {SHAPES.map((s) => (
                <ToolButton key={s.kind} label={s.label} active={prefs.shape.kind === s.kind} onClick={() => setCurrent({ kind: s.kind })}>
                  {s.icon}
                </ToolButton>
              ))}
            </>
          )}
          {tool && current && (
            <>
              <Divider />
              {[...colors, ...(current.recent ?? []).filter((c) => !colors.includes(c))].map((c) => (
                <button
                  key={c}
                  onClick={() => setCurrent({ color: c })}
                  aria-label={`Color ${c}`}
                  className={clsx('size-7 shrink-0 rounded-full border border-line ring-offset-2 ring-offset-bg', current.color === c && 'ring-2 ring-accent')}
                  style={{ background: c }}
                />
              ))}
              <ColorPickerSwatch value={current.color} onPreview={(c) => setCurrent({ color: c })} onPick={pickCustom} />
              <Divider />
              {sizes.map((s, i) => (
                <button
                  key={s}
                  onClick={() => setCurrent({ size: i })}
                  aria-label={`Size ${i + 1}`}
                  title={tool === 'text' ? `Text size ${i + 1}` : `Size ${i + 1}`}
                  className={clsx('flex size-8 shrink-0 items-center justify-center rounded-md', current.size === i ? 'bg-active' : 'hover:bg-hover')}
                >
                  {tool === 'text' ? (
                    <span className="font-semibold text-fg" style={{ fontSize: 10 + i * 2.5 }}>
                      A
                    </span>
                  ) : (
                    <span className="rounded-full bg-fg" style={{ width: 4 + i * 3, height: 4 + i * 3, opacity: tool === 'highlighter' ? 0.5 : 1 }} />
                  )}
                </button>
              ))}
            </>
          )}
          <Divider />
          <ToolButton label="Undo (Ctrl+Z)" disabled={!history.undo} onClick={() => undo?.undo()}>
            <Undo2 size={17} />
          </ToolButton>
          <ToolButton label="Redo (Ctrl+Y)" disabled={!history.redo} onClick={() => undo?.redo()}>
            <Redo2 size={17} />
          </ToolButton>
          <ToolButton label="Add a blank page at the end" onClick={addPage}>
            <FilePlus2 size={17} />
          </ToolButton>
          {(mode === 'pen' || mode === 'highlighter') && (
            <Switch
              label="Shape detection"
              title="Hold still at the end of a stroke to turn it into a clean line, circle, rectangle or triangle"
              checked={prefs.detectShapes}
              onChange={(v) => setPrefs((p) => ({ ...p, detectShapes: v }))}
            />
          )}
          {mode !== 'read' && (
            <Switch label="Draw with finger" title="Off: only a stylus draws, fingers scroll" checked={prefs.finger} onChange={(v) => setPrefs((p) => ({ ...p, finger: v }))} />
          )}
          <ToolButton label="Keyboard shortcuts" onClick={(e) => setHelpAnchor(e.currentTarget.getBoundingClientRect())}>
            <Keyboard size={17} />
          </ToolButton>
        </div>
      )}
      <Popover anchor={helpAnchor} onClose={() => setHelpAnchor(null)} align="end">
        <div className="w-80 p-3 text-sm">
          <div className="mb-2 font-medium">Drawing shortcuts</div>
          <div className="space-y-1.5">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys} className="flex items-start justify-between gap-3">
                <span className="text-muted">{what}</span>
                <kbd className="shrink-0 rounded border border-line bg-sidebar px-1.5 py-0.5 font-mono text-[11px]">{keys}</kbd>
              </div>
            ))}
          </div>
        </div>
      </Popover>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto" style={{ touchAction: 'pan-x pan-y' }}>
        {!doc && <Spinner />}
        {doc && width > 0 && (
          <div ref={content} className="flex w-max min-w-full flex-col items-center gap-3 px-2 py-4 sm:px-6">
            {Array.from({ length: total }, (_, i) => (
              <PdfPage
                key={i}
                doc={doc}
                index={i + 1}
                blank={i >= doc.numPages ? lastSize : null}
                estimate={firstSize}
                zoom={zoom}
                available={width - 16}
                onVisible={setPage}
                items={byPage.get(i) ?? EMPTY}
                ink={ink ? inkSettings : null}
                actions={actions}
                onPen={onPen}
                dark={darkPages}
              />
            ))}
          </div>
        )}
        {doc && (
          <div className="sticky bottom-4 z-10 mx-auto mb-4 flex w-max items-center gap-1 rounded-full border border-line bg-surface/95 px-2 py-1 text-sm shadow-pop backdrop-blur">
            <span className="px-2 text-muted tabular-nums">
              {page} / {total}
            </span>
            <RoundButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
              <Minus size={15} />
            </RoundButton>
            <span className="w-12 text-center text-xs text-muted tabular-nums">{zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
            <RoundButton label="Zoom in" onClick={() => zoomBy(1.2)}>
              <Plus size={15} />
            </RoundButton>
            <RoundButton label="Fit to width" onClick={() => zoomTo('fit')}>
              <ScanLine size={15} />
            </RoundButton>
            <RoundButton label={darkPages ? 'Light pages' : 'Dark pages'} onClick={() => setDarkPages(!darkPages)}>
              {darkPages ? <Sun size={15} /> : <Moon size={15} />}
            </RoundButton>
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY: InkItem[] = [];

function Switch({ label, title, checked, onChange }: { label: string; title: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title={title}
      className="ms-1 flex h-9 shrink-0 items-center gap-2 rounded-lg px-2 text-xs whitespace-nowrap text-muted hover:bg-hover hover:text-fg"
    >
      <span className={clsx('relative h-4 w-7 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-active')}>
        <span className={clsx('absolute top-0.5 size-3 rounded-full bg-white shadow transition-all', checked ? 'start-3.5' : 'start-0.5')} />
      </span>
      {label}
    </button>
  );
}

/** Puts the PDF's download button in the page header. */
function HeaderPortal({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById('viewer-actions')), []);
  return host ? createPortal(children, host) : null;
}

function Divider() {
  return <span className="mx-1 h-6 w-px shrink-0 bg-line" />;
}

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={clsx(
        'flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-35',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function RoundButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  index: number;
  /** Set for blank pages added after the PDF's own pages: the size to draw them at. */
  blank: { w: number; h: number } | null;
  /** The size to draw it at until its own is known (the first page's). */
  estimate: { w: number; h: number } | null;
  zoom: Zoom;
  available: number;
  onVisible: (n: number) => void;
  items: InkItem[];
  ink: InkSettings | null;
  actions: InkActions;
  onPen: () => void;
  /** Draw the page dark (colours inverted; the handwriting keeps its own colours). */
  dark: boolean;
}

/** One page: sized up front from its viewport, drawn only once it scrolls near the screen, with its handwriting on top. */
const PdfPage = memo(function PdfPage({ doc, index, blank, estimate, zoom, available, onVisible, items, ink, actions, onPen, dark }: PageProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(blank);
  const [near, setNear] = useState(index <= 2);

  useEffect(() => {
    if (blank) {
      setSize(blank);
      return;
    }
    let alive = true;
    doc
      .getPage(index)
      .then((p) => {
        if (!alive) return;
        const base = p.getViewport({ scale: 1 });
        setSize({ w: base.width, h: base.height });
      })
      .catch(() => {}); // the document was closed while loading
    return () => {
      alive = false;
    };
  }, [doc, index, blank]);

  // Until its own size is known, a page is drawn the size of the first one, so the pages above keep their place.
  const known = size ?? estimate;
  const scale = known ? (zoom === 'fit' ? Math.min(available, 1100) / known.w : zoom * (96 / 72)) : 1;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setNear(true);
          if (e.intersectionRatio > 0.5) onVisible(index);
        }
      },
      { rootMargin: '800px 0px', threshold: [0, 0.5] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [index, onVisible]);

  useEffect(() => {
    if (blank || !near || !size || !canvas.current || !textLayer.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    let text: { cancel: () => void } | null = null;
    (async () => {
      const pdfjs = await loadPdfjs();
      const p = await doc.getPage(index);
      if (cancelled) return;
      const viewport = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      const render = p.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      task = render;
      await render.promise.catch(() => {});
      if (cancelled) return;
      // Selectable text over the page, so text can be copied and found with Ctrl+F.
      const layer = textLayer.current!;
      layer.replaceChildren();
      for (const [k, v] of [['--scale-factor', String(scale)], ['--total-scale-factor', String(scale)], ['--scale-round-x', '1px'], ['--scale-round-y', '1px']]) layer.style.setProperty(k, v);
      const tl = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: layer, viewport });
      text = tl;
      await tl.render().catch(() => {});
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
      text?.cancel();
    };
  }, [near, size, scale, doc, index, blank]);

  const w = known ? known.w * scale : Math.min(available, 800);
  const h = known ? known.h * scale : w * 1.3;
  return (
    <div id={`ink-page-${index}`} ref={box} className={clsx('relative shrink-0 shadow-pop', dark ? 'pdf-dark bg-[#1e1e1e]' : 'bg-white')} style={{ width: w, height: h }}>
      {!blank && <canvas ref={canvas} className="absolute inset-0" style={{ width: w, height: h, filter: dark ? 'invert(0.88) hue-rotate(180deg) saturate(1.7) contrast(1.05)' : undefined }} />}
      {!blank && <div ref={textLayer} className="textLayer" />}
      <InkLayer page={index - 1} aspect={h / w} pxWidth={w} items={items} ink={ink} actions={actions} onPen={onPen} />
    </div>
  );
});

/** A rainbow swatch that opens the system colour picker. The colour applies as it's chosen and is kept once the picker closes. */
function ColorPickerSwatch({ value, onPreview, onPick }: { value: string; onPreview: (color: string) => void; onPick: (color: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const el = input.current;
    // React's onChange fires on every move; the native "change" event fires once, when the picker closes.
    const done = () => el && pick.current(el.value);
    el?.addEventListener('change', done);
    return () => el?.removeEventListener('change', done);
  }, []);
  return (
    <label
      title="Pick any colour"
      className="relative size-7 shrink-0 cursor-pointer rounded-full border border-line"
      style={{ background: 'conic-gradient(#f44, #fd4, #4d6, #4cf, #66f, #d4f, #f44)' }}
    >
      <span className="sr-only">Pick any colour</span>
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
        ref={input}
        onChange={(e) => onPreview(e.target.value)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </label>
  );
}
