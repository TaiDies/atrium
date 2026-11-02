import { BlockNoteEditor } from '@blocknote/core';
import { blocksToYXmlFragment } from '@blocknote/core/yjs';
import { unzipSync } from 'fflate';
import * as Y from 'yjs';
import { schema } from '../editor/schema';
import { type FieldType, newId, nextColor, type SelectOption } from '../database/model';
import { api, ApiError, type PageSummary, type PageType, uploadFile } from './api';

const PAGE_EXT = /\.(md|markdown|txt|html?|csv)$/i;
const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};
/** Types for other files that come with an import. */
const FILE_EXT: Record<string, string> = {
  ...IMAGE_EXT,
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  zip: 'application/zip',
};

export interface ImportProgress {
  path: string;
  title: string;
  status: 'pending' | 'working' | 'done' | 'error';
  error?: string;
}

/** Flattens selected files (and the contents of any .zip) into path → bytes. */
export async function collectFiles(files: File[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) {
      const entries = unzipSync(bytes);
      for (const [path, data] of Object.entries(entries)) {
        if (path.endsWith('/') || path.startsWith('__MACOSX/') || /(^|\/)\.[^/]+$/.test(path)) continue;
        out.set(path.replace(/\\/g, '/'), data);
      }
    } else {
      out.set(file.webkitRelativePath || file.name, bytes);
    }
  }
  return out;
}

const decoder = new TextDecoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes).replace(/^﻿/, '');
const extOf = (path: string) => path.split('.').pop()!.toLowerCase();
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** "Roadmap 1a2b3c…" / "Roadmap.md" → "Roadmap" (exports often append ids to names). */
function cleanTitle(name: string) {
  return name
    .replace(PAGE_EXT, '')
    .replace(/[\s_-]+[0-9a-f]{16,}$/i, '')
    .replace(/[\s_-]+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
    .trim();
}

interface PlannedPage {
  key: string; // folder path this page represents, or file path
  path: string | null; // file to read content from, if any
  title: string;
  type: PageType;
  parentKey: string | null;
  migrated?: MigratedPage;
}

// ---------- migration bundles (from the migration tool, and AI-made "workspace-pages" files) ----------

export type { JsonBlock } from './pagesBundle';
import { isLocalRef, isPagesBundle, type JsonBlock, LOCAL_FILE, pagesBundleToMigration, richMarkdownToBlocks } from './pagesBundle';

/**
 * Files named in a "workspace-pages" file (pictures, PDFs, attachments, covers): each is looked up among
 * the imported files — by its path from the .json's folder, then anywhere by file name — and becomes a
 * bundled file that's uploaded with the pages. Ones that aren't there are listed as warnings.
 */
function attachLocalFiles(bundle: MigrationBundle, files: Map<string, Uint8Array>, prefix: string) {
  const byName = new Map<string, string>();
  for (const path of files.keys()) byName.set(baseOf(path).toLowerCase(), path);
  const ids = new Map<string, string>();
  const missing = new Set<string>();
  const resolve = (ref: string): string => {
    let clean = ref.replace(/^<|>$/g, '').replace(/[?#].*$/, '');
    try {
      clean = decodeURIComponent(clean);
    } catch {}
    clean = clean.replace(/\\/g, '/').replace(/^\.\//, '');
    const path = [`${prefix}${clean}`, clean, `${prefix}files/${clean}`].find((p) => files.has(p)) ?? byName.get(baseOf(clean).toLowerCase());
    if (!path) {
      missing.add(clean);
      return '';
    }
    let id = ids.get(path);
    if (!id) {
      id = `import-${ids.size + 1}`;
      ids.set(path, id);
      const name = baseOf(path);
      files.set(`${prefix}files/${id}`, files.get(path)!);
      bundle.files.push({ id, name, type: FILE_EXT[extOf(name)] ?? 'application/octet-stream' });
    }
    return `bundle-file:${id}`;
  };
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') return v.startsWith(LOCAL_FILE) ? resolve(v.slice(LOCAL_FILE.length)) : v;
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // Pictures written as ![alt](photo.png) arrive as image blocks pointing at the file's name.
      if (['image', 'video', 'audio', 'file'].includes(String(o.type)) && o.props && typeof (o.props as { url?: unknown }).url === 'string') {
        const url = (o.props as { url: string }).url;
        if (isLocalRef(url) && !url.startsWith(LOCAL_FILE)) (o.props as { url: string }).url = `${LOCAL_FILE}${url}`;
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) out[k] = fix(x);
      // A picture or attachment whose file wasn't there: say so in the page instead.
      const props = out.props as { url?: string; name?: string } | undefined;
      if (['image', 'video', 'audio', 'file'].includes(String(out.type)) && props && props.url === '') {
        return { type: 'paragraph', content: [{ type: 'text', text: `📎 ${props.name || 'A file'} (not included in the import)`, styles: { italic: true } }] };
      }
      // A file cell keeps its type, so pictures show as pictures.
      if (typeof out.url === 'string' && out.url.startsWith('bundle-file:') && 'name' in out && out.type === '') {
        out.type = bundle.files.find((f) => `bundle-file:${f.id}` === out.url)?.type ?? '';
      }
      return out;
    }
    return v;
  };
  bundle.pages = bundle.pages.map((p) => fix(p) as MigratedPage);
  for (const m of missing) bundle.warnings.push(`The file “${m}” wasn't included — add it to the .zip (or pick it together with the .json) and import again`);
  // Files with no address left are dropped (a block or cell pointing nowhere).
  bundle.pages = JSON.parse(JSON.stringify(bundle.pages), (_k, v) => (Array.isArray(v) ? v.filter((x) => !(x && typeof x === 'object' && x.url === '' && 'name' in x && !('type' in x && x.type === 'paragraph'))) : v));
}

export interface MigratedDatabase {
  fields: { id: string; name: string; type: FieldType; primary?: boolean; options?: SelectOption[]; width?: number }[];
  rows: { id: string; createdAt: number; updatedAt: number; cells: Record<string, unknown> }[];
  views: Record<string, unknown>[];
}

interface MigratedPage {
  key: string;
  parentKey: string | null;
  title: string;
  icon: string;
  type: PageType;
  cover?: string | null;
  blocks?: JsonBlock[];
  database?: MigratedDatabase;
  rowDocs?: Record<string, JsonBlock[]>;
  /** Shown inside its parent as an inline database, so no extra link is added there. */
  embedded?: boolean;
}

interface MigrationBundle {
  format: 'atrium-migration';
  pages: MigratedPage[];
  files: { id: string; name: string; type: string }[];
  skipped: string[];
  warnings: string[];
}

const bundleCache = new WeakMap<Uint8Array, MigrationBundle | null>();

/** A migration bundle, or a "workspace-pages" file (see lib/pagesBundle.ts), among the files. */
function findMigration(files: Map<string, Uint8Array>): { bundle: MigrationBundle; prefix: string } | null {
  for (const [path, bytes] of files) {
    if (!/\.json$/i.test(path)) continue;
    if (!bundleCache.has(bytes)) {
      let found: MigrationBundle | null = null;
      try {
        const json = JSON.parse(text(bytes));
        if (json?.format === 'atrium-migration') found = json as MigrationBundle;
        else if (isPagesBundle(json)) {
          const { pages, warnings } = pagesBundleToMigration(json, (md) => converter().tryParseMarkdownToBlocks(md) as unknown as JsonBlock[]);
          found = { format: 'atrium-migration', pages: pages as MigratedPage[], files: [], skipped: [], warnings };
          attachLocalFiles(found, files, dirOf(path) ? `${dirOf(path)}/` : '');
        }
      } catch {
        found = null;
      }
      bundleCache.set(bytes, found);
    }
    const bundle = bundleCache.get(bytes);
    if (bundle) return { bundle, prefix: dirOf(path) ? `${dirOf(path)}/` : '' };
  }
  return null;
}

/** Notes about what a migration bundle couldn't carry over, for showing before import. */
export function migrationNotes(files: Map<string, Uint8Array>): string[] {
  const m = findMigration(files);
  return m ? [...m.bundle.skipped.map((s) => `Skipped: ${s}`), ...new Set(m.bundle.warnings)] : [];
}

/** Works out which pages to create and how they nest, based on folder structure. */
export function planImport(files: Map<string, Uint8Array>): PlannedPage[] {
  const migration = findMigration(files);
  if (migration) {
    return migration.bundle.pages.map((p) => ({ key: p.key, path: null, title: p.title || 'Untitled', type: p.type, parentKey: p.parentKey, migrated: p }));
  }
  let paths = [...files.keys()].filter((p) => PAGE_EXT.test(p));
  // Ignore a single wrapping folder (e.g. "Export-1234/…") that has no page of its own.
  const roots = new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] : '')));
  let prefix = '';
  if (roots.size === 1 && !roots.has('') && !paths.some((p) => p.replace(PAGE_EXT, '') === [...roots][0])) {
    prefix = `${[...roots][0]}/`;
  }
  paths = paths.map((p) => p.slice(prefix.length));

  const planned = new Map<string, PlannedPage>();
  const ensureFolder = (dir: string): string | null => {
    if (!dir) return null;
    if (planned.has(dir)) return dir;
    const parentKey = ensureFolder(dirOf(dir));
    planned.set(dir, { key: dir, path: null, title: cleanTitle(baseOf(dir)) || 'Untitled', type: 'document', parentKey });
    return dir;
  };

  // A file named like a folder ("Notes.md" next to "Notes/") becomes that folder's page.
  for (const p of paths.sort((a, b) => a.split('/').length - b.split('/').length)) {
    const key = p.replace(PAGE_EXT, '');
    const type: PageType = extOf(p) === 'csv' ? 'grid' : 'document';
    const parentKey = ensureFolder(dirOf(p));
    const existing = planned.get(key);
    if (existing && !existing.path) {
      existing.path = prefix + p;
      existing.type = type;
      continue;
    }
    planned.set(planned.has(key) ? p : key, { key: planned.has(key) ? p : key, path: prefix + p, title: cleanTitle(baseOf(p)) || 'Untitled', type, parentKey });
  }
  return [...planned.values()].sort((a, b) => a.key.split('/').length - b.key.split('/').length);
}

let headless: BlockNoteEditor<any, any, any> | null = null;
function converter() {
  headless ??= BlockNoteEditor.create({ schema });
  return headless;
}

function resolvePath(fromFile: string, ref: string): string {
  const parts = (dirOf(fromFile) ? dirOf(fromFile).split('/') : []).concat(ref.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Upload images bundled next to a document and point the document at them. */
async function rewriteImages(source: string, filePath: string, files: Map<string, Uint8Array>, workspaceId: string, html: boolean) {
  const pattern = html ? /(<img[^>]*?\ssrc=["'])([^"']+)(["'])/gi : /(!\[[^\]]*\]\()(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?\))/g;
  const refs = new Set<string>();
  source.replace(pattern, (_m, _a, ref) => {
    refs.add(ref);
    return '';
  });
  const urls = new Map<string, string>();
  for (const raw of refs) {
    const ref = raw.replace(/^<|>$/g, '');
    if (/^(https?:|data:|\/api\/)/i.test(ref)) continue;
    let decoded = ref;
    try {
      decoded = decodeURIComponent(ref);
    } catch {}
    const key = resolvePath(filePath, decoded);
    const bytes = files.get(key) ?? [...files.entries()].find(([p]) => p.endsWith(`/${key}`) || p === key)?.[1];
    if (!bytes) continue;
    const name = baseOf(key);
    const file = new File([bytes as BlobPart], name, { type: IMAGE_EXT[extOf(name)] ?? 'application/octet-stream' });
    urls.set(raw, await uploadFile(workspaceId, file));
  }
  return source.replace(pattern, (m, a, ref, b) => (urls.has(ref) ? `${a}${urls.get(ref)}${b}` : m));
}

/** In a Markdown page: file blocks naming a file next to it get that file uploaded (or a note if it's missing). */
async function uploadNamedFiles(blocks: JsonBlock[], filePath: string, files: Map<string, Uint8Array>, workspaceId: string): Promise<JsonBlock[]> {
  const out: JsonBlock[] = [];
  for (const b of blocks) {
    const url = typeof b.props?.url === 'string' ? (b.props.url as string) : '';
    if (['image', 'video', 'audio', 'file'].includes(b.type) && url.startsWith(LOCAL_FILE)) {
      let ref = url.slice(LOCAL_FILE.length);
      try {
        ref = decodeURIComponent(ref);
      } catch {}
      const key = resolvePath(filePath, ref);
      const found = files.has(key) ? key : [...files.keys()].find((p) => baseOf(p).toLowerCase() === baseOf(ref).toLowerCase());
      if (found) {
        const name = baseOf(found);
        const uploaded = await uploadFile(workspaceId, new File([files.get(found)! as BlobPart], name, { type: FILE_EXT[extOf(name)] ?? 'application/octet-stream' })).catch(() => '');
        if (uploaded) {
          out.push({ ...b, props: { ...b.props, url: uploaded } });
          continue;
        }
      }
      out.push({ type: 'paragraph', content: [{ type: 'text', text: `📎 ${String(b.props?.name || baseOf(ref))} (not included in the import)`, styles: { italic: true } }] });
      continue;
    }
    out.push(b.children?.length ? { ...b, children: await uploadNamedFiles(b.children, filePath, files, workspaceId) } : b);
  }
  return out;
}

/** Converts Markdown/HTML into the editor's Yjs format. Returns the update and a title found in the content. */
async function documentUpdate(path: string, files: Map<string, Uint8Array>, workspaceId: string) {
  const html = /\.html?$/i.test(path);
  let source = text(files.get(path)!);
  let title: string | null = null;
  if (html) {
    title = /<title>([^<]*)<\/title>/i.exec(source)?.[1]?.trim() || null;
    source = /<body[^>]*>([\s\S]*)<\/body>/i.exec(source)?.[1] ?? source;
  } else {
    const first = /^\s*#\s+(.+?)\s*#*\s*(\r?\n|$)/.exec(source);
    if (first) {
      title = first[1].trim();
      source = source.slice(first[0].length);
    }
  }
  source = await rewriteImages(source, path, files, workspaceId, html);
  const editor = converter();
  let blocks = html ? editor.tryParseHTMLToBlocks(source) : richMarkdownToBlocks(source, (md) => editor.tryParseMarkdownToBlocks(md) as unknown as JsonBlock[]);
  // Files named in the page ([file](report.pdf), [video](…)…) that came with it: uploaded and linked.
  if (!html) blocks = (await uploadNamedFiles(blocks as JsonBlock[], path, files, workspaceId)) as typeof blocks;
  const doc = new Y.Doc();
  if (blocks.length) blocksToYXmlFragment(editor, blocks as any, doc.getXmlFragment('document-store'));
  return { update: Y.encodeStateAsUpdate(doc), title };
}

// ---------- CSV → Grid ----------

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const delimiter = (input.split('\n')[0].match(/;/g)?.length ?? 0) > (input.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const TRUE = new Set(['true', 'yes', 'y', 'checked', '✓', '✔', 'x', '[x]']);
const FALSE = new Set(['false', 'no', 'n', 'unchecked', '', '[ ]']);

function toISODate(v: string): string | null {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (!/\d/.test(s) || s.length > 40 || /^\d+(\.\d+)?$/.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inferType(header: string, values: string[]): FieldType {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (filled.length === 0) return 'text';
  if (filled.every((v) => /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, '')))) return 'number';
  if (filled.every((v) => TRUE.has(v.toLowerCase()) || FALSE.has(v.toLowerCase()))) return 'checkbox';
  if (filled.every((v) => /^https?:\/\//i.test(v))) return 'url';
  if (filled.every((v) => toISODate(v) !== null)) return 'date';
  const tagLike = /tag|label|categor/i.test(header) || filled.some((v) => v.includes(',') && v.length < 80);
  const parts = tagLike ? filled.flatMap((v) => v.split(',').map((s) => s.trim())) : filled;
  const distinct = new Set(parts);
  const statusLike = /status|stage|type|priority|state/i.test(header);
  if (distinct.size <= 25 && (statusLike || distinct.size < parts.length) && parts.every((v) => v.length <= 60)) {
    return tagLike && filled.some((v) => v.includes(',')) ? 'multi_select' : 'select';
  }
  return 'text';
}

function ymap(entries: Record<string, unknown>) {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

function gridUpdate(csv: string) {
  const table = parseCsv(csv);
  const [headers = ['Name'], ...body] = table;
  const doc = new Y.Doc();
  const fields = doc.getArray<Y.Map<unknown>>('fields');
  const rows = doc.getArray<Y.Map<unknown>>('rows');
  const columns = headers.map((h, i) => {
    const values = body.map((r) => r[i] ?? '');
    const type: FieldType = i === 0 ? 'text' : inferType(h, values);
    const options: SelectOption[] = [];
    if (type === 'select' || type === 'multi_select') {
      const names = new Set(values.flatMap((v) => (type === 'multi_select' ? v.split(',') : [v])).map((s) => s.trim()).filter(Boolean));
      [...names].forEach((name, n) => options.push({ id: newId(), name, color: nextColor(n) }));
    }
    return { id: newId(), name: h.trim() || `Column ${i + 1}`, type, options };
  });

  doc.transact(() => {
    columns.forEach((c, i) =>
      fields.push([
        ymap({ id: c.id, name: c.name, type: c.type, width: i === 0 ? 240 : 180, ...(i === 0 ? { primary: true } : {}), ...(c.options.length || c.type.includes('select') ? { options: c.options } : {}) }),
      ]),
    );
    const now = Date.now();
    for (const r of body) {
      const cells = new Y.Map<unknown>();
      columns.forEach((c, i) => {
        const raw = (r[i] ?? '').trim();
        if (!raw) return;
        let value: unknown = raw;
        if (c.type === 'number') value = Number(raw.replace(/,/g, ''));
        else if (c.type === 'checkbox') value = TRUE.has(raw.toLowerCase());
        else if (c.type === 'date') value = toISODate(raw);
        else if (c.type === 'select') value = c.options.find((o) => o.name === raw)?.id ?? null;
        else if (c.type === 'multi_select') value = raw.split(',').map((s) => c.options.find((o) => o.name === s.trim())?.id).filter(Boolean);
        cells.set(c.id, value);
      });
      rows.push([ymap({ id: newId(), createdAt: now, updatedAt: now, cells })]);
    }
    doc.getArray<Y.Map<unknown>>('views').push([
      ymap({ id: newId(), name: 'Grid', type: 'grid', groupBy: null, dateField: null, sorts: [], filters: [], hidden: [] }),
    ]);
  });
  return Y.encodeStateAsUpdate(doc);
}

async function putContent(pageId: string, update: Uint8Array, rowId?: string) {
  const res = await fetch(rowId ? `/api/pages/${pageId}/rows/${rowId}/content` : `/api/pages/${pageId}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: update as BlobPart,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? 'Could not save the imported content');
  }
}

function blocksUpdate(blocks: JsonBlock[]) {
  const doc = new Y.Doc();
  if (blocks.length) blocksToYXmlFragment(converter(), blocks as any, doc.getXmlFragment('document-store'));
  return Y.encodeStateAsUpdate(doc);
}

function databaseUpdate(db: MigratedDatabase) {
  const doc = new Y.Doc();
  doc.transact(() => {
    const fields = doc.getArray<Y.Map<unknown>>('fields');
    for (const f of db.fields) fields.push([ymap({ ...f })]);
    const rows = doc.getArray<Y.Map<unknown>>('rows');
    for (const r of db.rows) {
      const cells = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(r.cells)) cells.set(k, v);
      rows.push([ymap({ id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt, cells })]);
    }
    const views = doc.getArray<Y.Map<unknown>>('views');
    for (const v of db.views) views.push([ymap({ ...v })]);
  });
  return Y.encodeStateAsUpdate(doc);
}

/** Re-points page mentions and bundled-file URLs at the newly created pages and uploads. */
function remap<T>(value: T, pageIds: Map<string, string>, fileUrls: Map<string, string>): T {
  return JSON.parse(JSON.stringify(value), (_k, v) => {
    if (typeof v === 'string' && v.startsWith('bundle-file:')) return fileUrls.get(v) ?? '';
    if (v && typeof v === 'object' && v.type === 'pageMention' && typeof v.props?.pageId === 'string' && v.props.pageId.startsWith('old:')) {
      const id = pageIds.get(v.props.pageId.slice(4));
      return id ? { ...v, props: { pageId: id } } : { type: 'text', text: 'a page that was not imported', styles: { italic: true } };
    }
    // Embedded databases, sub-page links and relations pointing at a page in the same file.
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.pageId === 'string' && v.pageId.startsWith('old:')) {
      return { ...v, pageId: pageIds.get(v.pageId.slice(4)) ?? '' };
    }
    return v;
  });
}

async function runMigration(
  workspaceId: string,
  parentId: string | null,
  files: Map<string, Uint8Array>,
  plan: PlannedPage[],
  onProgress: (key: string, p: Partial<ImportProgress>) => void,
): Promise<string | null> {
  const { bundle, prefix } = findMigration(files)!;

  const fileUrls = new Map<string, string>();
  for (const f of bundle.files) {
    const bytes = files.get(`${prefix}files/${f.id}`);
    if (!bytes) continue;
    try {
      fileUrls.set(`bundle-file:${f.id}`, await uploadFile(workspaceId, new File([bytes as BlobPart], f.name, { type: f.type })));
    } catch {}
  }

  // Pass 1: create every page so links between pages can be resolved.
  const pageIds = new Map<string, string>();
  for (const item of plan) {
    const p = item.migrated!;
    onProgress(item.key, { status: 'working' });
    try {
      const parent = p.parentKey ? pageIds.get(p.parentKey) ?? parentId : parentId;
      const { page } = await api<{ page: PageSummary }>(`/api/workspaces/${workspaceId}/pages`, {
        method: 'POST',
        body: { parentId: parent, type: p.type, title: p.title, icon: p.icon || undefined, empty: true },
      });
      pageIds.set(p.key, page.id);
      const cover = p.cover?.startsWith('bundle-file:') ? fileUrls.get(p.cover) : p.cover;
      if (cover) await api(`/api/pages/${page.id}`, { method: 'PATCH', body: { cover } });
    } catch (err) {
      onProgress(item.key, { status: 'error', error: err instanceof Error ? err.message : 'Failed' });
    }
  }

  // Pass 2: write content, with sub-pages linked from inside their parent document.
  for (const item of plan) {
    const p = item.migrated!;
    const id = pageIds.get(p.key);
    if (!id) continue;
    try {
      if (p.type === 'document') {
        const children = plan
          .filter((c) => c.parentKey === p.key && pageIds.has(c.key) && !c.migrated?.embedded)
          .map((c) => ({ type: 'subpage', props: { pageId: pageIds.get(c.key)! } }));
        await putContent(id, blocksUpdate([...remap(p.blocks ?? [], pageIds, fileUrls), ...children]));
      } else if (p.database) {
        await putContent(id, databaseUpdate(remap(p.database, pageIds, fileUrls)));
        for (const [rowId, blocks] of Object.entries(p.rowDocs ?? {})) {
          await putContent(id, blocksUpdate(remap(blocks, pageIds, fileUrls)), rowId);
        }
      }
      onProgress(item.key, { status: 'done' });
    } catch (err) {
      onProgress(item.key, { status: 'error', error: err instanceof Error ? err.message : 'Failed' });
    }
  }
  return pageIds.get(plan[0]?.key ?? '') ?? null;
}

/** Creates every planned page in order, reporting progress as it goes. Returns the first page created. */
export async function runImport(
  workspaceId: string,
  parentId: string | null,
  files: Map<string, Uint8Array>,
  plan: PlannedPage[],
  onProgress: (key: string, p: Partial<ImportProgress>) => void,
): Promise<string | null> {
  if (plan.some((p) => p.migrated)) return runMigration(workspaceId, parentId, files, plan, onProgress);
  const created = new Map<string, string>();
  let first: string | null = null;
  for (const item of plan) {
    onProgress(item.key, { status: 'working' });
    try {
      const parent = item.parentKey ? created.get(item.parentKey) ?? parentId : parentId;
      let title = item.title;
      let update: Uint8Array | null = null;
      if (item.path && item.type === 'grid') update = gridUpdate(text(files.get(item.path)!));
      else if (item.path) {
        const doc = await documentUpdate(item.path, files, workspaceId);
        update = doc.update;
        if (doc.title && (!title || title === 'Untitled' || title.toLowerCase() === 'index')) title = doc.title;
      }
      const { page } = await api<{ page: PageSummary }>(`/api/workspaces/${workspaceId}/pages`, {
        method: 'POST',
        body: { parentId: parent, type: item.type, title, empty: true, insertIntoParent: !!parent },
      });
      if (update && update.length > 2) await putContent(page.id, update);
      created.set(item.key, page.id);
      first ??= page.id;
      onProgress(item.key, { status: 'done', title });
    } catch (err) {
      onProgress(item.key, { status: 'error', error: err instanceof Error ? err.message : 'Failed' });
    }
  }
  return first;
}

// ---------- for the AI assistant ----------

/** Editor blocks from Markdown. */
export function markdownToBlocks(markdown: string): JsonBlock[] {
  return converter().tryParseMarkdownToBlocks(markdown) as unknown as JsonBlock[];
}

/** Fills a page (or a card's page, with `rowId`) with blocks. */
export async function writeBlocks(pageId: string, blocks: JsonBlock[], rowId?: string) {
  await putContent(pageId, blocksUpdate(blocks), rowId);
}

/** Adds blocks to the end of an existing document, keeping what's there. */
export async function appendBlocks(pageId: string, blocks: JsonBlock[]) {
  const res = await fetch(`/api/pages/${pageId}/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blocksUpdate(blocks) as BlobPart,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? 'Could not add to the page');
  }
}

/** Fills a new (empty) database page with its properties, rows and views. */
export async function writeDatabase(pageId: string, db: MigratedDatabase) {
  await putContent(pageId, databaseUpdate(db));
}
