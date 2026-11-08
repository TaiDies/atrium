import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { HttpError } from './util.js';

/** At most about 4 MB unpacks from one slice (deflate expands at most ~1000×) before the disk catches up. */
const SLICE = 4 * 1024;

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
  let empties: Promise<void> = Promise.resolve();

  const unzip = new Unzip((entry) => {
    if (failure || entry.name.endsWith('/')) return;
    if (++count > limits.maxEntries) {
      failure = tooBig;
      return;
    }
    const record: UnzippedEntry = { file: path.join(dir, String(count)), size: 0 };
    out.set(entry.name, record);
    // The file is opened only once there's something to write, so a .zip of many empty entries doesn't
    // open thousands of files at once.
    let ws: WriteStream | null = null;
    const stream = () => {
      if (ws) return ws;
      ws = createWriteStream(record.file);
      open.add(ws);
      finished.push(once(ws, 'close').catch(() => {}));
      ws.on('error', () => (failure ??= invalid));
      return ws;
    };
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (ws) {
        open.delete(ws);
        ws.end();
      } else {
        // Empty entries are written one after another (thousands at once would run out of file handles).
        empties = empties.then(() => writeFile(record.file, '')).catch(() => void (failure ??= invalid));
      }
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
      if (chunk.length) stream().write(chunk);
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
    // Small slices: fflate handles every entry that starts in a slice in one go (recursively), so a slice
    // packed with thousands of tiny entries would run out of stack. And after each slice the disk is
    // allowed to catch up: one slice of a crafted .zip can unpack to about 1000 times its size, so
    // waiting only between larger chunks would let that pile up in memory.
    const bytes = chunk as Uint8Array;
    for (let at = 0; at < bytes.length && !failure; at += SLICE) {
      try {
        unzip.push(bytes.subarray(at, at + SLICE));
      } catch {
        failure ??= invalid;
        break;
      }
      for (const ws of open) if (ws.writableNeedDrain) await once(ws, 'drain').catch(() => {});
    }
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
  await empties;
  if (failure) throw failure;
  return out;
}
