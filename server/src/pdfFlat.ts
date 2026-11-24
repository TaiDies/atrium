import { mkdirSync } from 'node:fs';
import { readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from './config.js';
import { query } from './db.js';
import type { FlatJob, FlatResult } from './pdfFlatWorker.js';

// A second copy of every PDF with text, "without text": each page as a picture (pdfFlatWorker.ts). Big
// books full of text are slow to show because every page's fonts and text have to be worked out; the
// picture copy only has pictures to draw. The viewer offers both and shows one at a time.
//
// Copies live in DATA_DIR/flat/<file id>. A copy older than its file (the file was saved over) is
// made again. "<id>.notext" marks a PDF with no text (a scan): it gets no copy, it's pictures already.
// Copies are made in the background, one at a time, each in its own worker thread.

const flatDir = path.join(config.uploadDir, '..', 'flat');
mkdirSync(flatDir, { recursive: true });

const DPI = 150;
const QUALITY = 75;
const MAX_BYTES = 1024 * 1024 * 1024;
const TIMEOUT_MS = 30 * 60_000;
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './pdfFlatWorker.ts' : './pdfFlatWorker.js', import.meta.url);

export const flatPath = (id: string) => path.join(flatDir, id);
const noTextPath = (id: string) => path.join(flatDir, `${id}.notext`);
const failedPath = (id: string) => path.join(flatDir, `${id}.failed`);

export type FlatStatus = 'ready' | 'notext' | 'pending' | 'failed' | 'none';

const mtime = (p: string) => stat(p).then((s) => s.mtimeMs, () => 0);

/** Whether the file's picture copy is there (and still matches the file). */
export async function flatStatus(id: string): Promise<FlatStatus> {
  const source = await mtime(path.join(config.uploadDir, id));
  if (!source) return 'none';
  const fresh = async (p: string) => (await mtime(p)) >= source;
  if (await fresh(flatPath(id))) return 'ready';
  if (await fresh(noTextPath(id))) return 'notext';
  if (queued.has(id) || running === id) return 'pending';
  if (await fresh(failedPath(id))) return 'failed';
  return 'none';
}

function runJob(job: FlatJob): Promise<FlatResult> {
  return new Promise((resolve) => {
    const w = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    let settled = false;
    const finish = (r: FlatResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ error: 'Took too long' }), TIMEOUT_MS);
    w.on('message', finish);
    w.on('error', (err: Error) => finish({ error: err.message }));
    w.on('exit', () => finish({ error: 'The worker stopped' }));
    w.postMessage(job);
  });
}

const queued = new Set<string>();
const order: string[] = [];
let running: string | null = null;

async function make(id: string) {
  const rows = await query<{ size: string; mime_type: string; filename: string }>('select size, mime_type, filename from files where id = $1', [id]);
  const file = rows[0];
  if (!file || !isPdf(file) || Number(file.size) === 0 || Number(file.size) > MAX_BYTES) return;
  const status = await flatStatus(id);
  // 'none' also means the stored file itself is missing: nothing to copy.
  if (status === 'ready' || status === 'notext' || !(await mtime(path.join(config.uploadDir, id)))) return;
  await Promise.all([flatPath(id), noTextPath(id), failedPath(id)].map((p) => unlink(p).catch(() => {})));
  const result = await runJob({ src: path.join(config.uploadDir, id), out: flatPath(id), dpi: DPI, quality: QUALITY });
  if ('error' in result) {
    console.warn('Could not make the picture copy of a PDF', id, result.error);
    await writeFile(failedPath(id), result.error).catch(() => {});
  } else if (result.done === 'notext') await writeFile(noTextPath(id), '').catch(() => {});
}

async function pump() {
  if (running) return;
  const id = order.shift();
  if (!id) return;
  queued.delete(id);
  running = id;
  try {
    await make(id);
  } catch (err) {
    console.error('Picture copy of a PDF failed', id, err);
  } finally {
    running = null;
    void pump();
  }
}

/** Makes the picture copy in the background; `first` puts it ahead of the others (someone is waiting). */
export function queueFlat(id: string, first = false) {
  if (running === id) return;
  if (queued.has(id)) {
    if (!first) return;
    order.splice(order.indexOf(id), 1);
  }
  queued.add(id);
  if (first) order.unshift(id);
  else order.push(id);
  void pump();
}

export const isPdf = (f: { mime_type: string; filename: string }) => f.mime_type === 'application/pdf' || /\.pdf$/i.test(f.filename);

/** Removes a file's copy (when the file is deleted). */
export async function removeFlat(id: string) {
  await Promise.all([flatPath(id), noTextPath(id), failedPath(id), `${flatPath(id)}.tmp`].map((p) => unlink(p).catch(() => {})));
}

/** On start: copies for PDFs that have none yet, and copies of files that no longer exist removed. */
export async function backfillFlat() {
  const pdfs = await query<{ id: string }>(
    "select id from files where (mime_type = 'application/pdf' or filename ilike '%.pdf') and size > 0 order by created_at desc",
  );
  const known = new Set(pdfs.map((p) => p.id));
  for (const name of await readdir(flatDir).catch(() => [] as string[])) {
    const id = name.replace(/\.(notext|failed|tmp)$/, '');
    if (!known.has(id) || name.endsWith('.tmp')) await unlink(path.join(flatDir, name)).catch(() => {});
  }
  for (const p of pdfs) {
    const s = await flatStatus(p.id);
    if (s === 'none') queueFlat(p.id);
  }
}
