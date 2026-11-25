// Where a PDF page's pictures land on its canvas, so dark pages can show pictures in their real colours
// while the rest of the page (text, lines, backgrounds) is inverted. Found by walking the page's drawing
// steps (PDF.js operator list) and tracking the position, clipping included; works in a worker too.

type Ops = Record<string, number>;
type Matrix = [number, number, number, number, number, number];

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The box [x0, y0, x1, y1] that box `b` (in the space of `m`) covers once placed by `m`. */
function place(m: Matrix, b: number[]): number[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const meet = (a: number[] | null, b: number[]): number[] =>
  a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b;

/**
 * The canvas-pixel boxes [x, y, w, h, ...] of the page's pictures. `base` is the viewport's transform
 * times the pixel ratio. Pictures filling most of the page (a scanned page) are left out, so scanned
 * pages still turn dark; so are tiny ones and picture masks (they're drawn in a colour, like text).
 */
export function imageRects(list: { fnArray: number[]; argsArray: unknown[] }, OPS: Ops, base: Matrix, width: number, height: number): number[] {
  let ctm = base;
  let clip: number[] | null = null;
  let pendingClip = false;
  const stack: { ctm: Matrix; clip: number[] | null }[] = [];
  const out: number[] = [];
  const pageArea = width * height;
  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push({ ctm, clip });
        break;
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd: {
        const s = stack.pop();
        if (s) ({ ctm, clip } = s);
        break;
      }
      case OPS.transform:
        ctm = mul(ctm, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push({ ctm, clip });
        const [matrix, bbox] = args as [Matrix | null, number[] | null];
        if (matrix) ctm = mul(ctm, matrix);
        if (bbox) clip = meet(clip, place(ctm, bbox));
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.constructPath: {
        if (pendingClip) {
          const minMax = (args as unknown[])[2] as number[] | null;
          if (minMax && minMax[0] <= minMax[2]) clip = meet(clip, place(ctm, Array.from(minMax)));
          pendingClip = false;
        }
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        let r = place(ctm, [0, 0, 1, 1]);
        if (clip) r = meet(clip, r);
        r = meet([0, 0, width, height], r);
        const w = r[2] - r[0];
        const h = r[3] - r[1];
        if (w >= 4 && h >= 4 && w * h < pageArea * 0.8) out.push(Math.floor(r[0]), Math.floor(r[1]), Math.ceil(w), Math.ceil(h));
        break;
      }
    }
  }
  return out;
}

/** The smallest box [x, y, w, h] around all the boxes, or null if there are none. */
export function unionRect(rects: number[]): [number, number, number, number] | null {
  if (!rects.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < rects.length; i += 4) {
    x0 = Math.min(x0, rects[i]);
    y0 = Math.min(y0, rects[i + 1]);
    x1 = Math.max(x1, rects[i] + rects[i + 2]);
    y1 = Math.max(y1, rects[i + 1] + rects[i + 3]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * Copies just the pictures from `source` (the page drawing) onto `target`, which covers the boxes'
 * union; returns that union, or null (and frees `target`) if the page has no pictures.
 */
export function paintImages(target: HTMLCanvasElement, source: CanvasImageSource, rects: number[]) {
  const u = unionRect(rects);
  if (!u) {
    target.width = target.height = 0;
    return null;
  }
  target.width = u[2];
  target.height = u[3];
  const c = target.getContext('2d');
  if (!c) return null;
  c.beginPath();
  for (let i = 0; i < rects.length; i += 4) c.rect(rects[i] - u[0], rects[i + 1] - u[1], rects[i + 2], rects[i + 3]);
  c.clip();
  c.drawImage(source, -u[0], -u[1]);
  return u;
}
