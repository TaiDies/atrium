/// <reference lib="webworker" />
// Draws PDF pages away from the main thread (see pdfWorkerDoc.ts). PDF.js runs here, drawing each page
// into an OffscreenCanvas that's sent back as an ImageBitmap, so a heavy page never holds up scrolling,
// flipping pages or anything else in the app. Pages are drawn one at a time, newest request first; a
// request for a page that's no longer wanted is dropped, or stopped if it's being drawn.

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type ToWorker =
  | { type: 'open'; url: string; assets: Record<string, unknown> }
  | { type: 'size'; id: number; page: number }
  | { type: 'text'; id: number; page: number }
  | { type: 'render'; id: number; page: number; scale: number; ratio: number; urgent: boolean }
  | { type: 'cancel'; id: number }
  | { type: 'close' };

/** A page's size in points, and what a text layer needs to place its text. */
export interface PageInfo {
  width: number;
  height: number;
  rotation: number;
  rawDims: { pageWidth: number; pageHeight: number; pageX: number; pageY: number };
}

export type FromWorker =
  | { type: 'opened'; pages: number; first: PageInfo; last: PageInfo }
  | { type: 'failed'; error: string }
  | { type: 'size'; id: number; info: PageInfo | null }
  | { type: 'text'; id: number; content: unknown }
  | { type: 'rendered'; id: number; bitmap: ImageBitmap | null; error?: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// PDF.js reads a few things from `window` (the file's address, the screen size for a drawing size
// limit, animation frames). A worker has no window, so it gets a small stand-in with just those.
(globalThis as { window?: unknown }).window ??= {
  location: self.location,
  screen: { availWidth: 8192, availHeight: 8192 },
  devicePixelRatio: 1,
  // PDF.js spreads drawing over animation frames so a page doesn't freeze the screen; in a worker there's
  // no screen to freeze, so each step just runs next.
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const post = (msg: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

class OffscreenCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext('2d')! };
  }
  reset(c: { canvas: OffscreenCanvas }, width: number, height: number) {
    c.canvas.width = Math.max(1, width);
    c.canvas.height = Math.max(1, height);
  }
  destroy(c: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (c.canvas) c.canvas.width = c.canvas.height = 0;
    c.canvas = null;
    c.context = null;
  }
}

// Effects that need SVG filters in the page (rare: transfer functions, some soft masks) are skipped here.
class NoFilterFactory {
  addFilter() {
    return 'none';
  }
  addHCMFilter() {
    return 'none';
  }
  addAlphaFilter() {
    return 'none';
  }
  addLuminosityFilter() {
    return 'none';
  }
  addHighlightHCMFilter() {
    return 'none';
  }
  destroy() {}
}

let loading: PDFDocumentLoadingTask | null = null;
let doc: PDFDocumentProxy | null = null;
let opened: Promise<PDFDocumentProxy> | null = null;

async function info(n: number): Promise<PageInfo> {
  const page = await doc!.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const [x0, y0, x1, y1] = vp.viewBox;
  return { width: vp.width, height: vp.height, rotation: vp.rotation, rawDims: { pageWidth: x1 - x0, pageHeight: y1 - y0, pageX: x0, pageY: y0 } };
}

// ----- drawing queue -----
type Job = { id: number; page: number; scale: number; ratio: number; urgent: boolean };
const queue: Job[] = [];
let current: { job: Job; task: RenderTask | null; cancelled: boolean } | null = null;

async function pump() {
  if (current || !doc) return;
  // The newest urgent request (a page on screen) first, then the newest of the rest.
  let at = -1;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].urgent) {
    at = i;
    break;
  }
  if (at < 0) at = queue.length - 1;
  if (at < 0) return;
  const job = queue.splice(at, 1)[0];
  const run: { job: Job; task: RenderTask | null; cancelled: boolean } = { job, task: null, cancelled: false };
  current = run;
  let bitmap: ImageBitmap | null = null;
  let error: string | undefined;
  try {
    const page = await doc.getPage(job.page);
    if (!run.cancelled) {
      const viewport = page.getViewport({ scale: job.scale });
      const canvas = new OffscreenCanvas(Math.max(1, Math.floor(viewport.width * job.ratio)), Math.max(1, Math.floor(viewport.height * job.ratio)));
      const context = canvas.getContext('2d')!;
      run.task = page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        transform: job.ratio !== 1 ? [job.ratio, 0, 0, job.ratio, 0, 0] : undefined,
      });
      await run.task.promise;
      if (!run.cancelled) bitmap = canvas.transferToImageBitmap();
    }
  } catch (err) {
    // Stopped, or the page couldn't be drawn.
    error = err instanceof Error ? `${err.message} ${err.stack ?? ''}`.slice(0, 600) : String(err);
  }
  current = null;
  if (!run.cancelled) post({ type: 'rendered', id: job.id, bitmap, error }, bitmap ? [bitmap] : []);
  void pump();
}

ctx.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'open') {
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      loading = pdfjs.getDocument({
        url: msg.url,
        withCredentials: true,
        ...msg.assets,
        // No page here: fonts are drawn as shapes, canvases are offscreen, and files are fetched by the worker.
        disableFontFace: true,
        isOffscreenCanvasSupported: true,
        useWorkerFetch: true,
        CanvasFactory: OffscreenCanvasFactory,
        FilterFactory: NoFilterFactory,
      } as Parameters<typeof pdfjs.getDocument>[0]);
      opened = loading.promise;
      doc = await opened;
      post({ type: 'opened', pages: doc.numPages, first: await info(1), last: await info(doc.numPages) });
      void pump();
    } catch (err) {
      post({ type: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (msg.type === 'close') {
    queue.length = 0;
    if (current) current.cancelled = true;
    current?.task?.cancel();
    void loading?.destroy();
    ctx.close();
    return;
  }
  if (msg.type === 'cancel') {
    const i = queue.findIndex((j) => j.id === msg.id);
    if (i >= 0) queue.splice(i, 1);
    if (current?.job.id === msg.id) {
      current.cancelled = true;
      current.task?.cancel();
    }
    return;
  }
  await opened?.catch(() => null);
  if (!doc) return;
  if (msg.type === 'size') {
    post({ type: 'size', id: msg.id, info: await info(msg.page).catch(() => null) });
  } else if (msg.type === 'text') {
    let content: unknown = { items: [], styles: {} };
    try {
      content = await (await doc.getPage(msg.page)).getTextContent();
    } catch {
      // No text.
    }
    post({ type: 'text', id: msg.id, content });
  } else if (msg.type === 'render') {
    queue.push({ id: msg.id, page: msg.page, scale: msg.scale, ratio: msg.ratio, urgent: msg.urgent });
    void pump();
  }
};
