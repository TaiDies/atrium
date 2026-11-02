import type { FieldType, SelectOption } from '../database/model';
import { newId, nextColor } from '../database/model';
import type { PageType } from './api';

// "workspace-pages" files: a simple JSON format other tools (and AI chat bots) can write to make pages,
// databases and cards in one import. Page content is Markdown with a few extras (dates, callouts,
// toggles, columns, equations, embeds, links between pages), or editor blocks. It's turned into the
// app's migration bundle and imported the same way. The full description is in
// docs/AI-PAGE-INSTRUCTIONS.md.

export type JsonBlock = { type: string; props?: Record<string, unknown>; content?: unknown; children?: JsonBlock[] };

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; props?: Record<string, unknown>; content?: unknown; href?: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const localDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A reference to another page in the same file, fixed up once the pages exist. */
export const pageRef = (key: string) => `old:${key}`;

/**
 * A file that came with the import (in the same .zip, or picked together with the .json), by its path;
 * the importer finds it, uploads it and swaps in its address (see importer.ts `attachLocalFiles`).
 */
export const LOCAL_FILE = 'local-file:';
/** Web addresses and app addresses are used as they are; anything else names a file in the import. */
export const isLocalRef = (ref: string) => !!ref && !/^(https?:|data:|blob:|\/api\/|bundle-file:|old:)/i.test(ref);
const localRef = (ref: string) => (isLocalRef(ref) ? `${LOCAL_FILE}${ref.replace(/^<|>$/g, '')}` : ref);
const MEDIA_LINE = /^\[(file|pdf|image|picture|photo|video|audio|sound)(?:\s*:\s*([^\]]*))?\]\((<[^>]+>|\S+?)\)$/i;
const baseName = (ref: string) => {
  const last = (ref.replace(/^<|>$/g, '').split(/[\\/]/).pop() || ref).replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

// ---------- Markdown with extras ----------

const INLINE_RE = /(\[\[[^\]\n]+\]\]|@today|@tomorrow|@yesterday|@\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?|\$[^$\s](?:[^$\n]*?[^$\s])?\$)/g;

/** Dates, page links and inline maths inside text. */
function enrichInline(items: Inline[], knownKeys: Set<string>): Inline[] {
  const out: Inline[] = [];
  for (const item of items) {
    if (item.type !== 'text' || !item.text || !INLINE_RE.test(item.text)) {
      INLINE_RE.lastIndex = 0;
      out.push(item);
      continue;
    }
    INLINE_RE.lastIndex = 0;
    for (const part of item.text.split(INLINE_RE)) {
      if (!part) continue;
      if (part.startsWith('[[') && part.endsWith(']]')) {
        const key = part.slice(2, -2).replace(/^page:/, '').trim();
        if (knownKeys.has(key)) out.push({ type: 'pageMention', props: { pageId: pageRef(key) } });
        else out.push({ ...item, text: part });
      } else if (part.startsWith('@')) {
        const [raw, time = ''] = part.slice(1).split(' ');
        const date = raw === 'today' ? localDay(0) : raw === 'tomorrow' ? localDay(1) : raw === 'yesterday' ? localDay(-1) : raw;
        if (DATE_RE.test(date)) out.push({ type: 'dateMention', props: { date, time: /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '', remind: '', by: '' } });
        else out.push({ ...item, text: part });
      } else if (part.startsWith('$') && part.endsWith('$') && part.length > 2) {
        out.push({ type: 'inlineMath', props: { latex: part.slice(1, -1) } });
      } else out.push({ ...item, text: part });
    }
  }
  return out;
}

function enrichBlocks(blocks: JsonBlock[], knownKeys: Set<string>): JsonBlock[] {
  return blocks.map((b) => ({
    ...b,
    content: Array.isArray(b.content) ? enrichInline(b.content as Inline[], knownKeys) : b.content,
    children: b.children?.length ? enrichBlocks(b.children, knownKeys) : b.children,
  }));
}

const ALERTS: Record<string, { emoji: string; color: string }> = {
  NOTE: { emoji: 'ℹ️', color: 'blue' },
  TIP: { emoji: '💡', color: 'green' },
  IMPORTANT: { emoji: '❗', color: 'purple' },
  WARNING: { emoji: '⚠️', color: 'yellow' },
  CAUTION: { emoji: '🛑', color: 'red' },
};
const CALLOUT_COLORS = new Set(['gray', 'blue', 'green', 'yellow', 'red', 'purple']);

type Parse = (markdown: string) => JsonBlock[];

/**
 * Markdown → editor blocks, with the extras described in AI-PAGE-INSTRUCTIONS.md. `parse` is the
 * editor's own Markdown reader; `knownKeys` are the pages that [[links]] can point at.
 */
export function richMarkdownToBlocks(markdown: string, parse: Parse, knownKeys: Set<string> = new Set()): JsonBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: JsonBlock[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join('\n');
    buffer = [];
    if (text.trim()) out.push(...enrichBlocks(parse(text), knownKeys));
  };
  const inlineOf = (text: string): Inline[] => {
    const first = parse(text)[0];
    return Array.isArray(first?.content) ? enrichInline(first.content as Inline[], knownKeys) : [{ type: 'text', text, styles: {} }];
  };
  /** Lines up to the ":::" that closes a block started at line i (nested ":::" blocks are skipped over). */
  const container = (i: number): { body: string[]; end: number } => {
    const body: string[] = [];
    let depth = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j].trim();
      if (/^:::\s*\S/.test(l) && !/^:::\s*column\s*$/i.test(l)) depth++;
      else if (l === ':::') {
        if (depth === 0) break;
        depth--;
      }
      body.push(lines[j]);
    }
    return { body, end: j };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    let m: RegExpExecArray | null;

    if (/^\[toc\]$/i.test(t)) {
      flush();
      out.push({ type: 'toc' });
    } else if (/^\[breadcrumbs\]$/i.test(t)) {
      flush();
      out.push({ type: 'breadcrumbs' });
    } else if ((m = MEDIA_LINE.exec(t))) {
      // A file shown in the page: [file](report.pdf), [file: Shown name](…), [image](…), [video](…), [audio](…).
      flush();
      const kind = m[1].toLowerCase();
      const type = /^(image|picture|photo)$/.test(kind) ? 'image' : kind === 'video' ? 'video' : /^(audio|sound)$/.test(kind) ? 'audio' : 'file';
      const ref = m[3].replace(/^<|>$/g, '');
      out.push({ type, props: { url: localRef(ref), name: m[2]?.trim() || baseName(ref), caption: type === 'file' ? '' : (m[2]?.trim() ?? '') } });
    } else if ((m = /^\[(embed|bookmark)\]\((\S+?)\)$/i.exec(t))) {
      flush();
      out.push(m[1].toLowerCase() === 'embed' ? { type: 'embed', props: { url: m[2] } } : { type: 'bookmark', props: { url: m[2], title: m[2] } });
    } else if ((m = /^\[\[database:([^\]]+)\]\]$/i.exec(t)) && knownKeys.has(m[1].trim())) {
      flush();
      out.push({ type: 'database', props: { pageId: pageRef(m[1].trim()), viewId: '', linked: false } });
    } else if ((m = /^\$\$(.+)\$\$$/.exec(t))) {
      flush();
      out.push({ type: 'math', props: { latex: m[1].trim() } });
    } else if (t === '$$') {
      flush();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && lines[j].trim() !== '$$'; j++) body.push(lines[j]);
      out.push({ type: 'math', props: { latex: body.join('\n').trim() } });
      i = j;
    } else if ((m = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(t))) {
      // GitHub-style alert: > [!TIP] … (following "> " lines belong to it)
      flush();
      const body = [m[2]];
      let j = i + 1;
      for (; j < lines.length && /^\s*>/.test(lines[j]); j++) body.push(lines[j].replace(/^\s*>\s?/, ''));
      i = j - 1;
      const style = ALERTS[m[1].toUpperCase()];
      const [first, ...rest] = body.join('\n').trim().split('\n');
      out.push({ type: 'callout', props: { emoji: style.emoji, color: style.color }, content: inlineOf(first || ' '), children: rest.join('\n').trim() ? richMarkdownToBlocks(rest.join('\n'), parse, knownKeys) : [] });
    } else if ((m = /^:::\s*callout\b\s*(\S+)?\s*(\w+)?\s*$/i.exec(t))) {
      flush();
      const { body, end } = container(i);
      i = end;
      const emoji = m[1] && !CALLOUT_COLORS.has(m[1]) ? m[1] : '💡';
      const color = [m[1], m[2]].find((c) => c && CALLOUT_COLORS.has(c)) ?? 'gray';
      const [first, ...rest] = body.join('\n').trim().split('\n');
      out.push({ type: 'callout', props: { emoji, color }, content: inlineOf(first || ' '), children: rest.join('\n').trim() ? richMarkdownToBlocks(rest.join('\n'), parse, knownKeys) : [] });
    } else if ((m = /^:::\s*toggle\s+(.+)$/i.exec(t))) {
      flush();
      const { body, end } = container(i);
      i = end;
      out.push({ type: 'toggleListItem', content: inlineOf(m[1]), children: richMarkdownToBlocks(body.join('\n'), parse, knownKeys) });
    } else if ((m = /^:::\s*button\s+(.+)$/i.exec(t))) {
      flush();
      const { body, end } = container(i);
      i = end;
      out.push({ type: 'button', props: { label: m[1].trim(), action: 'insert', markdown: body.join('\n').trim(), url: '' } });
    } else if (/^:::\s*columns\s*$/i.test(t)) {
      flush();
      const { body, end } = container(i);
      i = end;
      const columns: string[][] = [[]];
      let depth = 0;
      for (const l of body) {
        const lt = l.trim();
        if (depth === 0 && /^:::\s*column\s*$/i.test(lt)) {
          if (columns[columns.length - 1].some((x) => x.trim())) columns.push([]);
          continue;
        }
        if (/^:::\s*\S/.test(lt)) depth++;
        else if (lt === ':::') depth--;
        columns[columns.length - 1].push(l);
      }
      const cols = columns.filter((c) => c.some((x) => x.trim())).slice(0, 4);
      if (cols.length)
        out.push({
          type: 'columnList',
          children: cols.map((c) => {
            const blocks = richMarkdownToBlocks(c.join('\n'), parse, knownKeys);
            return { type: 'column', children: blocks.length ? blocks : [{ type: 'paragraph' }] };
          }),
        });
    } else if (/^<details>/i.test(t)) {
      flush();
      const body: string[] = [];
      let title = 'Details';
      let j = i;
      let rest = t.replace(/^<details>/i, '');
      for (; j < lines.length; j++) {
        const l = j === i ? rest : lines[j];
        const s = /<summary>(.*?)<\/summary>/i.exec(l);
        if (s) {
          title = s[1].trim();
          rest = l.replace(s[0], '');
          if (rest.trim() && !/<\/details>/i.test(rest)) body.push(rest);
        } else if (/<\/details>/i.test(l)) {
          const before = l.replace(/<\/details>.*/i, '');
          if (before.trim()) body.push(before);
          break;
        } else if (j !== i) body.push(l);
      }
      i = j;
      out.push({ type: 'toggleListItem', content: inlineOf(title), children: richMarkdownToBlocks(body.join('\n'), parse, knownKeys) });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

// ---------- the "workspace-pages" format ----------

export interface PagesBundle {
  format: 'workspace-pages';
  version?: number;
  pages: BundlePage[];
}

interface BundleProperty {
  name: string;
  type?: string;
  options?: (string | { name: string; color?: string; group?: string })[];
  formula?: string;
  prefix?: string;
  /** Relation: the key of the database page it links to. */
  to?: string;
}

interface BundleView {
  type?: string;
  name?: string;
  groupBy?: string;
  swimlanesBy?: string;
  date?: string;
  endDate?: string;
  cover?: string;
  sort?: { property: string; direction?: 'asc' | 'desc' }[];
  filter?: { property: string; op?: string; value?: unknown }[];
  hide?: string[];
  chart?: { kind?: string; metric?: string; value?: string };
}

interface BundlePage {
  key?: string;
  parent?: string | null;
  title?: string;
  icon?: string;
  cover?: string;
  type?: string;
  markdown?: string;
  blocks?: JsonBlock[];
  properties?: BundleProperty[];
  titleProperty?: string;
  cards?: Record<string, unknown>[];
  views?: BundleView[];
}

export interface MigratedField {
  id: string;
  name: string;
  type: FieldType;
  primary?: boolean;
  options?: SelectOption[];
  width?: number;
  [key: string]: unknown;
}

export interface Migrated {
  key: string;
  parentKey: string | null;
  title: string;
  icon: string;
  type: PageType;
  cover?: string | null;
  blocks?: JsonBlock[];
  database?: { fields: MigratedField[]; rows: { id: string; createdAt: number; updatedAt: number; cells: Record<string, unknown> }[]; views: Record<string, unknown>[] };
  rowDocs?: Record<string, JsonBlock[]>;
  /** Shown inside its parent as an inline database (so no separate link is added). */
  embedded?: boolean;
}

const COVER_PRESETS = new Set(['sunset', 'ocean', 'aurora', 'forest', 'peach', 'lavender', 'night', 'citrus', 'mint', 'slate']);
const PAGE_TYPES = new Set(['document', 'grid', 'board', 'calendar', 'timeline', 'list', 'gallery', 'chart', 'feed']);
const VIEW_TYPES = new Set(['grid', 'board', 'calendar', 'timeline', 'list', 'gallery', 'chart', 'feed']);
const FIELD_ALIASES: Record<string, FieldType> = {
  text: 'text',
  title: 'text',
  number: 'number',
  select: 'select',
  single_select: 'select',
  status: 'select',
  multi_select: 'multi_select',
  multiselect: 'multi_select',
  tags: 'multi_select',
  date: 'date',
  checkbox: 'checkbox',
  url: 'url',
  link: 'url',
  email: 'email',
  phone: 'phone',
  checklist: 'checklist',
  created_time: 'created_time',
  last_edited: 'last_edited',
  formula: 'formula',
  id: 'unique_id',
  unique_id: 'unique_id',
  relation: 'relation',
  files: 'media',
  file: 'media',
  media: 'media',
  attachments: 'media',
  images: 'media',
};
const DONE = /\b(done|complete|completed|finished|closed|resolved|shipped|published)\b/i;
const DOING = /\b(doing|progress|started|working|review|active|building|writing)\b/i;

const truthy = (v: unknown) => v === true || /^(true|yes|y|x|done|1|✓|✔)$/i.test(String(v).trim());
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()) : String(v ?? '').split(',').map((x) => x.trim())).filter(Boolean);
function toDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === 'today') return localDay(0);
  if (s === 'tomorrow') return localDay(1);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isPagesBundle(v: unknown): v is PagesBundle {
  return !!v && typeof v === 'object' && (v as PagesBundle).format === 'workspace-pages' && Array.isArray((v as PagesBundle).pages);
}

/** Turns a "workspace-pages" file into the app's migration bundle. `warnings` lists what was left out. */
export function pagesBundleToMigration(bundle: PagesBundle, parse: Parse): { pages: Migrated[]; warnings: string[] } {
  const warnings: string[] = [];
  const pages = bundle.pages.map((p, i) => ({ ...p, key: String(p.key ?? p.title ?? `page-${i + 1}`) }));
  const keys = new Set(pages.map((p) => p.key));
  const embeddedKeys = new Set<string>();
  for (const p of pages) for (const m of (p.markdown ?? '').matchAll(/^\s*\[\[database:([^\]]+)\]\]\s*$/gim)) embeddedKeys.add(m[1].trim());

  // Cards' titles in each database, for relations between databases.
  const rowIdsByDb = new Map<string, Map<string, string>>();
  const out: Migrated[] = [];

  for (const p of pages) {
    const type = (PAGE_TYPES.has(String(p.type)) ? p.type : p.properties || p.cards ? 'grid' : 'document') as PageType;
    const parentKey = p.parent && keys.has(p.parent) ? p.parent : null;
    if (p.parent && !parentKey) warnings.push(`“${p.title ?? p.key}”: its parent “${p.parent}” isn't in the file, so it was put at the top`);
    // A cover is a preset name, a web address, or a picture that came with the import.
    const cover = p.cover && !COVER_PRESETS.has(p.cover) ? localRef(p.cover) : (p.cover ?? null);
    const page: Migrated = { key: p.key, parentKey, title: p.title ?? p.key, icon: p.icon ?? '', type, cover, embedded: embeddedKeys.has(p.key) && !!parentKey };
    if (type === 'document') {
      page.blocks = Array.isArray(p.blocks) ? p.blocks : richMarkdownToBlocks(p.markdown ?? '', parse, keys);
    } else {
      const titleName = p.titleProperty ?? 'Name';
      const fields: MigratedField[] = [{ id: newId(), name: titleName, type: 'text', primary: true, width: 240 }];
      for (const prop of p.properties ?? []) {
        if (!prop?.name || prop.name === titleName) continue;
        const raw = String(prop.type ?? 'text').toLowerCase().replace(/[\s-]/g, '_');
        const t = FIELD_ALIASES[raw];
        if (!t) {
          warnings.push(`“${p.title ?? p.key}” → “${prop.name}”: the type “${prop.type}” isn't supported here, so it's text`);
        }
        const field: MigratedField = { id: newId(), name: prop.name, type: t ?? 'text', width: t === 'date' ? 160 : 180 };
        if (t === 'select' || t === 'multi_select') {
          const status = raw === 'status';
          field.options = (prop.options ?? []).map((o, n) => {
            const name = typeof o === 'string' ? o : o.name;
            const color = typeof o === 'object' && o.color ? o.color : status ? (DONE.test(name) ? 'green' : DOING.test(name) ? 'blue' : 'gray') : nextColor(n);
            const group = typeof o === 'object' && o.group ? o.group : DONE.test(name) ? 'done' : DOING.test(name) ? 'doing' : 'todo';
            return { id: newId(), name, color, ...(status ? { group } : {}) } as SelectOption;
          });
          if (status) {
            field.status = true;
            if (!field.options.length)
              field.options = [
                { id: newId(), name: 'Not started', color: 'gray', group: 'todo' },
                { id: newId(), name: 'In progress', color: 'blue', group: 'doing' },
                { id: newId(), name: 'Done', color: 'green', group: 'done' },
              ] as SelectOption[];
          }
        }
        if (t === 'formula') field.formula = prop.formula ?? '';
        if (t === 'unique_id' && prop.prefix) field.prefix = prop.prefix;
        if (t === 'relation') {
          if (prop.to && keys.has(prop.to)) field.relation = { pageId: pageRef(prop.to), pairedFieldId: null };
          else {
            field.type = 'text';
            warnings.push(`“${p.title ?? p.key}” → “${prop.name}”: a relation needs "to" set to another database's key`);
          }
        }
        fields.push(field);
      }
      // Each layout needs something to work with.
      const selects = fields.filter((f) => f.type === 'select');
      const dates = fields.filter((f) => f.type === 'date');
      if (type === 'board' && !selects.length) {
        const status: MigratedField = { id: newId(), name: 'Status', type: 'select', status: true, width: 160, options: [
          { id: newId(), name: 'Not started', color: 'gray', group: 'todo' },
          { id: newId(), name: 'In progress', color: 'blue', group: 'doing' },
          { id: newId(), name: 'Done', color: 'green', group: 'done' },
        ] as SelectOption[] };
        fields.push(status);
        selects.push(status);
      }
      if ((type === 'calendar' || type === 'timeline') && !dates.length) {
        const d: MigratedField = { id: newId(), name: 'Date', type: 'date', width: 160 };
        fields.push(d);
        dates.push(d);
      }
      if (type === 'timeline' && dates.length < 2) {
        const d: MigratedField = { id: newId(), name: 'End', type: 'date', width: 160 };
        fields.push(d);
        dates.push(d);
      }
      const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));
      const fieldOf = (name: string | undefined) => (name ? byName.get(name.trim().toLowerCase()) : undefined);

      const now = Date.now();
      const rowDocs: Record<string, JsonBlock[]> = {};
      const titles = new Map<string, string>();
      const rows = (p.cards ?? []).map((card, n) => {
        const id = newId();
        const cells: Record<string, unknown> = {};
        const title = String(card[titleName] ?? card.title ?? card.name ?? card.Name ?? `Item ${n + 1}`);
        cells[fields[0].id] = title;
        titles.set(title.trim().toLowerCase(), id);
        for (const [k, v] of Object.entries(card)) {
          if (k.startsWith('_') || v === null || v === undefined || v === '') continue;
          const f = fieldOf(k);
          if (!f || f.primary) continue;
          const optionId = (name: string) => {
            let o = f.options?.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (!o) {
              o = { id: newId(), name, color: nextColor(f.options?.length ?? 0), ...(f.status ? { group: DONE.test(name) ? 'done' : DOING.test(name) ? 'doing' : 'todo' } : {}) } as SelectOption;
              f.options = [...(f.options ?? []), o];
            }
            return o.id;
          };
          if (f.type === 'select') cells[f.id] = optionId(String(v).trim());
          else if (f.type === 'multi_select') cells[f.id] = asList(v).map(optionId);
          else if (f.type === 'number') cells[f.id] = Number.isFinite(Number(v)) ? Number(v) : null;
          else if (f.type === 'checkbox') cells[f.id] = truthy(v);
          else if (f.type === 'date') cells[f.id] = toDate(v);
          else if (f.type === 'checklist') {
            cells[f.id] = asList(v).map((x) => ({ id: newId(), text: x.replace(/^\[[ xX]\]\s*/, ''), done: /^\[[xX]\]/.test(x) }));
          } else if (f.type === 'relation') cells[f.id] = asList(v);
          else if (f.type === 'media') {
            // File names from the import, or web addresses: ["photo.jpg", {"file": "cv.pdf", "name": "CV"}, "https://…"].
            const items = Array.isArray(v) ? v : [v];
            cells[f.id] = items.flatMap((x) => {
              const ref = typeof x === 'string' ? x.trim() : String((x as { file?: string; path?: string; url?: string })?.file ?? (x as { path?: string })?.path ?? (x as { url?: string })?.url ?? '').trim();
              if (!ref) return [];
              const name = (typeof x === 'object' && x && (x as { name?: string }).name) || baseName(ref);
              return [{ url: localRef(ref), name, type: '' }];
            });
          }
          else if (f.type === 'created_time' || f.type === 'last_edited' || f.type === 'formula' || f.type === 'unique_id') continue;
          else cells[f.id] = String(v);
        }
        const body = card._blocks ?? card._content ?? card._markdown;
        if (Array.isArray(body)) rowDocs[id] = body as JsonBlock[];
        else if (typeof body === 'string' && body.trim()) rowDocs[id] = richMarkdownToBlocks(body, parse, keys);
        return { id, createdAt: now + n, updatedAt: now + n, cells };
      });
      // ID properties number the cards in order.
      for (const f of fields.filter((x) => x.type === 'unique_id')) {
        rows.forEach((r, n) => (r.cells[f.id] = n + 1));
        f.nextId = rows.length + 1;
      }
      rowIdsByDb.set(p.key, titles);

      const viewOf = (v: BundleView, n: number): Record<string, unknown> => {
        const vt = VIEW_TYPES.has(String(v.type)) ? String(v.type) : type;
        const group = fieldOf(v.groupBy) ?? (vt === 'board' ? selects.find((f) => f.status) ?? selects[0] : undefined);
        const date = fieldOf(v.date) ?? (vt === 'calendar' || vt === 'timeline' ? dates[0] : undefined);
        const end = fieldOf(v.endDate) ?? (vt === 'timeline' ? dates.find((d) => d !== date) : undefined);
        const label = vt[0].toUpperCase() + vt.slice(1);
        return {
          id: newId(),
          name: v.name ?? (n === 0 ? label : `${label} ${n + 1}`),
          type: vt,
          groupBy: group?.id ?? null,
          subGroupBy: fieldOf(v.swimlanesBy)?.id ?? null,
          dateField: date?.id ?? null,
          endField: end?.id ?? null,
          coverField: fieldOf(v.cover)?.id ?? null,
          chart: vt === 'chart' ? { kind: v.chart?.kind ?? 'bar', groupBy: group?.id ?? selects[0]?.id ?? null, metric: v.chart?.metric ?? 'count', valueField: fieldOf(v.chart?.value)?.id ?? null } : null,
          form: null,
          sorts: (v.sort ?? []).flatMap((s) => (fieldOf(s.property) ? [{ fieldId: fieldOf(s.property)!.id, dir: s.direction === 'desc' ? 'desc' : 'asc' }] : [])),
          filters: (v.filter ?? []).flatMap((x) => {
            const f = fieldOf(x.property);
            if (!f) return [];
            let value = x.value;
            if ((f.type === 'select' || f.type === 'multi_select') && typeof value === 'string') value = f.options?.find((o) => o.name.toLowerCase() === String(value).toLowerCase())?.id ?? value;
            return [{ id: newId(), fieldId: f.id, op: x.op ?? (f.type === 'multi_select' ? 'contains' : 'is'), value }];
          }),
          filterMode: 'and',
          hidden: (v.hide ?? []).flatMap((h) => (fieldOf(h) ? [fieldOf(h)!.id] : [])),
          calcs: {},
        };
      };
      const views = (p.views?.length ? p.views : [{ type }]).map(viewOf);
      page.database = { fields, rows, views };
      page.rowDocs = rowDocs;
    }
    out.push(page);
  }

  // Relations: the linked cards' titles become their ids.
  for (const page of out) {
    if (!page.database) continue;
    for (const f of page.database.fields) {
      if (f.type !== 'relation' || !f.relation) continue;
      const target = rowIdsByDb.get(String((f.relation as { pageId: string }).pageId).slice(4));
      for (const r of page.database.rows) {
        const v = r.cells[f.id];
        if (Array.isArray(v)) r.cells[f.id] = v.map((t) => target?.get(String(t).trim().toLowerCase())).filter(Boolean);
      }
    }
  }
  return { pages: out, warnings };
}
