import clsx from 'clsx';
import {
  ArrowUpRight,
  Brush,
  Circle,
  Crop,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  Grid2x2,
  Highlighter,
  Minus,
  MousePointer2,
  Pipette,
  Redo2,
  RotateCcw,
  RotateCw,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner, toast, toastError } from '../components/ui';
import { uploadFile } from '../lib/api';
import { queryClient } from '../lib/queries';
import { refreshFiles } from '../notes/api';
import { downloadBlob, saveContent } from '../office/shared';

// A picture editor laid out like the desktop ones: tools down the side (move, crop, brush,
// highlighter, eraser, text, shapes, blur, colour picker), the chosen tool's options along the top,
// and adjustments and filters on the right. Everything happens in the browser; saving replaces the
// file or adds a copy. Drawings, text and shapes stay editable (move, recolour, delete) until saved.

interface EditFile {
  id: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  url: string;
}

type Pt = [number, number];
/** Things drawn on the picture, in pixels of the turned picture. */
type Obj =
  | { id: string; kind: 'stroke'; points: Pt[]; color: string; size: number; opacity: number }
  | { id: string; kind: 'text'; x: number; y: number; text: string; color: string; size: number; bold: boolean; box: boolean }
  | { id: string; kind: 'rect' | 'ellipse' | 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; size: number; fill: boolean }
  | { id: string; kind: 'pixelate'; x1: number; y1: number; x2: number; y2: number };

interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  blur: number;
  grayscale: number;
}

/** A crop, as fractions of the turned picture. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Edits {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  crop: Box;
  adjust: Adjust;
  /** The size to save at, as a share of the cropped picture. */
  scale: number;
  objects: Obj[];
}

type Tool = 'move' | 'crop' | 'brush' | 'highlighter' | 'eraser' | 'text' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'pixelate' | 'picker';

const NO_ADJUST: Adjust = { brightness: 100, contrast: 100, saturation: 100, warmth: 0, blur: 0, grayscale: 0 };
const START: Edits = { rotate: 0, flipH: false, flipV: false, crop: { x: 0, y: 0, w: 1, h: 1 }, adjust: NO_ADJUST, scale: 1, objects: [] };
const FILTERS: { label: string; adjust: Adjust }[] = [
  { label: 'None', adjust: NO_ADJUST },
  { label: 'Black & white', adjust: { ...NO_ADJUST, grayscale: 100, contrast: 110 } },
  { label: 'Sepia', adjust: { ...NO_ADJUST, warmth: 80, saturation: 90 } },
  { label: 'Vivid', adjust: { ...NO_ADJUST, saturation: 150, contrast: 115 } },
  { label: 'Warm', adjust: { ...NO_ADJUST, warmth: 30, saturation: 110 } },
  { label: 'Cool', adjust: { ...NO_ADJUST, saturation: 90, brightness: 105, contrast: 95 } },
  { label: 'Fade', adjust: { ...NO_ADJUST, contrast: 80, brightness: 110, saturation: 80 } },
];
const RATIOS: { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: 'Square', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
];
const SWATCHES = ['#ffffff', '#000000', '#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
const TOOLS: { tool: Tool; label: string; key: string; icon: ReactNode }[] = [
  { tool: 'move', label: 'Move and select', key: 'v', icon: <MousePointer2 size={18} /> },
  { tool: 'crop', label: 'Crop', key: 'c', icon: <Crop size={18} /> },
  { tool: 'brush', label: 'Brush', key: 'b', icon: <Brush size={18} /> },
  { tool: 'highlighter', label: 'Highlighter', key: 'h', icon: <Highlighter size={18} /> },
  { tool: 'eraser', label: 'Eraser (removes drawings, text and shapes)', key: 'e', icon: <Eraser size={18} /> },
  { tool: 'text', label: 'Text', key: 't', icon: <Type size={18} /> },
  { tool: 'rect', label: 'Rectangle', key: 'r', icon: <Square size={18} /> },
  { tool: 'ellipse', label: 'Ellipse', key: 'o', icon: <Circle size={18} /> },
  { tool: 'line', label: 'Line', key: 'l', icon: <Minus size={18} /> },
  { tool: 'arrow', label: 'Arrow', key: 'a', icon: <ArrowUpRight size={18} /> },
  { tool: 'pixelate', label: 'Blur out (hide faces, numbers…)', key: 'x', icon: <Grid2x2 size={18} /> },
  { tool: 'picker', label: 'Pick a colour from the picture', key: 'i', icon: <Pipette size={18} /> },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const newId = () => Math.random().toString(36).slice(2, 10);
const fontOf = (o: { size: number; bold: boolean }) => `${o.bold ? 700 : 500} ${o.size}px Inter, system-ui, sans-serif`;
const filterOf = (a: Adjust) =>
  `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%) sepia(${a.warmth}%) grayscale(${a.grayscale}%)${a.blur ? ` blur(${a.blur}px)` : ''}`;

/** The picture turned, flipped and adjusted, at full size. */
function turned(img: HTMLImageElement, e: Pick<Edits, 'rotate' | 'flipH' | 'flipV' | 'adjust'>): HTMLCanvasElement {
  const side = e.rotate === 90 || e.rotate === 270;
  const c = document.createElement('canvas');
  c.width = side ? img.naturalHeight : img.naturalWidth;
  c.height = side ? img.naturalWidth : img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.filter = filterOf(e.adjust);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((e.rotate * Math.PI) / 180);
  ctx.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return c;
}

function textLines(o: Extract<Obj, { kind: 'text' }>) {
  return o.text.split('\n');
}

/** How big a text is, for selecting it and drawing its box. */
function textBounds(ctx: CanvasRenderingContext2D, o: Extract<Obj, { kind: 'text' }>) {
  ctx.font = fontOf(o);
  const lines = textLines(o);
  const w = Math.max(...lines.map((l) => ctx.measureText(l || ' ').width));
  const h = lines.length * o.size * 1.25;
  const pad = o.box ? o.size * 0.35 : 0;
  return { x: o.x - pad, y: o.y - pad, w: w + pad * 2, h: h + pad * 2 };
}

function bounds(ctx: CanvasRenderingContext2D, o: Obj) {
  if (o.kind === 'stroke') {
    const xs = o.points.map((p) => p[0]);
    const ys = o.points.map((p) => p[1]);
    const r = o.size / 2;
    return { x: Math.min(...xs) - r, y: Math.min(...ys) - r, w: Math.max(...xs) - Math.min(...xs) + o.size, h: Math.max(...ys) - Math.min(...ys) + o.size };
  }
  if (o.kind === 'text') return textBounds(ctx, o);
  const pad = 'size' in o ? o.size / 2 : 0;
  return { x: Math.min(o.x1, o.x2) - pad, y: Math.min(o.y1, o.y2) - pad, w: Math.abs(o.x2 - o.x1) + pad * 2, h: Math.abs(o.y2 - o.y1) + pad * 2 };
}

/** Whether a point (picture pixels) touches a thing; `slack` is extra room for small marks. */
function hits(ctx: CanvasRenderingContext2D, o: Obj, p: Pt, slack: number) {
  if (o.kind === 'stroke') return o.points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= o.size / 2 + slack);
  if (o.kind === 'line' || o.kind === 'arrow') {
    const { x1, y1, x2, y2 } = o;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const t = clamp(((p[0] - x1) * (x2 - x1) + (p[1] - y1) * (y2 - y1)) / (len * len), 0, 1);
    return Math.hypot(x1 + t * (x2 - x1) - p[0], y1 + t * (y2 - y1) - p[1]) <= o.size / 2 + slack;
  }
  const b = bounds(ctx, o);
  return p[0] >= b.x - slack && p[0] <= b.x + b.w + slack && p[1] >= b.y - slack && p[1] <= b.y + b.h + slack;
}

/** Draws the marks on a canvas showing the picture at `s` screen pixels per picture pixel. */
function drawObjects(ctx: CanvasRenderingContext2D, objects: Obj[], s: number) {
  for (const o of objects) {
    ctx.save();
    if (o.kind === 'stroke') {
      ctx.globalAlpha = o.opacity;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.size * s;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      o.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
      if (o.points.length === 1) ctx.lineTo(o.points[0][0] * s + 0.01, o.points[0][1] * s);
      ctx.stroke();
    } else if (o.kind === 'text') {
      const b = textBounds(ctx, o);
      if (o.box) {
        ctx.fillStyle = isLight(o.color) ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
        roundRect(ctx, b.x * s, b.y * s, b.w * s, b.h * s, o.size * 0.25 * s);
        ctx.fill();
      }
      ctx.font = fontOf({ size: o.size * s, bold: o.bold });
      ctx.fillStyle = o.color;
      ctx.textBaseline = 'top';
      textLines(o).forEach((line, i) => ctx.fillText(line, o.x * s, (o.y + i * o.size * 1.25 + o.size * 0.1) * s));
    } else if (o.kind === 'pixelate') {
      const x = Math.min(o.x1, o.x2) * s;
      const y = Math.min(o.y1, o.y2) * s;
      const w = Math.abs(o.x2 - o.x1) * s;
      const h = Math.abs(o.y2 - o.y1) * s;
      if (w >= 2 && h >= 2) {
        // Shrink the area to a few blocks and stretch it back without smoothing.
        const block = Math.max(4, Math.min(w, h) / 12);
        const tiny = document.createElement('canvas');
        tiny.width = Math.max(1, Math.round(w / block));
        tiny.height = Math.max(1, Math.round(h / block));
        tiny.getContext('2d')!.drawImage(ctx.canvas, x, y, w, h, 0, 0, tiny.width, tiny.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
      }
    } else {
      ctx.strokeStyle = o.color;
      ctx.fillStyle = o.color;
      ctx.lineWidth = o.size * s;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const [x1, y1, x2, y2] = [o.x1 * s, o.y1 * s, o.x2 * s, o.y2 * s];
      ctx.beginPath();
      if (o.kind === 'rect') ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      else if (o.kind === 'ellipse') ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      if (o.fill && (o.kind === 'rect' || o.kind === 'ellipse')) ctx.fill();
      else ctx.stroke();
      if (o.kind === 'arrow') {
        const a = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10 * s, o.size * s * 3.5);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
        ctx.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function isLight(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return true;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

/** Moves a mark along with the picture when it's turned or flipped (W × H: the picture before). */
function transformObj(o: Obj, f: (p: Pt) => Pt): Obj {
  if (o.kind === 'stroke') return { ...o, points: o.points.map(f) };
  if (o.kind === 'text') {
    const [x, y] = f([o.x, o.y]);
    return { ...o, x, y };
  }
  const [x1, y1] = f([o.x1, o.y1]);
  const [x2, y2] = f([o.x2, o.y2]);
  return { ...o, x1, y1, x2, y2 };
}

function moveObj(o: Obj, dx: number, dy: number): Obj {
  return transformObj(o, ([x, y]) => [x + dx, y + dy]);
}

/** Saves as the same kind of picture when the browser can write it, otherwise as PNG. */
function outputType(file: EditFile) {
  if (file.mimeType === 'image/jpeg' || /\.jpe?g$/i.test(file.name)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (file.mimeType === 'image/webp' || /\.webp$/i.test(file.name)) return { mime: 'image/webp', ext: 'webp' };
  return { mime: 'image/png', ext: 'png' };
}

export default function ImageEditor({ file, onDone }: { file: EditFile; onDone: (saved: boolean) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [edits, setEdits] = useState<Edits>(START);
  const [past, setPast] = useState<Edits[]>([]);
  const [future, setFuture] = useState<Edits[]>([]);
  const [tool, setTool] = useState<Tool>('move');
  const [color, setColor] = useState('#ef4444');
  const [size, setSize] = useState(0);
  const [fontSize, setFontSize] = useState(0);
  const [bold, setBold] = useState(true);
  const [textBox, setTextBox] = useState(false);
  const [fill, setFill] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typing, setTyping] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState<Obj | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const measure = useMemo(() => document.createElement('canvas').getContext('2d')!, []);

  useEffect(() => {
    const i = new Image();
    i.onload = () => {
      setImg(i);
      // Starting sizes that suit the picture: a brush and a text you can see.
      const long = Math.max(i.naturalWidth, i.naturalHeight);
      setSize(Math.max(3, Math.round(long / 160)));
      setFontSize(Math.max(14, Math.round(long / 22)));
    };
    i.onerror = () => toastError(new Error("This picture couldn't be opened for editing"));
    i.src = `${file.url}${file.url.includes('?') ? '&' : '?'}edit=${Date.now()}`;
  }, [file.url]);

  /** Changes something, remembering how it was for Undo. */
  const commit = useCallback((next: Edits | ((e: Edits) => Edits)) => {
    setEdits((e) => {
      const n = typeof next === 'function' ? next(e) : next;
      if (n === e) return e;
      setPast((p) => [...p.slice(-50), e]);
      setFuture([]);
      return n;
    });
  }, []);
  const undo = () => {
    const last = past.at(-1);
    if (!last) return;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [edits, ...f]);
    setEdits(last);
    setSelected(null);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, edits]);
    setEdits(next);
  };

  const base = useMemo(() => (img ? turned(img, edits) : null), [img, edits.rotate, edits.flipH, edits.flipV, edits.adjust]); // eslint-disable-line react-hooks/exhaustive-deps
  const W = base?.width ?? 1;
  const H = base?.height ?? 1;
  const s = box.w / W || 1;

  useEffect(() => {
    const el = stage.current;
    if (!el || !base) return;
    const fit = () => {
      const k = Math.min((el.clientWidth - 32) / base.width, (el.clientHeight - 32) / base.height, 1);
      setBox({ w: Math.max(1, Math.round(base.width * k)), h: Math.max(1, Math.round(base.height * k)) });
    };
    fit();
    // Also a moment later, in case the layout wasn't there yet when the picture loaded.
    const later = setTimeout(fit, 100);
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      clearTimeout(later);
      ro.disconnect();
    };
  }, [base]);

  // The preview: the picture, then every mark (and the one being drawn).
  useEffect(() => {
    const c = preview.current;
    if (!c || !base || !box.w) return;
    const ratioPx = window.devicePixelRatio || 1;
    c.width = Math.round(box.w * ratioPx);
    c.height = Math.round(box.h * ratioPx);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(ratioPx, 0, 0, ratioPx, 0, 0);
    ctx.drawImage(base, 0, 0, box.w, box.h);
    const shown = typing ? edits.objects.filter((o) => o.id !== typing.id) : edits.objects;
    drawObjects(ctx, draft ? [...shown, draft] : shown, s);
  }, [base, box, edits.objects, draft, s, typing]);

  const selectedObj = edits.objects.find((o) => o.id === selected) ?? null;
  const updateSelected = (patch: Partial<Obj>) => selectedObj && commit((e) => ({ ...e, objects: e.objects.map((o) => (o.id === selected ? ({ ...o, ...patch } as Obj) : o)) }));
  const removeSelected = useCallback(() => {
    if (!selected) return;
    commit((e) => ({ ...e, objects: e.objects.filter((o) => o.id !== selected) }));
    setSelected(null);
  }, [selected, commit]);

  // Keys: tool letters, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Delete for what's selected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z' && !e.shiftKey) undo();
        else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
        else return;
        e.preventDefault();
        return;
      }
      if ((k === 'delete' || k === 'backspace') && selected) {
        e.preventDefault();
        removeSelected();
        return;
      }
      if (k === 'escape') setSelected(null);
      const t = TOOLS.find((x) => x.key === k);
      if (t) setTool(t.tool);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toPicture = (e: React.PointerEvent | React.MouseEvent): Pt => {
    const r = preview.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / s, 0, W), clamp((e.clientY - r.top) / s, 0, H)];
  };

  const finishTyping = (t = typing) => {
    if (!t) return;
    setTyping(null);
    const text = t.text.replace(/\s+$/, '');
    commit((e) => ({
      ...e,
      objects: text ? e.objects.map((o) => (o.id === t.id && o.kind === 'text' ? { ...o, text } : o)) : e.objects.filter((o) => o.id !== t.id),
    }));
  };

  // Drawing and moving on the picture.
  const action = useRef<{ kind: 'draw' | 'move' | 'erase'; start: Pt; moved?: boolean; origin?: Edits } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if (!base || tool === 'crop') return;
    if (typing) return finishTyping();
    const p = toPicture(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const slack = 6 / s;
    if (tool === 'picker') {
      const c = preview.current!;
      const ratioPx = c.width / box.w;
      const d = c.getContext('2d')!.getImageData(Math.round(p[0] * s * ratioPx), Math.round(p[1] * s * ratioPx), 1, 1).data;
      const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      setColor(hex);
      if (selectedObj && 'color' in selectedObj) updateSelected({ color: hex } as Partial<Obj>);
      toast(`Colour ${hex} picked`);
      return;
    }
    if (tool === 'move') {
      const hit = [...edits.objects].reverse().find((o) => hits(measure, o, p, slack));
      setSelected(hit?.id ?? null);
      if (hit) action.current = { kind: 'move', start: p, origin: edits };
      return;
    }
    if (tool === 'eraser') {
      action.current = { kind: 'erase', start: p, origin: edits };
      eraseAt(p);
      return;
    }
    if (tool === 'text') {
      const hit = [...edits.objects].reverse().find((o) => o.kind === 'text' && hits(measure, o, p, slack));
      if (hit && hit.kind === 'text') {
        setSelected(hit.id);
        setTyping({ id: hit.id, text: hit.text });
        return;
      }
      const o: Obj = { id: newId(), kind: 'text', x: p[0], y: p[1] - fontSize / 2, text: '', color, size: fontSize, bold, box: textBox };
      setEdits((ed) => ({ ...ed, objects: [...ed.objects, o] }));
      setSelected(o.id);
      setTyping({ id: o.id, text: '' });
      return;
    }
    const id = newId();
    if (tool === 'brush' || tool === 'highlighter')
      setDraft({ id, kind: 'stroke', points: [p], color, size: tool === 'highlighter' ? size * 3 : size, opacity: tool === 'highlighter' ? 0.35 : 1 });
    else if (tool === 'pixelate') setDraft({ id, kind: 'pixelate', x1: p[0], y1: p[1], x2: p[0], y2: p[1] });
    else setDraft({ id, kind: tool, x1: p[0], y1: p[1], x2: p[0], y2: p[1], color, size, fill });
    action.current = { kind: 'draw', start: p };
  };

  const eraseAt = (p: Pt) =>
    setEdits((ed) => {
      const left = ed.objects.filter((o) => !hits(measure, o, p, 8 / s));
      return left.length === ed.objects.length ? ed : { ...ed, objects: left };
    });

  const onMove = (e: React.PointerEvent) => {
    const a = action.current;
    if (!a) return;
    const p = toPicture(e);
    if (a.kind === 'erase') return eraseAt(p);
    if (a.kind === 'move' && a.origin && selected) {
      const dx = p[0] - a.start[0];
      const dy = p[1] - a.start[1];
      a.moved = true;
      setEdits({ ...a.origin, objects: a.origin.objects.map((o) => (o.id === selected ? moveObj(o, dx, dy) : o)) });
      return;
    }
    setDraft((d) => {
      if (!d) return d;
      if (d.kind === 'stroke') return { ...d, points: [...d.points, p] };
      if (d.kind === 'text') return d;
      return { ...d, x2: p[0], y2: p[1] };
    });
  };

  const onUp = () => {
    const a = action.current;
    action.current = null;
    if (!a) return;
    if ((a.kind === 'move' && a.moved) || a.kind === 'erase') {
      // Remember the state from before the drag for Undo.
      if (a.origin && a.origin !== edits) {
        setPast((p) => [...p.slice(-50), a.origin!]);
        setFuture([]);
      }
      return;
    }
    if (a.kind === 'draw' && draft) {
      const d = draft;
      setDraft(null);
      const tiny = 'x1' in d && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 3 / s;
      if (!tiny) commit((ed) => ({ ...ed, objects: [...ed.objects, d] }));
    }
  };

  // ----- crop box: inside moves it, corners resize it (keeping the chosen shape) -----
  const cropDrag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number; start: Box; origin: Edits } | null>(null);
  const onCropDown = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    cropDrag.current = { mode, x: e.clientX, y: e.clientY, start: edits.crop, origin: edits };
  };
  const onCropMove = (e: React.PointerEvent) => {
    const d = cropDrag.current;
    if (!d || !box.w) return;
    const dx = (e.clientX - d.x) / box.w;
    const dy = (e.clientY - d.y) / box.h;
    const c = d.start;
    let next: Box;
    if (d.mode === 'move') next = { ...c, x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h) };
    else {
      const left = d.mode === 'nw' || d.mode === 'sw';
      const top = d.mode === 'nw' || d.mode === 'ne';
      let x1 = left ? clamp(c.x + dx, 0, c.x + c.w - 0.03) : c.x;
      let x2 = left ? c.x + c.w : clamp(c.x + c.w + dx, c.x + 0.03, 1);
      let y1 = top ? clamp(c.y + dy, 0, c.y + c.h - 0.03) : c.y;
      let y2 = top ? c.y + c.h : clamp(c.y + c.h + dy, c.y + 0.03, 1);
      if (ratio) {
        const r = ratio * (H / W);
        const h = Math.min((x2 - x1) / r, top ? y2 : 1 - y1);
        const w = h * r;
        if (left) x1 = x2 - w;
        else x2 = x1 + w;
        if (top) y1 = y2 - h;
        else y2 = y1 + h;
      }
      next = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    setEdits((ed) => ({ ...ed, crop: next }));
  };
  const onCropUp = () => {
    const d = cropDrag.current;
    cropDrag.current = null;
    if (d && d.origin.crop !== edits.crop) {
      setPast((p) => [...p.slice(-50), d.origin]);
      setFuture([]);
    }
  };
  const pickRatio = (value: number | null) => {
    setRatio(value);
    if (!value) return;
    const r = value * (H / W);
    const w = r > 1 ? 1 : r;
    const h = r > 1 ? 1 / r : 1;
    commit((e) => ({ ...e, crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } }));
  };

  /** Turns or flips the picture, taking the marks along. */
  const reorient = (how: 'left' | 'right' | 'flipH' | 'flipV') =>
    commit((e) => {
      const f: (p: Pt) => Pt =
        how === 'right' ? ([x, y]) => [H - y, x] : how === 'left' ? ([x, y]) => [y, W - x] : how === 'flipH' ? ([x, y]) => [W - x, y] : ([x, y]) => [x, H - y];
      const objects = e.objects.map((o) => transformObj(o, f));
      if (how === 'flipH') return { ...e, flipH: e.rotate % 180 === 0 ? !e.flipH : e.flipH, flipV: e.rotate % 180 === 0 ? e.flipV : !e.flipV, objects, crop: START.crop };
      if (how === 'flipV') return { ...e, flipV: e.rotate % 180 === 0 ? !e.flipV : e.flipV, flipH: e.rotate % 180 === 0 ? e.flipH : !e.flipH, objects, crop: START.crop };
      const by = how === 'right' ? 90 : 270;
      return { ...e, rotate: ((e.rotate + by) % 360) as Edits['rotate'], objects, crop: START.crop };
    });

  const setAdjust = (patch: Partial<Adjust>, remember: boolean) => {
    if (remember) commit((e) => ({ ...e, adjust: { ...e.adjust, ...patch } }));
    else setEdits((e) => ({ ...e, adjust: { ...e.adjust, ...patch } }));
  };

  const outSize = base ? { w: Math.round(edits.crop.w * W * edits.scale), h: Math.round(edits.crop.h * H * edits.scale) } : null;
  const changed = JSON.stringify(edits) !== JSON.stringify(START);

  const render = async () => {
    const { mime, ext } = outputType(file);
    const full = turned(img!, edits);
    // Drawings go on top as they look in the preview: no turning offset or colour filter on them.
    const fctx = full.getContext('2d')!;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.filter = 'none';
    drawObjects(fctx, edits.objects, 1);
    const sx = Math.round(edits.crop.x * W);
    const sy = Math.round(edits.crop.y * H);
    const sw = Math.max(1, Math.round(edits.crop.w * W));
    const sh = Math.max(1, Math.round(edits.crop.h * H));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * edits.scale));
    out.height = Math.max(1, Math.round(sh * edits.scale));
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, mime, 0.92));
    if (!blob) throw new Error("The picture couldn't be saved");
    return { blob, name: `${file.name.replace(/\.[^.]+$/, '')}.${ext}` };
  };

  const save = async (how: 'replace' | 'copy' | 'download') => {
    if (!img) return;
    finishTyping();
    setBusy(how);
    try {
      const { blob, name } = await render();
      if (how === 'download') downloadBlob(blob, name);
      else if (how === 'copy') {
        const copyName = name.replace(/(\.[^.]+)$/, ' (edited)$1');
        await uploadFile(file.workspaceId, new File([blob], copyName, { type: blob.type }));
        toast(`Saved a copy, “${copyName}”, in Files`);
      } else {
        await saveContent(file.id, blob, name !== file.name ? name : undefined);
        toast('Saved');
      }
      if (how !== 'download') {
        queryClient.invalidateQueries({ queryKey: ['file-info', file.id] });
        void refreshFiles(file.workspaceId);
        onDone(how === 'replace');
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  if (!img || !base) return <Spinner />;
  const c = edits.crop;
  const handle = 'absolute size-4 rounded-full border-2 border-white bg-accent shadow';
  const typingObj = typing ? edits.objects.find((o) => o.id === typing.id) : null;
  const sel = selectedObj ? bounds(measure, selectedObj) : null;
  // What the options bar shows: the selected mark's settings, or the tool's.
  const showColor = ['brush', 'highlighter', 'text', 'rect', 'ellipse', 'line', 'arrow', 'picker'].includes(tool) || (tool === 'move' && selectedObj && 'color' in selectedObj);
  const currentColor = tool === 'move' && selectedObj && 'color' in selectedObj ? selectedObj.color : color;
  const pickColor = (hex: string) => {
    setColor(hex);
    if (selectedObj && 'color' in selectedObj) updateSelected({ color: hex } as Partial<Obj>);
  };

  return (
    <div className="flex h-full flex-col bg-[#1b1b1f] text-white">
      {/* Top: history and saving */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <DarkIcon label="Undo (Ctrl+Z)" onClick={undo} disabled={!past.length}>
          <Undo2 size={16} />
        </DarkIcon>
        <DarkIcon label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!future.length}>
          <Redo2 size={16} />
        </DarkIcon>
        <button onClick={() => commit(START)} disabled={!changed} className="h-8 rounded-md px-2 text-sm text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40">
          Reset all
        </button>
        <span className="flex-1" />
        <button onClick={() => onDone(false)} className="h-8 rounded-md px-2.5 text-sm text-white/70 hover:bg-white/10 hover:text-white">
          Cancel
        </button>
        <Button size="sm" onClick={() => void save('download')} loading={busy === 'download'} disabled={!!busy}>
          Download
        </Button>
        <Button size="sm" onClick={() => void save('copy')} loading={busy === 'copy'} disabled={!!busy || !changed}>
          Save as copy
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save('replace')} loading={busy === 'replace'} disabled={!!busy || !changed} title="Replaces the picture everywhere it's used">
          Save
        </Button>
      </div>

      {/* Options for the chosen tool (or the selected mark) */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 px-3 py-1.5 text-xs text-white/80">
        <span className="font-medium text-white">{TOOLS.find((t) => t.tool === tool)?.label}</span>
        {tool === 'crop' && (
          <>
            {RATIOS.map((r) => (
              <button key={r.label} onClick={() => pickRatio(r.value)} className={clsx('h-7 rounded-md px-2', ratio === r.value ? 'bg-white/20 text-white' : 'hover:bg-white/10')}>
                {r.label}
              </button>
            ))}
            <button onClick={() => commit((e) => ({ ...e, crop: START.crop }))} className="h-7 rounded-md px-2 hover:bg-white/10">
              Clear crop
            </button>
          </>
        )}
        {showColor && (
          <span className="flex items-center gap-1">
            {SWATCHES.map((sw) => (
              <button
                key={sw}
                onClick={() => pickColor(sw)}
                className={clsx('size-5 rounded-full border', currentColor === sw ? 'border-white ring-2 ring-accent' : 'border-white/30')}
                style={{ background: sw }}
                aria-label={sw}
              />
            ))}
            <label className="relative size-5 cursor-pointer rounded-full border border-white/30" style={{ background: 'conic-gradient(#f44, #fd4, #4d6, #4cf, #66f, #d4f, #f44)' }} title="Any colour">
              <input type="color" value={currentColor} onChange={(e) => pickColor(e.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" />
            </label>
          </span>
        )}
        {(['brush', 'highlighter', 'rect', 'ellipse', 'line', 'arrow'].includes(tool) || (tool === 'move' && selectedObj && 'size' in selectedObj && selectedObj.kind !== 'text')) && (
          <Range
            label="Size"
            min={1}
            max={Math.max(40, Math.round(Math.max(W, H) / 30))}
            value={tool === 'move' && selectedObj && 'size' in selectedObj ? selectedObj.size : size}
            onChange={(v, end) => (tool === 'move' && selectedObj ? end && updateSelected({ size: v } as Partial<Obj>) : setSize(v))}
          />
        )}
        {(tool === 'text' || (tool === 'move' && selectedObj?.kind === 'text')) && (
          <>
            <Range
              label="Text size"
              min={8}
              max={Math.max(120, Math.round(Math.max(W, H) / 6))}
              value={selectedObj?.kind === 'text' ? selectedObj.size : fontSize}
              onChange={(v, end) => {
                setFontSize(v);
                if (selectedObj?.kind === 'text' && end) updateSelected({ size: v } as Partial<Obj>);
              }}
            />
            <Toggle
              on={selectedObj?.kind === 'text' ? selectedObj.bold : bold}
              onClick={() => {
                const v = !(selectedObj?.kind === 'text' ? selectedObj.bold : bold);
                setBold(v);
                if (selectedObj?.kind === 'text') updateSelected({ bold: v } as Partial<Obj>);
              }}
            >
              Bold
            </Toggle>
            <Toggle
              on={selectedObj?.kind === 'text' ? selectedObj.box : textBox}
              onClick={() => {
                const v = !(selectedObj?.kind === 'text' ? selectedObj.box : textBox);
                setTextBox(v);
                if (selectedObj?.kind === 'text') updateSelected({ box: v } as Partial<Obj>);
              }}
            >
              Background
            </Toggle>
          </>
        )}
        {(tool === 'rect' || tool === 'ellipse' || (tool === 'move' && (selectedObj?.kind === 'rect' || selectedObj?.kind === 'ellipse'))) && (
          <Toggle
            on={selectedObj && 'fill' in selectedObj ? selectedObj.fill : fill}
            onClick={() => {
              const v = !(selectedObj && 'fill' in selectedObj ? selectedObj.fill : fill);
              setFill(v);
              if (selectedObj && 'fill' in selectedObj) updateSelected({ fill: v } as Partial<Obj>);
            }}
          >
            Filled
          </Toggle>
        )}
        {tool === 'move' && !selectedObj && <span className="text-white/50">Click a drawing, text or shape to move, change or delete it.</span>}
        {tool === 'text' && <span className="text-white/50">Click the picture to type; click a text to change it.</span>}
        {tool === 'pixelate' && <span className="text-white/50">Drag over what should be hidden.</span>}
        {tool === 'eraser' && <span className="text-white/50">Drag over drawings, text or shapes to remove them.</span>}
        {selectedObj && (
          <button onClick={removeSelected} className="ms-auto flex h-7 items-center gap-1 rounded-md px-2 text-red-300 hover:bg-white/10" title="Delete (Del)">
            <Trash2 size={13} /> Delete
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        {/* Tools */}
        <div className="flex shrink-0 gap-0.5 border-white/10 p-1 max-md:order-last max-md:overflow-x-auto max-md:border-t md:flex-col md:border-e">
          {TOOLS.map((t) => (
            <DarkIcon key={t.tool} label={`${t.label} (${t.key.toUpperCase()})`} active={tool === t.tool} onClick={() => setTool(t.tool)} big>
              {t.icon}
            </DarkIcon>
          ))}
          <span className="m-1 shrink-0 bg-white/10 max-md:w-px md:h-px" />
          <DarkIcon label="Turn left" onClick={() => reorient('left')} big>
            <RotateCcw size={18} />
          </DarkIcon>
          <DarkIcon label="Turn right" onClick={() => reorient('right')} big>
            <RotateCw size={18} />
          </DarkIcon>
          <DarkIcon label="Flip left to right" onClick={() => reorient('flipH')} big>
            <FlipHorizontal2 size={18} />
          </DarkIcon>
          <DarkIcon label="Flip upside down" onClick={() => reorient('flipV')} big>
            <FlipVertical2 size={18} />
          </DarkIcon>
        </div>

        {/* The picture */}
        <div
          ref={stage}
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#111114]"
          onPointerMove={onCropMove}
          onPointerUp={onCropUp}
          onPointerCancel={onCropUp}
        >
          <div className="relative touch-none select-none shadow-2xl" style={{ width: box.w, height: box.h }}>
            <canvas
              ref={preview}
              className={clsx('block', tool === 'move' ? 'cursor-default' : tool === 'text' ? 'cursor-text' : tool === 'crop' ? '' : 'cursor-crosshair')}
              style={{ width: box.w, height: box.h }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
            {sel && tool === 'move' && !typing && (
              <div
                className="pointer-events-none absolute border border-dashed border-sky-400"
                style={{ left: sel.x * s - 3, top: sel.y * s - 3, width: sel.w * s + 6, height: sel.h * s + 6 }}
              />
            )}
            {typingObj?.kind === 'text' && typing && (
              <textarea
                autoFocus
                value={typing.text}
                onChange={(e) => setTyping({ ...typing, text: e.target.value })}
                onBlur={() => finishTyping()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
                    e.preventDefault();
                    finishTyping();
                  }
                }}
                placeholder="Type…"
                rows={Math.max(1, typing.text.split('\n').length)}
                className="absolute resize-none overflow-hidden border border-dashed border-sky-400 bg-transparent p-0 outline-none"
                style={{
                  left: typingObj.x * s,
                  top: typingObj.y * s,
                  minWidth: 80,
                  width: Math.max(80, (Math.max(...typing.text.split('\n').map((l) => l.length), 4) + 1) * typingObj.size * s * 0.6),
                  font: fontOf({ size: typingObj.size * s, bold: typingObj.bold }),
                  lineHeight: 1.25,
                  color: typingObj.color,
                }}
              />
            )}
            {tool === 'crop' && (
              <div
                className="absolute cursor-move border-2 border-white"
                style={{ left: c.x * box.w, top: c.y * box.h, width: c.w * box.w, height: c.h * box.h }}
                onPointerDown={onCropDown('move')}
              >
                <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                  {Array.from({ length: 9 }, (_, i) => (
                    <div key={i} className="border border-white/40" />
                  ))}
                </div>
                <span className={clsx(handle, '-start-2 -top-2 cursor-nwse-resize')} onPointerDown={onCropDown('nw')} />
                <span className={clsx(handle, '-end-2 -top-2 cursor-nesw-resize')} onPointerDown={onCropDown('ne')} />
                <span className={clsx(handle, '-bottom-2 -start-2 cursor-nesw-resize')} onPointerDown={onCropDown('sw')} />
                <span className={clsx(handle, '-end-2 -bottom-2 cursor-nwse-resize')} onPointerDown={onCropDown('se')} />
              </div>
            )}
          </div>
        </div>

        {/* Adjustments, filters and size */}
        <div className="w-64 shrink-0 space-y-4 overflow-y-auto border-white/10 p-3 text-sm max-md:max-h-48 max-md:w-full max-md:border-t md:border-s">
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-white/60 uppercase">Filters</h3>
            <div className="grid grid-cols-2 gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.label}
                  onClick={() => commit((e) => ({ ...e, adjust: f.adjust }))}
                  className={clsx('h-7 rounded-md px-2 text-xs', JSON.stringify(edits.adjust) === JSON.stringify(f.adjust) ? 'bg-white/20 text-white' : 'bg-white/5 text-white/80 hover:bg-white/10')}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-white/60 uppercase">Adjust</h3>
            <PanelRange label="Brightness" min={30} max={200} value={edits.adjust.brightness} onChange={(v, end) => setAdjust({ brightness: v }, end)} />
            <PanelRange label="Contrast" min={30} max={200} value={edits.adjust.contrast} onChange={(v, end) => setAdjust({ contrast: v }, end)} />
            <PanelRange label="Saturation" min={0} max={250} value={edits.adjust.saturation} onChange={(v, end) => setAdjust({ saturation: v }, end)} />
            <PanelRange label="Warmth" min={0} max={100} value={edits.adjust.warmth} onChange={(v, end) => setAdjust({ warmth: v }, end)} />
            <PanelRange label="Black & white" min={0} max={100} value={edits.adjust.grayscale} onChange={(v, end) => setAdjust({ grayscale: v }, end)} />
            <PanelRange label="Blur" min={0} max={20} value={edits.adjust.blur} onChange={(v, end) => setAdjust({ blur: v }, end)} unit="px" />
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-white/60 uppercase">Size</h3>
            <PanelRange
              label="Scale"
              min={10}
              max={100}
              value={Math.round(edits.scale * 100)}
              onChange={(v, end) => (end ? commit((e) => ({ ...e, scale: v / 100 })) : setEdits((e) => ({ ...e, scale: v / 100 })))}
            />
            {outSize && (
              <p className="text-xs text-white/50">
                Saves at {outSize.w} × {outSize.h} px
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function DarkIcon({ label, onClick, disabled, active, big, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; big?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-md disabled:opacity-40',
        big ? 'size-10' : 'size-8',
        active ? 'bg-accent text-white' : 'text-white/75 hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={clsx('h-7 rounded-md px-2', on ? 'bg-white/20 text-white' : 'hover:bg-white/10')}>
      {children}
    </button>
  );
}

/** A slider whose moves aren't each kept for Undo: only where it's let go (`end`). */
function Range({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number, end: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      {label}
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
        onKeyUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
        className="w-28 accent-[var(--color-accent)]"
      />
      <span className="w-7 tabular-nums">{value}</span>
    </label>
  );
}

function PanelRange({ label, min, max, value, unit = '%', onChange }: { label: string; min: number; max: number; value: number; unit?: string; onChange: (v: number, end: boolean) => void }) {
  return (
    <label className="block">
      <span className="flex justify-between text-xs text-white/70">
        {label}
        <span className="tabular-nums">
          {value}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
        onKeyUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
        className="w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}
