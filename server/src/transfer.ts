import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, open, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';
import { z } from 'zod';
import * as Y from 'yjs';
import { type Access, accessMap } from './access.js';
import { DATABASE_TYPES, extractText, liveElementCount } from './collab.js';
import { config } from './config.js';
import { one, query, tx } from './db.js';
import { updateDocIndex } from './docIndex.js';
import { databaseToCsv, docToMarkdown } from './readable.js';
import { unzipToDisk } from './unzipDisk.js';
import { HttpError } from './util.js';

// Exporting pages (one, with or without its sub-pages, or a whole workspace) to a .zip that this app
// can import into another account or workspace, with readable Markdown/CSV copies for other apps.

export const EXPORT_FORMAT = 'atrium-export';
const MANIFEST = 'atrium-export.json';

interface ExportPage {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  icon: string;
  cover: string | null;
  position: number;
  state: string | null; // base64 Yjs update
  rows: { rowId: string; state: string }[];
}

interface ExportFile {
  id: string;
  name: string;
  mimeType: string;
  isNote: boolean;
  path: string;
  annotations: string | null;
}

interface ExportEvent {
  id: string;
  title: string;
  description: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  color: string;
  status: string | null;
  repeat: unknown;
  /** Tasks with paths (absent in older exports). */
  paths?: unknown;
  pathState?: unknown;
}

interface ExportBoard {
  id: string;
  title: string;
  state: string | null;
}

interface Manifest {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  source: { workspace: string; scope: 'page' | 'pages' | 'workspace' };
  pages: ExportPage[];
  files: ExportFile[];
  events: ExportEvent[];
  whiteboards: ExportBoard[];
}

const b64 = (buf: Buffer | Uint8Array | null | undefined) => (buf ? Buffer.from(buf).toString('base64') : null);
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function safeName(s: string, fallback: string) {
  const clean = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || fallback;
}

/** Every id (page, file, event, board) a Yjs document's blocks, cells and cover point at. */
function idsIn(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(UUID_G)) out.add(m[0].toLowerCase());
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    if (node instanceof Y.XmlElement) add(node.getAttributes());
    for (const c of node.toArray()) {
      if (c instanceof Y.XmlElement) walk(c);
      else if (c instanceof Y.XmlText) for (const op of c.toDelta() as { attributes?: unknown }[]) add(op.attributes);
    }
  };
  walk(doc.getXmlFragment('document-store'));
  for (const r of [...doc.getArray<Y.Map<unknown>>('rows').toArray(), ...doc.getArray<Y.Map<unknown>>('cardTemplates').toArray()]) if (r instanceof Y.Map) add(r.toJSON());
  doc.getMap('files').forEach((f) => add(f));
  return out;
}

function decode(state: string | Buffer | null | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, typeof state === 'string' ? Buffer.from(state, 'base64') : new Uint8Array(state));
  return doc;
}

const deflateRawAsync = promisify(deflateRaw);
const MAX32 = 0xffffffff;
/** Attachments of a text type up to this size are compressed (in memory, off the main thread); others are stored as they are. */
const COMPRESS_FILES_UP_TO = 16 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-ndjson|x-yaml|yaml|sql|x-sh|rtf)\b|image\/svg\+xml|[^;]*\+(json|xml)\b)/i;
const TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|ndjson|xml|svg|html?|css|js|ts|log|ya?ml|sql|rtf|ics|vcf)$/i;
/** Read size for attachments. */
const CHUNK = 1024 * 1024;

/** The export was stopped because whoever was downloading it went away. */
export class ExportAborted extends Error {
  constructor() {
    super('The download was closed before the export finished');
  }
}

interface ZipRecord {
  name: Buffer;
  utf8: boolean;
  method: 0 | 8;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

/**
 * Writes a .zip to a stream entry by entry. Every entry's size and checksum go in its own header (no
 * trailing "data descriptors"): the importer reads a .zip front to back (unzipDisk.ts), and without sizes up
 * front it would have to guess where an entry ends by looking for zip markers in the data — which breaks
 * on attachments that are themselves zips (.docx, .xlsx …). So attachments are read twice, once for the
 * checksum and once to send, a chunk at a time. Zip64 records are added only past 4 GB / 65535 entries.
 */
class ZipWriter {
  private offset = 0;
  private records: ZipRecord[] = [];
  private readonly time: number;
  private readonly date: number;

  constructor(private out: Writable) {
    const d = new Date();
    this.time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }

  /** Writes a chunk, waiting while the reader is slower than the export. */
  private async put(chunk: Uint8Array) {
    if (this.out.destroyed || this.out.writableEnded) throw new ExportAborted();
    this.offset += chunk.length;
    if (this.out.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        this.out.off('drain', done);
        this.out.off('close', closed);
        resolve();
      };
      const closed = () => {
        this.out.off('drain', done);
        reject(new ExportAborted());
      };
      this.out.once('drain', done);
      this.out.once('close', closed);
    });
  }

  private async header(name: string, method: 0 | 8, crc: number, csize: number, usize: number) {
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 0xffff) throw new Error(`Name too long for a .zip: ${name.slice(0, 80)}…`);
    // eslint-disable-next-line no-control-regex
    const utf8 = /[^\x00-\x7f]/.test(name);
    const z64 = csize >= MAX32 || usize >= MAX32;
    const h = Buffer.alloc(30 + (z64 ? 20 : 0));
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(z64 ? 45 : 20, 4);
    h.writeUInt16LE(utf8 ? 0x0800 : 0, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.time, 10);
    h.writeUInt16LE(this.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(z64 ? MAX32 : csize, 18);
    h.writeUInt32LE(z64 ? MAX32 : usize, 22);
    h.writeUInt16LE(nameBytes.length, 26);
    h.writeUInt16LE(z64 ? 20 : 0, 28);
    if (z64) {
      h.writeUInt16LE(0x0001, 30);
      h.writeUInt16LE(16, 32);
      h.writeBigUInt64LE(BigInt(usize), 34);
      h.writeBigUInt64LE(BigInt(csize), 42);
    }
    this.records.push({ name: nameBytes, utf8, method, crc, csize, usize, offset: this.offset });
    await this.put(h.subarray(0, 30));
    await this.put(nameBytes);
    if (z64) await this.put(h.subarray(30));
  }

  /** Adds an entry from memory; `compress` deflates it (on a worker thread) when that makes it smaller. */
  async addBytes(name: string, data: Uint8Array, compress: boolean) {
    const crc = crc32(data);
    let body = data;
    let method: 0 | 8 = 0;
    if (compress && data.length) {
      const packed = await deflateRawAsync(data, { level: 6 });
      if (packed.length < data.length) (body = packed), (method = 8);
    }
    await this.header(name, method, crc, body.length, data.length);
    for (let i = 0; i < body.length; i += CHUNK) await this.put(body.subarray(i, i + CHUNK));
  }

  /** Adds a file from disk. Returns false (and adds nothing) if it can't be opened (missing on disk). */
  async addFile(name: string, file: string, compress: boolean): Promise<boolean> {
    let handle;
    try {
      handle = await open(file, 'r');
    } catch {
      return false;
    }
    try {
      const { size } = await handle.stat();
      if (compress && size <= COMPRESS_FILES_UP_TO) {
        await this.addBytes(name, await handle.readFile(), true);
        return true;
      }
      let crc = 0;
      let seen = 0;
      for await (const chunk of handle.createReadStream({ start: 0, highWaterMark: CHUNK, autoClose: false }) as AsyncIterable<Buffer>) {
        crc = crc32(chunk, crc);
        seen += chunk.length;
      }
      if (seen !== size) throw new Error(`${file} changed while it was being exported`);
      await this.header(name, 0, crc, size, size);
      let sent = 0;
      for await (const chunk of handle.createReadStream({ start: 0, highWaterMark: CHUNK, autoClose: false }) as AsyncIterable<Buffer>) {
        sent += chunk.length;
        if (sent > size) break;
        await this.put(chunk);
      }
      if (sent !== size) throw new Error(`${file} changed while it was being exported`);
      return true;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** Writes the central directory and closes the .zip (the stream itself is left to the caller). */
  async finish() {
    const start = this.offset;
    for (const r of this.records) {
      const big = [r.usize >= MAX32, r.csize >= MAX32, r.offset >= MAX32];
      const extra = big.filter(Boolean).length * 8;
      const h = Buffer.alloc(46 + (extra ? 4 + extra : 0));
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(extra ? 45 : 20, 4);
      h.writeUInt16LE(extra ? 45 : 20, 6);
      h.writeUInt16LE(r.utf8 ? 0x0800 : 0, 8);
      h.writeUInt16LE(r.method, 10);
      h.writeUInt16LE(this.time, 12);
      h.writeUInt16LE(this.date, 14);
      h.writeUInt32LE(r.crc, 16);
      h.writeUInt32LE(big[1] ? MAX32 : r.csize, 20);
      h.writeUInt32LE(big[0] ? MAX32 : r.usize, 24);
      h.writeUInt16LE(r.name.length, 28);
      h.writeUInt16LE(extra ? 4 + extra : 0, 30);
      h.writeUInt32LE(big[2] ? MAX32 : r.offset, 42);
      if (extra) {
        h.writeUInt16LE(0x0001, 46);
        h.writeUInt16LE(extra, 48);
        let at = 50;
        for (const [i, v] of [r.usize, r.csize, r.offset].entries()) if (big[i]) h.writeBigUInt64LE(BigInt(v), at), (at += 8);
      }
      await this.put(h.subarray(0, 46));
      await this.put(r.name);
      if (extra) await this.put(h.subarray(46));
    }
    const size = this.offset - start;
    const count = this.records.length;
    if (count >= 0xffff || size >= MAX32 || start >= MAX32) {
      const z = Buffer.alloc(56 + 20);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(size), 40);
      z.writeBigUInt64LE(BigInt(start), 48);
      z.writeUInt32LE(0x07064b50, 56);
      z.writeBigUInt64LE(BigInt(this.offset), 64);
      z.writeUInt32LE(1, 72);
      await this.put(z);
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(Math.min(count, 0xffff), 8);
    e.writeUInt16LE(Math.min(count, 0xffff), 10);
    e.writeUInt32LE(Math.min(size, MAX32), 12);
    e.writeUInt32LE(Math.min(start, MAX32), 16);
    await this.put(e);
  }
}

/** A prepared export: its file name, and `write`, which streams the .zip into `out` (and doesn't end it). */
export interface PreparedExport {
  name: string;
  write: (out: Writable) => Promise<void>;
}

/**
 * Builds the export .zip in memory (for templates, which are kept in the database). The routes stream it
 * instead, with `prepareExport`.
 */
export async function buildExport(userId: string, workspaceId: string, rootIds: string[] | null, subpages: boolean): Promise<{ zip: Uint8Array; name: string }> {
  const prepared = await prepareExport(userId, workspaceId, rootIds, subpages);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  await prepared.write(sink);
  sink.end();
  return { zip: Buffer.concat(chunks), name: prepared.name };
}

/**
 * Gets an export ready. `rootIds` null means the whole workspace; otherwise those pages (and, with
 * `subpages`, everything under them). Only pages the user can see are included. Everything that can fail
 * with a reply (not found, nothing to export) fails here, before any of the .zip is sent; attachments are
 * read from disk only while the .zip is being written.
 */
export async function prepareExport(userId: string, workspaceId: string, rootIds: string[] | null, subpages: boolean): Promise<PreparedExport> {
  const workspace = await one<{ name: string }>('select name from workspaces where id = $1', [workspaceId]);
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  const access = await accessMap(userId, workspaceId);
  const visible = (id: string) => (access.get(id) ?? 'none') !== ('none' as Access);

  const all = await query<{ id: string; parent_id: string | null; type: string; title: string; icon: string; cover: string | null; position: number }>(
    'select id, parent_id, type, title, icon, cover, position from pages where workspace_id = $1 and deleted_at is null order by position, created_at',
    [workspaceId],
  );
  const children = new Map<string | null, typeof all>();
  for (const p of all) children.set(p.parent_id, [...(children.get(p.parent_id) ?? []), p]);
  const chosen = new Map<string, (typeof all)[number]>();
  const take = (p: (typeof all)[number], deep: boolean) => {
    if (!visible(p.id) || chosen.has(p.id)) return;
    chosen.set(p.id, p);
    if (deep) for (const c of children.get(p.id) ?? []) take(c, true);
  };
  if (rootIds === null) all.forEach((p) => take(p, false));
  else for (const id of rootIds) {
    const p = all.find((x) => x.id === id);
    if (p) take(p, subpages);
  }
  if (!chosen.size) throw new HttpError(404, 'Nothing to export');

  // A page whose parent isn't exported becomes a top-level page of the export.
  const parentIn = (p: (typeof all)[number]) => {
    let parent = p.parent_id;
    while (parent && !chosen.has(parent)) parent = all.find((x) => x.id === parent)?.parent_id ?? null;
    return parent;
  };

  const ids = [...chosen.keys()];
  const states = new Map((await query<{ page_id: string; state: Buffer }>('select page_id, state from page_content where page_id = any($1::uuid[])', [ids])).map((r) => [r.page_id, r.state]));
  const rowStates = await query<{ page_id: string; row_id: string; state: Buffer }>('select page_id, row_id, state from row_documents where page_id = any($1::uuid[])', [ids]);

  const referenced = new Set<string>();
  const pages: ExportPage[] = [];
  for (const p of chosen.values()) {
    const state = states.get(p.id);
    const rows = rowStates.filter((r) => r.page_id === p.id);
    for (const s of [state, ...rows.map((r) => r.state)]) if (s) idsIn(decode(s)).forEach((id) => referenced.add(id));
    if (p.cover) for (const m of p.cover.matchAll(UUID_G)) referenced.add(m[0].toLowerCase());
    pages.push({
      id: p.id,
      parentId: parentIn(p),
      type: p.type,
      title: p.title,
      icon: p.icon,
      cover: p.cover,
      position: p.position,
      state: b64(state),
      rows: rows.map((r) => ({ rowId: r.row_id, state: b64(r.state)! })),
    });
  }

  const whole = rootIds === null;
  const boards = await query<{ id: string; title: string; state: Buffer | null }>(
    `select id, title, state from whiteboards where workspace_id = $1 ${whole ? '' : 'and id = any($2::uuid[])'}`,
    whole ? [workspaceId] : [workspaceId, [...referenced]],
  );
  for (const b of boards) if (b.state) idsIn(decode(b.state)).forEach((id) => referenced.add(id));
  const events = await query<ExportEvent & { start: string }>(
    `select id, title, description, to_char(start_date, 'YYYY-MM-DD') as "startDate", start_time as "startTime", to_char(end_date, 'YYYY-MM-DD') as "endDate",
            end_time as "endTime", color, status, repeat, paths, path_state as "pathState" from events where workspace_id = $1 ${whole ? '' : 'and id = any($2::uuid[])'}`,
    whole ? [workspaceId] : [workspaceId, [...referenced]],
  );
  const files = await query<{ id: string; filename: string; mime_type: string; is_note: boolean; annotations: Buffer | null }>(
    `select f.id, f.filename, f.mime_type, f.is_note, a.state as annotations from files f left join file_annotations a on a.file_id = f.id
      where f.workspace_id = $1 ${whole ? '' : 'and f.id = any($2::uuid[])'}`,
    whole ? [workspaceId] : [workspaceId, [...referenced]],
  );

  const first = rootIds?.length === 1 ? chosen.get(rootIds[0]) : null;
  const name = safeName(whole ? workspace.name : first ? first.title : 'Pages', 'Export');
  return { name: `${name}.zip`, write: (out) => writeExport(out, { workspace, whole, subpages, all, pages, boards, events, files }) };
}

/** Streams an export's .zip: attachments first, then the readable copies, the manifest and a README. */
async function writeExport(
  out: Writable,
  { workspace, whole, subpages, all, pages, boards, events, files }: {
    workspace: { name: string };
    whole: boolean;
    subpages: boolean;
    all: { id: string; title: string }[];
    pages: ExportPage[];
    boards: { id: string; title: string; state: Buffer | null }[];
    events: ExportEvent[];
    files: { id: string; filename: string; mime_type: string; is_note: boolean; annotations: Buffer | null }[];
  },
) {
  const zip = new ZipWriter(out);
  const text = (s: string) => Buffer.from(s, 'utf8');
  const manifestFiles: ExportFile[] = [];
  for (const f of files) {
    const filePath = `files/${f.id}/${safeName(f.filename, 'file')}`;
    // Already-compressed formats (images, video, PDF, office files …) are stored as they are.
    const compress = TEXT_TYPES.test(f.mime_type) || TEXT_NAMES.test(f.filename);
    if (!(await zip.addFile(filePath, path.join(config.uploadDir, f.id), compress))) continue; // missing on disk
    manifestFiles.push({ id: f.id, name: f.filename, mimeType: f.mime_type, isNote: f.is_note, path: filePath, annotations: b64(f.annotations) });
  }

  // Readable copies: a folder per page, Markdown for documents and CSV for databases.
  const dirOf = new Map<string, string>();
  const used = new Set<string>();
  const dirFor = (p: ExportPage): string => {
    if (dirOf.has(p.id)) return dirOf.get(p.id)!;
    const parent = p.parentId ? pages.find((x) => x.id === p.parentId) : null;
    const base = `${parent ? dirFor(parent) : 'readable'}/${safeName(p.title, 'Untitled')}`;
    let dir = base;
    for (let i = 2; used.has(dir); i++) dir = `${base} (${i})`;
    used.add(dir);
    dirOf.set(p.id, dir);
    return dir;
  };
  const fileOf = (p: ExportPage) => `${dirFor(p)}/${safeName(p.title, 'Untitled')}.${(DATABASE_TYPES as readonly string[]).includes(p.type) ? 'csv' : 'md'}`;
  const relative = (from: string, to: string) => path.posix.relative(path.posix.dirname(from), to).split('/').map(encodeURIComponent).join('/');
  const fileById = new Map(manifestFiles.map((f) => [f.id, f]));
  const titleOf = new Map(all.map((p) => [p.id, p.title || 'Untitled']));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const boardById = new Map(boards.map((b) => [b.id, b]));
  for (const p of pages) {
    const entry = fileOf(p);
    const doc = decode(p.state);
    const body = (DATABASE_TYPES as readonly string[]).includes(p.type)
      ? databaseToCsv(doc)
      : docToMarkdown(doc, p.title, {
          pageLink: (id) => {
            const target = pages.find((x) => x.id === id);
            return { title: titleOf.get(id) ?? 'a page that was not exported', href: target ? relative(entry, fileOf(target)) : null };
          },
          fileLink: (url) => {
            const id = /\/api\/files\/([0-9a-f-]{36})/i.exec(url)?.[1]?.toLowerCase();
            const f = id ? fileById.get(id) : undefined;
            return f ? relative(entry, f.path) : null;
          },
          eventLabel: (id) => {
            const e = eventById.get(id);
            return e ? `${e.title || 'Untitled'} — ${e.startDate}${e.startTime ? ` ${e.startTime}` : ''}` : null;
          },
          boardLabel: (id) => boardById.get(id)?.title ?? null,
        });
    doc.destroy();
    await zip.addBytes(entry, text(body), true);
  }

  const manifest: Manifest = {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    source: { workspace: workspace.name, scope: whole ? 'workspace' : subpages ? 'pages' : 'page' },
    pages,
    files: manifestFiles,
    events: events.map(({ id, title, description, startDate, startTime, endDate, endTime, color, status, repeat, paths, pathState }) => ({
      id,
      title,
      description,
      startDate,
      startTime,
      endDate,
      endTime,
      color,
      status,
      repeat,
      ...(paths ? { paths, pathState } : {}),
    })),
    whiteboards: boards.map((b) => ({ id: b.id, title: b.title, state: b64(b.state) })),
  };
  await zip.addBytes(MANIFEST, text(JSON.stringify(manifest)), true);
  await zip.addBytes(
    'README.txt',
    text([
      `Exported from "${workspace.name}" on ${new Date().toUTCString()}.`,
      '',
      'To bring this into another account or workspace of this app: Import (in the sidebar) and choose this .zip.',
      'Everything comes across: pages and sub-pages, databases and cards, attachments, handwriting on PDFs,',
      'calendar events and whiteboards.',
      '',
      'For other apps: "readable" has each page as Markdown (.md) and each database as a spreadsheet (.csv),',
      'and "files" has every attachment in its original format.',
      '',
    ].join('\n')),
    true,
  );
  await zip.finish();
}

/** Rewrites every id in a document that's in `map` (pages, files, events, boards made by the import). */
function remapDoc(doc: Y.Doc, map: Map<string, string>) {
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(UUID_G, (m) => map.get(m.toLowerCase()) ?? m);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  doc.transact(() => {
    const walk = (node: Y.XmlElement | Y.XmlFragment) => {
      if (node instanceof Y.XmlElement) {
        for (const [k, v] of Object.entries(node.getAttributes())) {
          const next = fix(v);
          if (changed(v, next)) node.setAttribute(k, next as string);
        }
      }
      for (const c of node.toArray()) {
        if (c instanceof Y.XmlElement) walk(c);
        else if (c instanceof Y.XmlText) {
          // Links in text (e.g. to a file) are formatting attributes.
          let index = 0;
          for (const op of c.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
            const len = typeof op.insert === 'string' ? op.insert.length : 1;
            if (op.attributes) {
              const next = fix(op.attributes) as Record<string, unknown>;
              if (changed(op.attributes, next)) c.format(index, len, next);
            }
            index += len;
          }
        }
      }
    };
    walk(doc.getXmlFragment('document-store'));
    for (const r of [...doc.getArray<Y.Map<unknown>>('rows').toArray(), ...doc.getArray<Y.Map<unknown>>('cardTemplates').toArray()]) {
      const cells = r instanceof Y.Map ? r.get('cells') : null;
      if (!(cells instanceof Y.Map)) continue;
      for (const [k, v] of cells.entries()) {
        const next = fix(v);
        if (changed(v, next)) cells.set(k, next);
      }
    }
    const files = doc.getMap<unknown>('files');
    for (const [k, v] of files.entries()) {
      const next = fix(v);
      if (changed(v, next)) files.set(k, next);
    }
  });
}

/** The most an export .zip may unpack to (its files and pages together), and how many entries it may hold. */
const MAX_UNPACKED = Math.min(2 * config.maxImportBytes, 1024 ** 3);
const MAX_ENTRIES = 50_000;
/** The list of pages, files and events inside (page contents are in it, so it can be large, but not this large). */
const MAX_MANIFEST = 256 * 1024 * 1024;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const many = <T extends z.ZodType>(item: T) => z.array(item).max(MAX_ENTRIES);
/** What an export's manifest must look like before anything in it is used. */
const manifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().max(64),
  source: z.object({ workspace: z.string().max(500), scope: z.enum(['page', 'pages', 'workspace']) }),
  pages: many(
    z.object({
      id: uuid,
      parentId: uuid.nullable(),
      type: z.enum(['document', ...DATABASE_TYPES] as [string, ...string[]]),
      title: z.string().max(2000),
      icon: z.string().max(2000),
      cover: z.string().max(4000).nullable(),
      position: z.number().finite(),
      state: z.string().nullable(),
      rows: many(z.object({ rowId: z.string().min(1).max(64), state: z.string() })),
    }),
  ),
  files: many(
    z.object({
      id: uuid,
      name: z.string().max(1000),
      mimeType: z.string().max(255),
      isNote: z.boolean(),
      path: z.string().max(1000),
      annotations: z.string().nullable(),
    }),
  ),
  events: many(
    z.object({
      id: uuid,
      title: z.string().max(2000),
      description: z.string().max(200_000),
      startDate: z.string().max(32),
      startTime: z.string().max(32).nullable(),
      endDate: z.string().max(32).nullable(),
      endTime: z.string().max(32).nullable(),
      color: z.string().max(32),
      status: z.string().max(32).nullable(),
      repeat: z.unknown(),
      paths: z.unknown().optional(),
      pathState: z.unknown().optional(),
    }),
  ),
  whiteboards: many(z.object({ id: uuid, title: z.string().max(2000), state: z.string().nullable() })),
});

/**
 * Reads an export .zip (a file on disk) into `workspaceId`, under `parentId` (or at the top). It's unpacked
 * to a temporary folder entry by entry, never all in memory, and the folder is removed afterwards.
 * Returns the new top-level pages.
 */
export async function importExport(userId: string, workspaceId: string, zipPath: string, parentId: string | null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atrium-import-'));
  try {
    return await importFrom(userId, workspaceId, zipPath, dir, parentId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Removes uploads and unpack folders a crash or restart left in the temp folder (run at start-up). */
export async function cleanImportLeftovers(): Promise<number> {
  const dir = os.tmpdir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const left = names.filter((n) => /^atrium-(upload-.+\.zip|import-.+|template-.+)$/.test(n));
  await Promise.all(left.map((n) => rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {})));
  return left.length;
}

/** The same, for a .zip already in memory (templates, which are kept in the database). */
export async function importExportBytes(userId: string, workspaceId: string, zipBytes: Uint8Array, parentId: string | null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atrium-template-'));
  try {
    const zipPath = path.join(dir, 'template.zip');
    await writeFile(zipPath, zipBytes);
    return await importExport(userId, workspaceId, zipPath, parentId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function importFrom(userId: string, workspaceId: string, zipPath: string, dir: string, parentId: string | null) {
  const entries = await unzipToDisk(zipPath, dir, { maxBytes: MAX_UNPACKED, maxEntries: MAX_ENTRIES });
  const raw = entries.get(MANIFEST);
  if (!raw) throw new HttpError(400, 'This .zip wasn’t exported from this app');
  if (raw.size > MAX_MANIFEST) throw new HttpError(413, 'This export is too large to import here');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(raw.file, 'utf8'));
  } catch {
    throw new HttpError(400, 'This export is damaged');
  }
  if ((parsed as { format?: unknown })?.format === EXPORT_FORMAT && (parsed as { version?: unknown }).version !== 1) {
    throw new HttpError(400, 'This export is from a newer version of the app');
  }
  const checked = manifestSchema.safeParse(parsed);
  if (!checked.success) throw new HttpError(400, 'This .zip wasn’t exported from this app, or it is damaged');
  const manifest = checked.data as Manifest;

  const map = new Map<string, string>();
  for (const p of manifest.pages) map.set(p.id.toLowerCase(), randomUUID());
  for (const f of manifest.files) map.set(f.id.toLowerCase(), randomUUID());
  for (const e of manifest.events) map.set(e.id.toLowerCase(), randomUUID());
  for (const b of manifest.whiteboards) map.set(b.id.toLowerCase(), randomUUID());
  const id = (old: string) => map.get(old.toLowerCase())!;
  // Paths point at databases and cards by id: those made by the import get their new ids.
  const remapJson = (v: unknown) =>
    v ? JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => map.get(m.toLowerCase()) ?? m) : null;

  // Attachments go to disk first; if anything later fails, they're removed again.
  const written: string[] = [];
  try {
    for (const f of manifest.files) {
      const entry = entries.get(f.path);
      if (!entry) continue;
      await copyFile(entry.file, path.join(config.uploadDir, id(f.id)));
      written.push(id(f.id));
    }

    const top: string[] = [];
    const docs: { pageId: string; rowId: string | null; doc: Y.Doc }[] = [];
    await tx(async (c) => {
      for (const f of manifest.files) {
        if (!written.includes(id(f.id))) continue;
        await c.query('insert into files (id, workspace_id, uploaded_by, filename, mime_type, size, is_note) values ($1, $2, $3, $4, $5, $6, $7)', [
          id(f.id),
          workspaceId,
          userId,
          f.name.slice(0, 255),
          f.mimeType,
          entries.get(f.path)!.size,
          f.isNote,
        ]);
        if (f.annotations) await c.query('insert into file_annotations (file_id, state) values ($1, $2)', [id(f.id), Buffer.from(f.annotations, 'base64')]);
      }
      for (const e of manifest.events) {
        await c.query(
          `insert into events (id, workspace_id, title, description, start_date, start_time, end_date, end_time, color, status, repeat, created_by, paths, path_state)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            id(e.id),
            workspaceId,
            e.title,
            e.description,
            e.startDate,
            e.startTime,
            e.endDate,
            e.endTime,
            e.color,
            e.status,
            e.repeat ? JSON.stringify(e.repeat) : null,
            userId,
            remapJson(e.paths),
            remapJson(e.pathState),
          ],
        );
      }
      for (const b of manifest.whiteboards) {
        const doc = decode(b.state);
        remapDoc(doc, map);
        await c.query('insert into whiteboards (id, workspace_id, title, state, element_count, created_by) values ($1, $2, $3, $4, $5, $6)', [
          id(b.id),
          workspaceId,
          b.title,
          Buffer.from(Y.encodeStateAsUpdate(doc)),
          liveElementCount(doc),
          userId,
        ]);
      }

      // Parents before children.
      const done = new Set<string>();
      const ordered: ExportPage[] = [];
      const visit = (p: ExportPage) => {
        if (done.has(p.id)) return;
        const parent = p.parentId ? manifest.pages.find((x) => x.id === p.parentId) : null;
        if (parent) visit(parent);
        done.add(p.id);
        ordered.push(p);
      };
      manifest.pages.forEach(visit);
      const base = Number((await c.query('select coalesce(max(position), 0) as max from pages where workspace_id = $1 and parent_id is not distinct from $2', [workspaceId, parentId])).rows[0].max);
      for (const [i, p] of ordered.entries()) {
        const isTop = !p.parentId || !map.has(p.parentId.toLowerCase());
        const cover = p.cover ? p.cover.replace(UUID_G, (m) => map.get(m.toLowerCase()) ?? m) : null;
        await c.query(
          `insert into pages (id, workspace_id, parent_id, type, title, icon, cover, position, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [id(p.id), workspaceId, isTop ? parentId : id(p.parentId!), p.type, p.title, p.icon, cover, isTop ? base + 1 + i : p.position, userId],
        );
        if (isTop) top.push(id(p.id));
        const doc = decode(p.state);
        remapDoc(doc, map);
        await c.query('insert into page_content (page_id, state, text_content) values ($1, $2, $3)', [id(p.id), Buffer.from(Y.encodeStateAsUpdate(doc)), extractText(doc)]);
        docs.push({ pageId: id(p.id), rowId: null, doc });
        for (const r of p.rows) {
          const rowDoc = decode(r.state);
          remapDoc(rowDoc, map);
          await c.query('insert into row_documents (page_id, row_id, state, text_content) values ($1, $2, $3, $4)', [id(p.id), r.rowId, Buffer.from(Y.encodeStateAsUpdate(rowDoc)), extractText(rowDoc)]);
          docs.push({ pageId: id(p.id), rowId: r.rowId, doc: rowDoc });
        }
      }
    });
    // Saved: from here the files belong to the imported pages, whatever happens to the search index.
    const fileCount = written.length;
    written.length = 0;
    for (const d of docs) await updateDocIndex(d.pageId, d.rowId, d.doc, { log: false }).catch((err) => console.error('Indexing an imported page failed', err));
    return { pages: manifest.pages.length, files: fileCount, events: manifest.events.length, whiteboards: manifest.whiteboards.length, top };
  } catch (err) {
    for (const f of written) await unlink(path.join(config.uploadDir, f)).catch(() => {});
    throw err;
  }
}
