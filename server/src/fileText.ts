import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from './config.js';
import { convert, converterAvailable, kindOfName } from './convert.js';
import { one, query } from './db.js';
import type { PdfJob, PdfResult } from './fileTextWorker.js';
import { queueFlat } from './pdfFlat.js';

// The words inside uploaded files (PDFs, Word, Excel, PowerPoint, text…), kept for search. Scanned
// PDFs have no text layer, so only their names are searchable.

const MAX_TEXT = 300_000;
/** Largest files whose text is read for search: PDFs, and files converted to PDF first. */
const MAX_PDF_BYTES = 500 * 1024 * 1024;
const MAX_CONVERT_BYTES = 60 * 1024 * 1024;
// Plain-text files: only the start is decoded, enough for MAX_TEXT characters after spaces are collapsed.
const TEXT_BYTES = 4 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log)$/i;

// PDFs are read in a worker thread (fileTextWorker.ts): reading a big one takes seconds of CPU, which on
// the main thread would stall live editing, chat and page loads. One worker is reused; it is restarted
// if it crashes or takes longer than PDF_TIMEOUT_MS, and stopped when idle to give its memory back.
const PDF_TIMEOUT_MS = 120_000;
const IDLE_MS = 60_000;
// tsx runs the .ts sources in development; the Docker image runs the compiled .js in dist/.
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './fileTextWorker.ts' : './fileTextWorker.js', import.meta.url);

type Pending = { worker: Worker; resolve: (text: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
let worker: Worker | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let nextJob = 1;
const pending = new Map<number, Pending>();

function settle(id: number) {
  const job = pending.get(id);
  if (!job) return undefined;
  clearTimeout(job.timer);
  pending.delete(id);
  if (pending.size === 0 && worker) {
    const idle = worker;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (worker === idle && pending.size === 0) stopWorker(idle);
    }, IDLE_MS);
    idleTimer.unref();
  }
  return job;
}

function stopWorker(w: Worker) {
  if (worker === w) worker = null;
  for (const [id, job] of pending) if (job.worker === w) settle(id)?.reject(new Error('The PDF reader stopped'));
  void w.terminate();
}

function getWorker() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  // A memory cap, so a pathological file kills the worker rather than the server.
  const w = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
  w.unref();
  w.on('message', (msg: PdfResult) => {
    const job = settle(msg.id);
    if (!job) return;
    if ('error' in msg) job.reject(new Error(msg.error));
    else {
      if (msg.fallback) console.warn('MuPDF could not read a PDF, used pdf.js instead:', msg.fallback);
      job.resolve(msg.text);
    }
  });
  w.on('error', (err) => {
    console.error('The PDF reader failed', err);
    stopWorker(w);
  });
  w.on('exit', () => stopWorker(w));
  worker = w;
  return w;
}

/** The text of a PDF (up to about MAX_TEXT characters), read in the worker thread. */
export function pdfText(data: Buffer): Promise<string> {
  // Hand the bytes over without copying when the Buffer owns its whole memory (readFile's do).
  const bytes = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? new Uint8Array(data.buffer) : new Uint8Array(data);
  const w = getWorker();
  const id = nextJob++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(id)?.reject(new Error('Reading the PDF took too long'));
      stopWorker(w);
    }, PDF_TIMEOUT_MS);
    pending.set(id, { worker: w, resolve, reject, timer });
    w.postMessage({ id, data: bytes, max: MAX_TEXT } satisfies PdfJob, [bytes.buffer as ArrayBuffer]);
  });
}

/** Reads a file's text and stores it (an empty string means "looked, nothing found"). */
export async function indexFileText(fileId: string) {
  const file = await one<{ filename: string; mime_type: string; size: string }>('select filename, mime_type, size from files where id = $1', [fileId]);
  if (!file || Number(file.size) === 0) return;
  const isPdf = file.mime_type === 'application/pdf' || /\.pdf$/i.test(file.filename);
  // PDFs are read straight away in the worker thread, so big ones (scanned textbooks run to 100 MB+) are
  // fine; anything that needs converting with LibreOffice first stays smaller.
  if (Number(file.size) > (isPdf ? MAX_PDF_BYTES : MAX_CONVERT_BYTES)) return;
  let text = '';
  try {
    const data = await readFile(path.join(config.uploadDir, fileId));
    if (isPdf) text = await pdfText(data);
    else if (file.mime_type.startsWith('text/') || TEXT_EXT.test(file.filename)) text = data.subarray(0, TEXT_BYTES).toString('utf8');
    else {
      const kind = kindOfName(file.filename, file.mime_type);
      if (kind && (await converterAvailable())) text = await pdfText(await convert(data, file.filename, kind, 'pdf'));
    }
  } catch {
    text = '';
  }
  await query('update files set text_content = $2 where id = $1', [fileId, text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)]);
}

let queue: Promise<void> = Promise.resolve();

/** Indexes a file in the background, one at a time (conversions are heavy). */
export function queueFileText(fileId: string) {
  queue = queue.then(() => indexFileText(fileId)).catch((err) => console.error('Could not read the text of a file', fileId, err));
  // A PDF also gets its picture copy (pdfFlat.ts); anything else is skipped there.
  queueFlat(fileId);
}

/** Files uploaded before text search existed. */
export async function backfillFileText() {
  const files = await query<{ id: string }>('select id from files where text_content is null order by created_at desc limit 2000');
  for (const f of files) queueFileText(f.id);
}
