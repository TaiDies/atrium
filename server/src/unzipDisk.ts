import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { HttpError } from './util.js';

export interface UnzippedEntry {
  /** Where the entry was written (named by number, so names inside the .zip can't point outside `dir`). */
  file: string;
  size: number;
}

/**
 * Unpacks a .zip on disk into `dir` entry by entry, holding only a chunk at a time in memory. Counts what
 * is actually unpacked (not what the .zip claims) and stops once it's more than `maxBytes` or more than
 * `maxEntries` entries. Returns entry name → where it was written.
 */
export async function unzipToDisk(zipPath: string, dir: string, limits: { maxBytes: number; maxEntries: number }): Promise<Map<string, UnzippedEntry>> {
  const out = new Map<string, UnzippedEntry>();
  const tooBig = new HttpError(413, 'This .zip unpacks to too much to import here');
  const invalid = new HttpError(400, 'That isn’t a valid .zip file');
  let failure: HttpError | null = null;
  let total = 0;
  let count = 0;
  const open = new Set<WriteStream>();
  const finished: Promise<unknown>[] = [];

  const unzip = new Unzip((entry) => {
    if (failure || entry.name.endsWith('/')) return;
    if (++count > limits.maxEntries) {
      failure = tooBig;
      return;
    }
    const record: UnzippedEntry = { file: path.join(dir, String(count)), size: 0 };
    out.set(entry.name, record);
    const ws = createWriteStream(record.file);
    open.add(ws);
    finished.push(once(ws, 'close').catch(() => {}));
    ws.on('error', () => (failure ??= invalid));
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      open.delete(ws);
      ws.end();
    };
    entry.ondata = (err, chunk, final) => {
      if (ended) return;
      if (err) {
        failure ??= invalid;
        return end();
      }
      record.size += chunk.length;
      total += chunk.length;
      if (total > limits.maxBytes) {
        failure ??= tooBig;
        entry.terminate();
        return end();
      }
      ws.write(chunk);
      if (final) end();
    };
    try {
      entry.start();
    } catch {
      failure ??= invalid;
      end();
    }
  });
  unzip.register(UnzipInflate);

  for await (const chunk of createReadStream(zipPath, { highWaterMark: 1 << 20 })) {
    if (failure) break;
    try {
      unzip.push(chunk as Uint8Array);
    } catch {
      failure ??= invalid;
      break;
    }
    // Let the disk catch up before reading more, so unpacked data never piles up in memory.
    for (const ws of open) if (ws.writableNeedDrain) await once(ws, 'drain').catch(() => {});
  }
  if (!failure) {
    try {
      unzip.push(new Uint8Array(0), true);
    } catch {
      failure = invalid;
    }
  }
  for (const ws of open) ws.end();
  await Promise.all(finished);
  if (failure) throw failure;
  return out;
}
