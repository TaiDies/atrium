import * as Y from 'yjs';

/**
 * Handwriting on a file. Items live in the file's Yjs document ("file:<id>") so everyone viewing the
 * file sees them live. Coordinates are fractions of the page *width* (x and y alike), so items keep
 * their shape at any zoom level and on any screen.
 */
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'shape';
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'polygon';

/** A freehand stroke, or — with `shape` set — a straight line, arrow, rectangle, ellipse or polygon. */
export interface Stroke {
  id: string;
  page: number; // 0-based; pages after the PDF's own are blank pages added in the app
  tool: 'pen' | 'highlighter';
  color: string;
  width: number; // fraction of page width
  /** Freehand: x0, y0, x1, y1, … · line/arrow: start and end · rect/ellipse: two opposite corners · polygon: its corners. */
  points: number[];
  shape?: ShapeKind;
}

/** Typed text placed on a page; (x, y) is the top-left corner. */
export interface TextItem {
  id: string;
  page: number;
  tool: 'text';
  color: string;
  size: number; // font size, fraction of page width
  x: number;
  y: number;
  text: string;
}

export type InkItem = Stroke | TextItem;

export const isText = (i: InkItem): i is TextItem => i.tool === 'text';

export function isInkItem(v: unknown): v is InkItem {
  if (!v || typeof v !== 'object') return false;
  const i = v as { id?: unknown; page?: unknown; tool?: unknown; text?: unknown; points?: unknown };
  if (typeof i.id !== 'string' || typeof i.page !== 'number') return false;
  return i.tool === 'text' ? typeof i.text === 'string' : Array.isArray(i.points);
}

export const PEN_COLORS = ['#1f1f1f', '#e03e3e', '#2f80ed', '#1f9d6b', '#f59e0b', '#a855d6', '#ffffff'];
export const HIGHLIGHTER_COLORS = ['#ffe14d', '#7cf27a', '#69d2ff', '#ff8ad8', '#ffb44d'];
export const PEN_SIZES = [0.0015, 0.0025, 0.004, 0.007, 0.012];
export const HIGHLIGHTER_SIZES = [0.012, 0.02, 0.03];
export const TEXT_SIZES = [0.016, 0.022, 0.03, 0.042, 0.06];
export const HIGHLIGHTER_OPACITY = 0.38;
export const TEXT_LINE_HEIGHT = 1.25;
export const TEXT_FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export function strokesOf(doc: Y.Doc) {
  return doc.getArray<InkItem>('strokes');
}

export function metaOf(doc: Y.Doc) {
  return doc.getMap<unknown>('meta');
}

export const LOCAL = 'local-ink';

const f = (n: number) => n.toFixed(4);

/** A smooth SVG path through the points (quadratic curves between midpoints). */
export function pathOf(points: number[]): string {
  const n = points.length / 2;
  if (n === 0) return '';
  const p = (i: number) => `${f(points[i * 2])} ${f(points[i * 2 + 1])}`;
  if (n === 1) return `M ${p(0)} L ${p(0)}`;
  if (n === 2) return `M ${p(0)} L ${p(1)}`;
  let d = `M ${p(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (points[i * 2] + points[i * 2 + 2]) / 2;
    const my = (points[i * 2 + 1] + points[i * 2 + 3]) / 2;
    d += ` Q ${p(i)} ${f(mx)} ${f(my)}`;
  }
  return `${d} L ${p(n - 1)}`;
}

function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number): number[] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.min(Math.hypot(x2 - x1, y2 - y1) * 0.4, Math.max(0.018, width * 5));
  const a = Math.PI / 7;
  return [x2 - len * Math.cos(angle - a), y2 - len * Math.sin(angle - a), x2 - len * Math.cos(angle + a), y2 - len * Math.sin(angle + a)];
}

/** The SVG path of a stroke, whether freehand or a shape. */
export function strokePath(s: Pick<Stroke, 'points' | 'shape' | 'width'>): string {
  const p = s.points;
  switch (s.shape) {
    case 'line':
      return `M ${f(p[0])} ${f(p[1])} L ${f(p[2])} ${f(p[3])}`;
    case 'arrow': {
      const [ax, ay, bx, by] = arrowHead(p[0], p[1], p[2], p[3], s.width);
      return `M ${f(p[0])} ${f(p[1])} L ${f(p[2])} ${f(p[3])} M ${f(ax)} ${f(ay)} L ${f(p[2])} ${f(p[3])} L ${f(bx)} ${f(by)}`;
    }
    case 'rect': {
      const [x1, y1, x2, y2] = p;
      return `M ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y1)} L ${f(x2)} ${f(y2)} L ${f(x1)} ${f(y2)} Z`;
    }
    case 'ellipse': {
      const cx = (p[0] + p[2]) / 2;
      const cy = (p[1] + p[3]) / 2;
      const rx = Math.abs(p[2] - p[0]) / 2;
      const ry = Math.abs(p[3] - p[1]) / 2;
      // Two arcs (an SVG path, so the same drawing code works on screen and in the downloaded PDF).
      return `M ${f(cx - rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)} Z`;
    }
    case 'polygon': {
      let d = '';
      for (let i = 0; i < p.length; i += 2) d += `${i ? ' L' : 'M'} ${f(p[i])} ${f(p[i + 1])}`;
      return `${d} Z`;
    }
    default:
      return pathOf(p);
  }
}

/** Points along a stroke's outline, used for hit-testing shapes with the eraser. */
export function outlinePoints(s: Stroke): number[] {
  const p = s.points;
  switch (s.shape) {
    case 'line':
      return p.slice(0, 4);
    case 'arrow':
      return [...p.slice(0, 4), ...arrowHead(p[0], p[1], p[2], p[3], s.width).slice(0, 2), p[2], p[3], ...arrowHead(p[0], p[1], p[2], p[3], s.width).slice(2)];
    case 'rect':
      return [p[0], p[1], p[2], p[1], p[2], p[3], p[0], p[3], p[0], p[1]];
    case 'ellipse': {
      const cx = (p[0] + p[2]) / 2;
      const cy = (p[1] + p[3]) / 2;
      const rx = Math.abs(p[2] - p[0]) / 2;
      const ry = Math.abs(p[3] - p[1]) / 2;
      const out: number[] = [];
      for (let i = 0; i <= 48; i++) out.push(cx + rx * Math.cos((i / 48) * Math.PI * 2), cy + ry * Math.sin((i / 48) * Math.PI * 2));
      return out;
    }
    case 'polygon':
      return [...p, p[0], p[1]];
    default:
      return p;
  }
}

/** The box a text item takes up (approximate: from the character count). */
export function textBox(t: TextItem) {
  const lines = t.text.split('\n');
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return { x: t.x, y: t.y, w: longest * t.size * 0.56, h: lines.length * t.size * TEXT_LINE_HEIGHT };
}

function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return Math.hypot(ax + t * dx - x, ay + t * dy - y);
}

/** Whether an item passes within `radius` of (x, y) — used by the eraser and to pick text. */
export function hits(item: InkItem, x: number, y: number, radius: number): boolean {
  if (isText(item)) {
    const b = textBox(item);
    return x >= b.x - radius && x <= b.x + b.w + radius && y >= b.y - radius && y <= b.y + b.h + radius;
  }
  const r = radius + item.width / 2;
  const pts = outlinePoints(item);
  for (let i = 0; i < pts.length; i += 2) {
    if (segmentDistance(x, y, pts[i], pts[i + 1], pts[i + 2] ?? pts[i], pts[i + 3] ?? pts[i + 1]) <= r) return true;
  }
  return false;
}

/** Drops points closer together than `minGap` so long strokes stay small. */
export function simplify(points: number[], minGap = 0.0008): number[] {
  if (points.length <= 4) return points.map(round);
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - out[out.length - 2];
    const dy = points[i + 1] - out[out.length - 1];
    if (dx * dx + dy * dy >= minGap * minGap) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out.map(round);
}

const round = (v: number) => Math.round(v * 100000) / 100000;

// ---------- drawing helpers: Shift constraints and shape recognition ----------

/** Snaps the end of a line to the nearest 45° from its start (Shift while drawing a line). */
export function snapAngle(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.round(Math.atan2(y2 - y1, x2 - x1) / (Math.PI / 4)) * (Math.PI / 4);
  return [x1 + len * Math.cos(angle), y1 + len * Math.sin(angle)];
}

/** Makes a box square, keeping the corner it was dragged from (Shift while drawing a rectangle or ellipse). */
export function squareUp(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const side = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  return [x1 + side * Math.sign(x2 - x1 || 1), y1 + side * Math.sign(y2 - y1 || 1)];
}

/** The points of a shape dragged from (x1, y1) to (x2, y2) with the Shapes tool. */
export function shapeFromDrag(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number, constrain: boolean): number[] {
  if (kind === 'line' || kind === 'arrow') return constrain ? [x1, y1, ...snapAngle(x1, y1, x2, y2)] : [x1, y1, x2, y2];
  if (kind === 'polygon') {
    // A triangle pointing up inside the dragged box.
    const [ex, ey] = constrain ? squareUp(x1, y1, x2, y2) : [x2, y2];
    return [(x1 + ex) / 2, Math.min(y1, ey), Math.max(x1, ex), Math.max(y1, ey), Math.min(x1, ex), Math.max(y1, ey)];
  }
  return constrain ? [x1, y1, ...squareUp(x1, y1, x2, y2)] : [x1, y1, x2, y2];
}

type Pt = [number, number];

function toPts(points: number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i += 2) out.push([points[i], points[i + 1]]);
  return out;
}

function douglasPeucker(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let index = -1;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segmentDistance(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [a, b];
  return [...douglasPeucker(pts.slice(0, index + 1), epsilon).slice(0, -1), ...douglasPeucker(pts.slice(index), epsilon)];
}

/** Corners of a closed freehand loop: simplified, then with nearly-straight corners removed. */
function corners(pts: Pt[], diag: number): Pt[] {
  let v = douglasPeucker(pts, diag * 0.07);
  if (v.length > 1 && Math.hypot(v[0][0] - v[v.length - 1][0], v[0][1] - v[v.length - 1][1]) < diag * 0.2) v = v.slice(0, -1);
  let changed = true;
  while (changed && v.length > 3) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      const prev = v[(i - 1 + v.length) % v.length];
      const cur = v[i];
      const next = v[(i + 1) % v.length];
      const a1 = Math.atan2(cur[1] - prev[1], cur[0] - prev[0]);
      const a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0]);
      let turn = Math.abs(a2 - a1);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      const short = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) < diag * 0.12;
      if (turn < (25 * Math.PI) / 180 || short) {
        v.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return v;
}

/**
 * Recognises a freehand stroke as a clean shape — a straight line, circle or ellipse, rectangle,
 * triangle or other polygon — or returns null when it doesn't look like one.
 */
export function recognizeShape(points: number[]): { shape: ShapeKind; points: number[] } | null {
  const pts = toPts(points);
  if (pts.length < 5) return null;
  let length = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i) length += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (length < 0.02 || diag < 0.01) return null;
  const [first, last] = [pts[0], pts[pts.length - 1]];
  const ends = Math.hypot(last[0] - first[0], last[1] - first[1]);

  // A straight line: the ends are nearly as far apart as the whole stroke is long.
  if (ends > length * 0.9) {
    const deviation = Math.max(...pts.map(([x, y]) => segmentDistance(x, y, first[0], first[1], last[0], last[1])));
    if (deviation < Math.max(0.006, ends * 0.06)) return { shape: 'line', points: [first[0], first[1], last[0], last[1]] };
    return null;
  }

  // Everything else has to come back round to where it started.
  if (ends > diag * 0.3) return null;

  // An ellipse: every point sits close to the ellipse that fits the bounding box.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = w / 2;
  const ry = h / 2;
  if (rx > 0.004 && ry > 0.004) {
    let err = 0;
    for (const [x, y] of pts) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
    err /= pts.length;
    const v = corners(pts, diag);
    if (err < 0.1 && v.length > 4) {
      // Nearly round: make it a true circle.
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.2) {
        const r = (rx + ry) / 2;
        return { shape: 'ellipse', points: [cx - r, cy - r, cx + r, cy + r] };
      }
      return { shape: 'ellipse', points: [minX, minY, maxX, maxY] };
    }
    if (v.length === 3) return { shape: 'polygon', points: v.flat() };
    if (v.length === 4) {
      // Mostly upright sides: a rectangle from the box; otherwise keep the four corners.
      const tilt = Math.abs(Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0])) % (Math.PI / 2);
      const upright = tilt < 0.26 || tilt > Math.PI / 2 - 0.26;
      return upright ? { shape: 'rect', points: [minX, minY, maxX, maxY] } : { shape: 'polygon', points: v.flat() };
    }
    if (v.length >= 5 && v.length <= 6 && err < 0.16) return { shape: 'ellipse', points: [minX, minY, maxX, maxY] };
    if (v.length >= 5 && v.length <= 8) return { shape: 'polygon', points: v.flat() };
  }
  return null;
}

/** Centre of a shape's points (for resizing a recognised shape around its middle). */
export function centerOf(points: number[]): [number, number] {
  let x = 0;
  let y = 0;
  const n = points.length / 2;
  for (let i = 0; i < points.length; i += 2) {
    x += points[i];
    y += points[i + 1];
  }
  return [x / n, y / n];
}

export function scaleAbout(points: number[], cx: number, cy: number, k: number): number[] {
  return points.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * k : cy + (v - cy) * k));
}

// ---------- download with notes ----------

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** Typed text drawn to an image (so any language and the same font as on screen end up in the PDF). */
async function textImage(t: TextItem, pageWidthPt: number): Promise<{ png: Uint8Array; w: number; h: number } | null> {
  const scale = 3; // pixels per PDF point, for crisp text
  const size = t.size * pageWidthPt;
  const lines = t.text.split('\n');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${size * scale}px ${TEXT_FONT}`;
  const w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width)) / scale;
  const h = lines.length * size * TEXT_LINE_HEIGHT;
  canvas.width = Math.ceil(w * scale) + 4;
  canvas.height = Math.ceil(h * scale) + 4;
  ctx.font = `${size * scale}px ${TEXT_FONT}`;
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, 1, 1 + i * size * TEXT_LINE_HEIGHT * scale + (size * (TEXT_LINE_HEIGHT - 1) * scale) / 2));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return { png: new Uint8Array(await blob.arrayBuffer()), w: canvas.width / scale, h: canvas.height / scale };
}

/** The PDF with the handwriting, shapes, text (and any added pages) drawn into it, for "Download with notes". */
export async function flattenPdf(url: string, items: InkItem[], extraPages: number): Promise<Uint8Array> {
  const { PDFDocument, rgb, LineCapStyle } = await import('pdf-lib');
  const bytes = await (await fetch(url, { credentials: 'include' })).arrayBuffer();
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const last = pdf.getPage(pdf.getPageCount() - 1);
  for (let i = 0; i < extraPages; i++) pdf.addPage([last.getWidth(), last.getHeight()]);
  const pages = pdf.getPages();
  for (const item of items) {
    const page = pages[item.page];
    if (!page) continue;
    const { width, height } = page.getSize();
    if (isText(item)) {
      if (!item.text.trim()) continue;
      const img = await textImage(item, width);
      if (!img) continue;
      const embedded = await pdf.embedPng(img.png);
      page.drawImage(embedded, { x: item.x * width, y: height - item.y * width - img.h, width: img.w, height: img.h });
      continue;
    }
    if (item.points.length < 2) continue;
    const c = hexToRgb(item.color);
    const points = !item.shape && item.points.length === 2 ? [...item.points, item.points[0] + 0.0001, item.points[1]] : item.points;
    page.drawSvgPath(strokePath({ ...item, points }), {
      x: 0,
      y: height,
      scale: width,
      borderColor: rgb(c.r, c.g, c.b),
      borderWidth: item.width,
      borderOpacity: item.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1,
      borderLineCap: LineCapStyle.Round,
    });
  }
  return pdf.save();
}
