import type { FromWorker, PageInfo, ToWorker } from './pdfRenderWorker';
import { pdfAssets } from './pdf';

// A PDF drawn in a background worker (pdfRenderWorker.ts), shaped like the parts of a PDF.js document
// the viewer uses: page count, page sizes and text. Drawing a page gives an ImageBitmap that's put on
// screen without copying, so however heavy a page is, the app keeps responding and you can flip or
// scroll past pages faster than they're drawn (pages no longer wanted are dropped).

/** Whether this browser can draw PDFs in a worker (OffscreenCanvas and ImageBitmap rendering). */
export const workerDrawingSupported = () =>
  typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined' && typeof ImageBitmapRenderingContext !== 'undefined';

export class WorkerDoc {
  readonly inWorker = true;
  numPages = 0;
  first!: PageInfo;
  last!: PageInfo;
  private worker: Worker;
  private nextId = 1;
  private waiting = new Map<number, (msg: FromWorker) => void>();
  private sizes = new Map<number, Promise<PageInfo | null>>();
  private texts = new Map<number, Promise<unknown>>();

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if ('id' in msg) {
        const done = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (done) done(msg);
        else if (msg.type === 'rendered') msg.bitmap?.close();
      }
    };
  }

  /** Opens the PDF at `url` in a new worker. */
  static open(url: string): Promise<WorkerDoc> {
    const worker = new Worker(new URL('./pdfRenderWorker.ts', import.meta.url), { type: 'module' });
    const d = new WorkerDoc(worker);
    return new Promise((resolve, reject) => {
      worker.addEventListener('message', function first(e: MessageEvent<FromWorker>) {
        const msg = e.data;
        if (msg.type === 'opened') {
          worker.removeEventListener('message', first);
          d.numPages = msg.pages;
          d.first = msg.first;
          d.last = msg.last;
          resolve(d);
        } else if (msg.type === 'failed') {
          worker.removeEventListener('message', first);
          worker.terminate();
          reject(new Error(msg.error));
        }
      });
      worker.addEventListener('error', (e) => {
        worker.terminate();
        reject(new Error(e.message || 'The PDF worker failed'));
      });
      d.send({ type: 'open', url: new URL(url, location.href).href, assets: pdfAssets() });
    });
  }

  private send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  private ask<T extends FromWorker>(msg: ToWorker & { id: number }): Promise<T> {
    return new Promise((resolve) => {
      this.waiting.set(msg.id, resolve as (m: FromWorker) => void);
      this.send(msg);
    });
  }

  info(n: number): Promise<PageInfo | null> {
    let s = this.sizes.get(n);
    if (!s) {
      s = this.ask<Extract<FromWorker, { type: 'size' }>>({ type: 'size', id: this.nextId++, page: n }).then((m) => m.info);
      this.sizes.set(n, s);
    }
    return s;
  }

  text(n: number): Promise<unknown> {
    let t = this.texts.get(n);
    if (!t) {
      t = this.ask<Extract<FromWorker, { type: 'text' }>>({ type: 'text', id: this.nextId++, page: n }).then((m) => m.content);
      this.texts.set(n, t);
    }
    return t;
  }

  /**
   * Draws page `n`; `urgent` for pages on screen (drawn before pages fetched ahead). Returns the
   * bitmap (null if it couldn't be drawn) and a cancel function for when the page is no longer wanted.
   */
  render(n: number, scale: number, ratio: number, urgent: boolean): { done: Promise<ImageBitmap | null>; cancel: () => void } {
    const id = this.nextId++;
    let cancelled = false;
    const done = this.ask<Extract<FromWorker, { type: 'rendered' }>>({ type: 'render', id, page: n, scale, ratio, urgent }).then((m) => m.bitmap);
    return {
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // A bitmap that arrives anyway is closed (see onmessage).
        this.waiting.delete(id);
        this.send({ type: 'cancel', id });
      },
    };
  }

  /** What the viewer asks of a PDF.js document: a page's size and its text. */
  async getPage(n: number) {
    const i = (await this.info(n)) ?? this.first;
    return {
      info: i,
      getViewport: ({ scale }: { scale: number }) => ({ width: i.width * scale, height: i.height * scale }),
      getTextContent: async () => (await this.text(n)) as { items: ({ str: string } | object)[] },
    };
  }

  destroy() {
    this.send({ type: 'close' });
    for (const done of this.waiting.values()) done({ type: 'rendered', id: 0, bitmap: null });
    this.waiting.clear();
    setTimeout(() => this.worker.terminate(), 1000);
  }
}

export const isWorkerDoc = (doc: unknown): doc is WorkerDoc => !!doc && (doc as { inWorker?: unknown }).inWorker === true;
