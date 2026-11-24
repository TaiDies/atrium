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
  ChevronLeft,
  ChevronRight,
  Settings2,
  BookOpen,
  Rows3,
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
import { saveUrl } from '../lib/save';
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

/** How the PDF viewer shows pages (kept on this device). */
interface ViewPrefs {
  /** One column of pages, or two side by side like an open book. */
  layout: 'scroll' | 'book';
  /** Book layout: the first page on its own, like a cover, so left and right pages pair up as printed. */
  cover: boolean;
  /** Book layout: which side the first page of a pair goes. Auto: right to left for Arabic, Hebrew and Persian text. */
  direction: 'auto' | 'ltr' | 'rtl';
  /** Draw pages before they come into view: `ahead` pages before and after the one you're on. */
  preload: boolean;
  ahead: number;
  /** Free the drawings of pages far from view: big files use less memory; scrolling back redraws them. */
  unload: boolean;
  /** Scrolling settles on the top of a page (or pair of pages). */
  snap: boolean;
  /** Sharp: the screen's full resolution. Faster: fewer pixels to draw, for slow devices. */
  quality: 'sharp' | 'fast';
  /** What Fit fits on screen: the page's width, or the whole page. */
  fit: 'width' | 'page';
}
const VIEW_KEY = 'atrium-pdf-view';
const VIEW_DEFAULTS: ViewPrefs = { layout: 'scroll', cover: true, direction: 'auto', preload: true, ahead: 2, unload: false, snap: false, quality: 'sharp', fit: 'width' };
const MAX_AHEAD = 50;
/**
 * Pages already drawn stay drawn while they're this close to the page being read (or the pages drawn
 * ahead, if more), so scrolling back a little is instant. Further away they're cleared: each drawn page
 * holds 8–25 MB, and keeping every page of a long book drawn filled memory until everything slowed down.
 */
const KEEP_NEAR = 6;
function loadViewPrefs(): ViewPrefs {
  const saved = getLocal<Partial<ViewPrefs> | null>(VIEW_KEY, null) ?? {};
  const v = { ...VIEW_DEFAULTS, ...saved };
  return { ...v, ahead: Math.min(MAX_AHEAD, Math.max(1, Math.round(Number(v.ahead) || VIEW_DEFAULTS.ahead))) };
}

const TOOL_KEY = 'atrium-ink-tool';

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

type FlatState = 'ready' | 'pending' | 'notext' | 'failed' | 'unknown';

/**
 * Whether the server's "without text" copy of a PDF is ready. Asked once when the viewer opens (so the
 * setting can say), and every few seconds while it's wanted and still being made.
 */
function useFlatCopy(fileUrl: string | null, wanted: boolean): FlatState {
  const [state, setState] = useState<FlatState>('unknown');
  useEffect(() => {
    if (!fileUrl) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const res = await fetch(`${fileUrl}/flat?status=1`, { credentials: 'same-origin', cache: 'no-store' });
        const s = res.ok ? ((await res.json()) as { status: FlatState }).status : 'failed';
        if (!alive) return;
        setState(s);
        if (s === 'pending' && wanted) timer = setTimeout(ask, 4000);
      } catch {
        if (alive && wanted) timer = setTimeout(ask, 8000);
      }
    };
    void ask();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fileUrl, wanted]);
  return state;
}

/** A PDF, with handwriting when `ink` is given. `src` shows another PDF of the file (e.g. an office file's exact layout). */
function PdfViewer({ file, ink, src }: { file: FileInfo; ink: CollabSession | null; src?: string }) {
  // "Without text": the server's copy of the PDF with every page as a picture (server/src/pdfFlat.ts),
  // much lighter to show for big books full of text. Chosen per file on this device; only one of the
  // two is loaded at a time.
  const flatKey = `atrium-pdf-flat:${file.id}`;
  const [textless, setTextlessState] = useState<boolean>(() => !src && getLocal<boolean>(flatKey, false));
  const flat = useFlatCopy(src ? null : file.url, textless);
  const url = src ?? (textless && flat === 'ready' ? `${file.url}/flat` : file.url);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState<Zoom>('fit');
  // Dark pages: the PDF drawn with its colours inverted (works for scanned pages too). Starts on in dark mode.
  const { resolved: appTheme } = useTheme();
  const [darkPages, setDarkPagesState] = useState<boolean>(() => getLocal<boolean | null>('atrium-pdf-dark', null) ?? appTheme === 'dark');
  const setDarkPages = (v: boolean) => {
    setDarkPagesState(v);
    setLocal('atrium-pdf-dark', v);
  };
  const [view, setViewState] = useState(loadViewPrefs);
  const [settingsAnchor, setSettingsAnchor] = useState<Anchor | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  // Whether the PDF's text is mostly right-to-left script (for the book layout's page order).
  const [rtlText, setRtlText] = useState(false);
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    (async () => {
      let rtl = 0;
      let ltr = 0;
      for (let n = 1; n <= Math.min(doc.numPages, 8) && rtl + ltr < 2000; n++) {
        const content = await (await doc.getPage(n)).getTextContent();
        for (const item of content.items) {
          const s = 'str' in item ? item.str : '';
          rtl += (s.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
          ltr += (s.match(/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/g) ?? []).length;
        }
      }
      if (alive) setRtlText(rtl > ltr);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [doc]);
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

  const shownUrl = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let loading: { destroy: () => Promise<void> } | null = null;
    // Switching between the original and the copy: the other one is dropped completely (the previous
    // load's cleanup destroyed it), and the new one opens on the same page.
    if (shownUrl.current && shownUrl.current !== url) {
      const el = scroller.current;
      const at = el && view.layout !== 'book' ? pageAt(el.scrollTop + 8) : null;
      const n = at?.page ?? pageNow.current;
      restoreTo.current = { kind: 'page', page: n, pages: total, offset: at ? at.offset : 0 };
      restored.current = false;
      touched.current = false;
      setDoc(null);
    }
    shownUrl.current = url;
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
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
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
  const book = view.layout === 'book';
  const rtl = view.direction === 'rtl' || (view.direction === 'auto' && rtlText);
  /** The pages, one per row, or in pairs for the book layout (the cover alone when chosen). */
  const rows = useMemo(() => {
    const pages = Array.from({ length: total }, (_, i) => i + 1);
    if (!book) return pages.map((p) => [p]);
    const out: number[][] = [];
    let i = 0;
    if (view.cover && pages.length) out.push([pages[i++]]);
    for (; i < pages.length; i += 2) out.push(pages.slice(i, i + 2));
    return out;
  }, [total, book, view.cover]);

  // ----- Book view: one pair of pages at a time, flipped left and right -----
  const [spread, setSpread] = useState(0);
  const pageNow = useRef(page);
  pageNow.current = page;
  const spreadOf = useCallback((p: number) => Math.max(0, rows.findIndex((r) => r.includes(p))), [rows]);
  // Opening the book view (or pairing pages differently): start at the page you were on.
  useEffect(() => {
    if (book) setSpread(spreadOf(pageNow.current));
  }, [book, spreadOf]);
  const shown = book ? (rows[Math.min(spread, rows.length - 1)] ?? []) : [];
  const flip = useCallback((step: number) => setSpread((s) => Math.min(rows.length - 1, Math.max(0, s + step))), [rows.length]);
  /** Flips toward the left or right edge: forward is to the left in right-to-left books. */
  const flipSide = useCallback((side: 'left' | 'right') => flip((side === 'right') !== rtl ? 1 : -1), [flip, rtl]);
  useEffect(() => {
    if (!book || !shown.length) return;
    setPage(shown[0]);
    scroller.current?.scrollTo({ top: 0, left: 0 });
    if (restored.current && total > 0) savePlace({ kind: 'page', page: shown[0], pages: total, offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, shown[0], total]);
  // Pages kept on hand in the book view: the open pair, the pages ahead, and (unless far pages are
  // freed) the pages already seen near the open pair, so flipping back a little is instant.
  const seenPages = useRef(new Set<number>());
  const bookPages = useMemo(() => {
    if (!book || !shown.length) return [];
    const keep = new Set(shown);
    if (view.preload) for (let n = shown[0] - view.ahead; n <= shown[shown.length - 1] + view.ahead; n++) if (n >= 1 && n <= total) keep.add(n);
    const near = Math.max(KEEP_NEAR, view.ahead);
    if (view.unload) seenPages.current.clear();
    else
      for (const n of [...seenPages.current]) {
        if (Math.abs(n - shown[0]) <= near) keep.add(n);
        else seenPages.current.delete(n);
      }
    for (const n of keep) seenPages.current.add(n);
    return [...keep].sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, shown[0], shown.length, view.preload, view.ahead, view.unload, total]);

  // Swiping sideways in reading mode flips. (In the book view the mouse wheel zooms: see below.)
  useEffect(() => {
    const el = scroller.current;
    if (!el || !book) return;
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      start = e.touches.length === 1 && mode === 'read' ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || el.scrollWidth > el.clientWidth + 2) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start = null;
      // A swipe to the left brings in the page on the right.
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) flipSide(dx < 0 ? 'right' : 'left');
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, [book, flipSide, mode]);

  // Arrow keys, Page Up/Down and space flip; Home and End go to the covers.
  useEffect(() => {
    if (!book) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowRight') flipSide('right');
      else if (e.key === 'ArrowLeft') flipSide('left');
      else if (e.key === 'PageDown' || e.key === ' ' || e.key === 'ArrowDown') flip(1);
      else if (e.key === 'PageUp' || e.key === 'ArrowUp') flip(-1);
      else if (e.key === 'Home') setSpread(0);
      else if (e.key === 'End') setSpread(rows.length - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [book, flip, flipSide, rows.length]);
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
    if (book) {
      setSpread(spreadOf(Math.min(target.page, total)));
      restored.current = true;
      return;
    }
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
  }, [doc, width, total, pageEl, book, spreadOf]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (book || !restored.current || frame) return;
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
  }, [pageAt, savePlace, total, book]);

  // The page you're on: the one in the middle of the screen (works however tall the pages are). It
  // drives the page counter and which pages are drawn ahead.
  useEffect(() => {
    const el = scroller.current;
    if (!el || book) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      timer = undefined;
      const at = pageAt(el.scrollTop + el.clientHeight / 2);
      if (at) setPage(at.page);
    };
    const onScroll = () => {
      timer ??= setTimeout(update, 60);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener('scroll', onScroll);
    };
  }, [pageAt, doc, rows, book]);

  /** The zoom as a number, even when fitting the width (so zooming from Fit doesn't jump). */
  const zoomNow = useCallback(() => {
    if (zoom !== 'fit') return zoom;
    const first = pageEl(1);
    return first && firstSize ? first.offsetWidth / firstSize.w / (96 / 72) : 1;
  }, [zoom, firstSize, pageEl]);
  /** What to keep in place across a zoom: a point on a page, kept in the middle of the screen or, with `at`, under the pointer. */
  const anchor = useRef<{ page: number; fy: number; fx: number; at?: { x: number; y: number } } | null>(null);
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
  /** Zooms keeping the point under the pointer (screen coordinates) where it is. */
  const zoomAt = useCallback(
    (next: number, x: number, y: number) => {
      const hit = document.elementsFromPoint(x, y).map((e) => e.closest<HTMLElement>('[id^="ink-page-"]')).find(Boolean);
      if (!hit || !scroller.current?.contains(hit)) return zoomTo(next);
      const r = hit.getBoundingClientRect();
      anchor.current = { page: Number(hit.id.slice('ink-page-'.length)), fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, at: { x, y } };
      setZoom(Math.min(4, Math.max(0.25, next)));
    },
    [zoomTo],
  );
  /** Changes how pages are shown, keeping the page in the middle of the screen in view. */
  const setView = useCallback(
    (patch: Partial<ViewPrefs>) => {
      const el = scroller.current;
      if (el && !book && ('layout' in patch || 'cover' in patch || 'fit' in patch)) {
        const at = pageAt(el.scrollTop + el.clientHeight / 2);
        if (at) anchor.current = { page: at.page, fy: at.offset, fx: 0.5 };
      } else if (book && patch.layout === 'scroll') anchor.current = { page: pageNow.current, fy: 0, fx: 0.5 };
      setViewState((v) => {
        const next = { ...v, ...patch };
        setLocal(VIEW_KEY, next);
        return next;
      });
    },
    [pageAt, book],
  );
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scroller.current;
    anchor.current = null;
    if (!a || !el) return;
    const page = pageEl(a.page);
    if (!page) return;
    if (a.at) {
      const r = page.getBoundingClientRect();
      el.scrollLeft += r.left + a.fx * r.width - a.at.x;
      el.scrollTop += r.top + a.fy * r.height - a.at.y;
      return;
    }
    el.scrollTop = page.offsetTop + a.fy * page.offsetHeight - el.clientHeight / 2;
    el.scrollLeft = page.offsetLeft + a.fx * page.offsetWidth - el.clientWidth / 2;
  }, [zoom, pageEl, view.layout, view.cover, view.fit]);

  // Ctrl + mouse wheel (and pinching a touchpad) zooms the pages where the pointer is; in the book view
  // the wheel alone does. Pinching with two fingers zooms too.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let factor = 1;
    let frame = 0;
    let point = { x: 0, y: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && !book) return;
      e.preventDefault();
      // Lines or pages of scrolling (some mice) count as about 40 or 800 pixels.
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      factor *= Math.exp(-dy * 0.0025);
      point = { x: e.clientX, y: e.clientY };
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          const f = factor;
          factor = 1;
          zoomAt(zoomNow() * f, point.x, point.y);
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
  }, [zoomTo, zoomAt, zoomNow, book]);

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
          <MenuItem icon={<Download size={15} />} label="Original file" onClick={() => void saveUrl(file.url, file.name)} />
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

      <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="absolute inset-0 overflow-auto"
        style={{ touchAction: 'pan-x pan-y', scrollSnapType: view.snap && !book ? 'y proximity' : undefined }}
      >
        {!doc && <Spinner />}
        {doc && width > 0 && book && (
          // Book view: the open pair fills the screen; the pages ahead wait hidden, already drawn.
          <div
            ref={content}
            className={clsx('flex w-max min-w-full items-center justify-center gap-3 px-2 py-3 sm:px-12', rtl && 'flex-row-reverse')}
            style={{ minHeight: 'calc(100% - 64px)' }}
          >
            {bookPages.map((n) => (
              <PdfPage
                key={n}
                doc={doc}
                index={n}
                hidden={!shown.includes(n)}
                blank={n > doc.numPages ? lastSize : null}
                estimate={firstSize}
                zoom={zoom}
                fit="page"
                available={(width - (width < 640 ? 16 : 96) - 12) / 2}
                fitCap={4000}
                availableHeight={height - 64 - 24}
                wanted
                unload={view.unload || Math.abs(n - shown[0]) > Math.max(KEEP_NEAR, view.ahead)}
                sharp={view.quality === 'sharp'}
                items={byPage.get(n - 1) ?? EMPTY}
                ink={ink ? inkSettings : null}
                actions={actions}
                onPen={onPen}
                dark={darkPages}
              />
            ))}
          </div>
        )}
        {doc && width > 0 && !book && (
          <div ref={content} className="flex w-max min-w-full flex-col items-center gap-3 px-2 pt-4 pb-20 sm:px-6">
            {rows.map((row) => (
              <div key={`${view.layout}-${row[0]}`} className={clsx('flex items-start gap-3', rtl && 'flex-row-reverse')} style={view.snap ? { scrollSnapAlign: 'start', scrollMarginTop: 12 } : undefined}>
                {row.map((n) => (
                  <PdfPage
                    key={n}
                    doc={doc}
                    index={n}
                    blank={n > doc.numPages ? lastSize : null}
                    estimate={firstSize}
                    zoom={zoom}
                    fit={view.fit}
                    available={book ? (width - 16 - 12) / 2 : width - 16}
                    fitCap={book ? 900 : 1100}
                    availableHeight={height - 32}
                    wanted={view.preload && Math.abs(n - page) <= view.ahead}
                    unload={view.unload || Math.abs(n - page) > Math.max(KEEP_NEAR, view.ahead)}
                    sharp={view.quality === 'sharp'}
                    items={byPage.get(n - 1) ?? EMPTY}
                    ink={ink ? inkSettings : null}
                    actions={actions}
                    onPen={onPen}
                    dark={darkPages}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        <Popover anchor={settingsAnchor} onClose={() => setSettingsAnchor(null)} align="end">
          <ViewSettings
            view={view}
            onChange={setView}
            dark={darkPages}
            onDark={setDarkPages}
            detectedRtl={rtlText}
            copy={src ? null : { textless, flat, onChange: (v) => (setTextlessState(v), setLocal(flatKey, v)) }}
          />
        </Popover>
      </div>
      {/* The bar stays put at the bottom however the pages are zoomed or scrolled. */}
      {doc && (
        <div className="absolute bottom-4 left-1/2 z-10 flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-surface/95 px-2 py-1 text-sm shadow-pop backdrop-blur">
          {book && (
            <RoundButton label={rtl ? 'Next pages' : 'Previous pages'} onClick={() => flipSide('left')}>
              <ChevronLeft size={16} />
            </RoundButton>
          )}
          <span className="px-2 text-muted tabular-nums">
            {book && shown.length > 1 ? `${shown[0]}–${shown[shown.length - 1]}` : book ? shown[0] : page} / {total}
          </span>
          {book && (
            <RoundButton label={rtl ? 'Previous pages' : 'Next pages'} onClick={() => flipSide('right')}>
              <ChevronRight size={16} />
            </RoundButton>
          )}
          <RoundButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <Minus size={15} />
          </RoundButton>
          <span className="w-12 text-center text-xs text-muted tabular-nums">{zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
          <RoundButton label="Zoom in" onClick={() => zoomBy(1.2)}>
            <Plus size={15} />
          </RoundButton>
          <RoundButton label={book ? 'Fit to screen' : view.fit === 'page' ? 'Fit the whole page' : 'Fit to width'} onClick={() => zoomTo('fit')}>
            <ScanLine size={15} />
          </RoundButton>
          <RoundButton label={darkPages ? 'Light pages' : 'Dark pages'} onClick={() => setDarkPages(!darkPages)}>
            {darkPages ? <Sun size={15} /> : <Moon size={15} />}
          </RoundButton>
          <RoundButton label="View settings" onClick={(e) => setSettingsAnchor(e.currentTarget.getBoundingClientRect())}>
            <Settings2 size={15} />
          </RoundButton>
        </div>
      )}
      {doc && book && (
        <>
          <EdgeButton side="left" label={rtl ? 'Next pages' : 'Previous pages'} disabled={rtl ? spread >= rows.length - 1 : spread <= 0} onClick={() => flipSide('left')} />
          <EdgeButton side="right" label={rtl ? 'Previous pages' : 'Next pages'} disabled={rtl ? spread <= 0 : spread >= rows.length - 1} onClick={() => flipSide('right')} />
        </>
      )}
      </div>
    </div>
  );
}

const EMPTY: InkItem[] = [];

/** The viewer's settings: layout, fitting, drawing pages ahead, memory and sharpness. Kept on this device. */
function ViewSettings({
  view,
  onChange,
  dark,
  onDark,
  detectedRtl,
  copy,
}: {
  view: ViewPrefs;
  onChange: (patch: Partial<ViewPrefs>) => void;
  dark: boolean;
  onDark: (v: boolean) => void;
  detectedRtl: boolean;
  /** The original PDF or its "without text" copy (null: not offered, e.g. an office file's layout). */
  copy: { textless: boolean; flat: FlatState; onChange: (textless: boolean) => void } | null;
}) {
  const [ahead, setAhead] = useState(String(view.ahead));
  useEffect(() => setAhead(String(view.ahead)), [view.ahead]);
  const commitAhead = (raw: string) => {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n) && n >= 1) onChange({ ahead: Math.min(MAX_AHEAD, n) });
    else setAhead(String(view.ahead));
  };
  return (
    <div className="w-80 max-w-[calc(100vw-2rem)] space-y-4 p-3 text-sm">
      <div className="font-medium">View settings</div>

      {copy && copy.flat !== 'notext' && (
        <Setting label="File">
          <Choice
            value={copy.textless ? 'flat' : 'original'}
            onChange={(v) => copy.onChange(v === 'flat')}
            options={[
              { value: 'original', label: 'Original' },
              { value: 'flat', label: 'Without text' },
            ]}
          />
          <p className="text-xs text-muted">
            {copy.textless && copy.flat === 'pending'
              ? 'The copy without text is being made — it opens by itself when it’s ready. Big books take a minute or two.'
              : copy.textless && copy.flat === 'failed'
                ? 'The copy without text couldn’t be made for this file, so the original is shown.'
                : 'Without text: every page as a picture. Much lighter for big books full of text, but text can’t be selected or searched. Only one of the two is loaded at a time.'}
          </p>
        </Setting>
      )}

      <Setting label="Pages">
        <Choice
          value={view.layout}
          onChange={(layout) => onChange({ layout })}
          options={[
            { value: 'scroll', label: 'Scrolling', icon: <Rows3 size={14} /> },
            { value: 'book', label: 'Book (2 pages)', icon: <BookOpen size={14} /> },
          ]}
        />
        {view.layout === 'book' && (
          <>
            <Check label="Cover page on its own" help="The first page alone, so left and right pages pair up as in the printed book." checked={view.cover} onChange={(cover) => onChange({ cover })} />
            <div className="text-xs text-muted">Reading direction</div>
            <Choice
              value={view.direction}
              onChange={(direction) => onChange({ direction })}
              options={[
                { value: 'auto', label: `Auto (${detectedRtl ? 'right to left' : 'left to right'})` },
                { value: 'ltr', label: 'Left to right' },
                { value: 'rtl', label: 'Right to left' },
              ]}
            />
          </>
        )}
      </Setting>

      {view.layout === 'book' ? (
        <p className="text-xs text-muted">Two pages at a time, fitted to the screen. Flip with the arrows at the sides, the arrow keys or by swiping; the mouse wheel zooms where the pointer is.</p>
      ) : (
        <Setting label="Fit shows">
          <Choice
            value={view.fit}
            onChange={(fit) => onChange({ fit })}
            options={[
              { value: 'width', label: 'Full width' },
              { value: 'page', label: 'Whole page' },
            ]}
          />
        </Setting>
      )}

      <Setting label="Loading">
        <Check
          label="Load pages ahead"
          help="Draws nearby pages before you reach them, so they're ready when you scroll. Off: only what's on screen is drawn."
          checked={view.preload}
          onChange={(preload) => onChange({ preload })}
        />
        {view.preload && (
          <label className="flex items-center gap-2 ps-6 text-xs text-muted">
            <input
              type="number"
              min={1}
              max={MAX_AHEAD}
              step={1}
              value={ahead}
              onChange={(e) => setAhead(e.target.value)}
              onBlur={(e) => commitAhead(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commitAhead((e.target as HTMLInputElement).value)}
              className="h-7 w-16 rounded-md border border-line bg-bg px-2 text-sm text-fg tabular-nums"
            />
            pages before and after the one you're on
          </label>
        )}
        <Check
          label="Free memory from far pages"
          help="Pages already drawn are cleared as soon as they leave the screen (otherwise the nearest few are kept for scrolling back). Uses the least memory, for slow phones."
          checked={view.unload}
          onChange={(unload) => onChange({ unload })}
        />
      </Setting>

      <Setting label="Display">
        {view.layout !== 'book' && <Check label="Snap to pages" help="Scrolling settles on the top of a page." checked={view.snap} onChange={(snap) => onChange({ snap })} />}
        <Check label="Dark pages" help="Pages drawn with their colours turned dark; handwriting keeps its colours." checked={dark} onChange={onDark} />
        <Choice
          value={view.quality}
          onChange={(quality) => onChange({ quality })}
          options={[
            { value: 'sharp', label: 'Sharp' },
            { value: 'fast', label: 'Faster' },
          ]}
        />
        <p className="text-xs text-muted">Faster draws fewer pixels: a little softer on sharp screens, quicker on slow devices.</p>
      </Setting>
    </div>
  );
}

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>
      {children}
    </div>
  );
}

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: React.ReactNode }[] }) {
  return (
    <div className="flex rounded-lg bg-hover p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs whitespace-nowrap',
            value === o.value ? 'bg-bg font-medium text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Check({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="block">{label}</span>
        {help && <span className="block text-xs text-muted">{help}</span>}
      </span>
    </label>
  );
}

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

/** A tall, quiet button at the side of the book view that flips the pages. */
function EdgeButton({ side, label, disabled, onClick }: { side: 'left' | 'right'; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={clsx(
        'absolute top-1/2 z-10 flex h-24 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition-opacity hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-0 max-sm:hidden',
        side === 'left' ? 'left-1' : 'right-1',
      )}
    >
      {side === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  );
}

function RoundButton({ label, onClick, children }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  index: number;
  /** Kept on hand but not shown (the book view's pages ahead): drawn, not displayed. */
  hidden?: boolean;
  /** Set for blank pages added after the PDF's own pages: the size to draw them at. */
  blank: { w: number; h: number } | null;
  /** The size to draw it at until its own is known (the first page's). */
  estimate: { w: number; h: number } | null;
  zoom: Zoom;
  /** What Fit fits: the width (up to `fitCap`), or the whole page within `availableHeight` too. */
  fit: ViewPrefs['fit'];
  available: number;
  fitCap: number;
  availableHeight: number;
  /** Near the page being read (within the pages drawn ahead): draw it even before it's on screen. */
  wanted: boolean;
  /** Free its drawing once it's neither on screen nor wanted. */
  unload: boolean;
  /** Full screen resolution (off: fewer pixels, faster). */
  sharp: boolean;
  items: InkItem[];
  ink: InkSettings | null;
  actions: InkActions;
  onPen: () => void;
  /** Draw the page dark (colours inverted; the handwriting keeps its own colours). */
  dark: boolean;
}

/** One page: sized up front from its viewport, drawn only once it scrolls near the screen, with its handwriting on top. */
const PdfPage = memo(function PdfPage({ doc, index, hidden, blank, estimate, zoom, fit, available, fitCap, availableHeight, wanted, unload, sharp, items, ink, actions, onPen, dark }: PageProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(blank);
  const [onScreen, setOnScreen] = useState(index <= 2);
  const [everDrawn, setEverDrawn] = useState(false);
  // Drawn while on screen or near the page being read; kept afterwards unless far pages are freed.
  const near = onScreen || wanted || (!unload && everDrawn);
  useEffect(() => {
    if (onScreen || wanted) setEverDrawn(true);
  }, [onScreen, wanted]);

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
  const scale = known
    ? zoom === 'fit'
      ? Math.min(Math.min(available, fitCap) / known.w, fit === 'page' && availableHeight > 100 ? availableHeight / known.h : Infinity)
      : zoom * (96 / 72)
    : 1;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setOnScreen(e.isIntersecting);
      },
      // A little margin, so a page is drawn just before its edge appears.
      { rootMargin: '150px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [index]);

  // Zooming redraws only pages on screen or drawn ahead. Others keep their old drawing (stretched to the
  // new size) until they come into view; redrawing every kept page at each zoom step froze the viewer.
  const active = onScreen || wanted;
  const [drawScale, setDrawScale] = useState(scale);
  useEffect(() => {
    if ((active || !everDrawn) && drawScale !== scale) setDrawScale(scale);
  }, [active, everDrawn, scale, drawScale]);

  useEffect(() => {
    if (blank || !size || !canvas.current || !textLayer.current) return;
    if (!near) {
      // Far from view with "free far pages" on: give back the canvas's memory (it's drawn again on return).
      canvas.current.width = 0;
      canvas.current.height = 0;
      textLayer.current.replaceChildren();
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    let text: { cancel: () => void } | null = null;
    (async () => {
      const pdfjs = await loadPdfjs();
      const p = await doc.getPage(index);
      if (cancelled) return;
      const viewport = p.getViewport({ scale: drawScale });
      const ratio = sharp ? window.devicePixelRatio || 1 : 1;
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
      for (const [k, v] of [['--scale-factor', String(drawScale)], ['--total-scale-factor', String(drawScale)], ['--scale-round-x', '1px'], ['--scale-round-y', '1px']]) layer.style.setProperty(k, v);
      const tl = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: layer, viewport });
      text = tl;
      await tl.render().catch(() => {});
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
      text?.cancel();
    };
  }, [near, size, drawScale, doc, index, blank, sharp]);

  const w = known ? known.w * scale : Math.min(available, 800);
  const h = known ? known.h * scale : w * 1.3;
  return (
    <div id={`ink-page-${index}`} ref={box} className={clsx('relative shrink-0 shadow-pop', dark ? 'pdf-dark bg-[#1e1e1e]' : 'bg-white')} style={{ width: w, height: h, display: hidden ? 'none' : undefined }}>
      {!blank && <canvas ref={canvas} className="absolute inset-0" style={{ width: w, height: h, filter: dark ? 'invert(0.88) hue-rotate(180deg) saturate(1.7) contrast(1.05)' : undefined }} />}
      {!blank && <div ref={textLayer} className="textLayer" style={drawScale !== scale ? { transform: `scale(${scale / drawScale})`, transformOrigin: '0 0' } : undefined} />}
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
