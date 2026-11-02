import { unzipSync } from 'fflate';

// Other apps' exports, turned into what the importer already reads (folders of HTML/Markdown pages,
// and "workspace-pages" bundles for databases):
// - Notion: a .zip of Markdown and CSV (sometimes a .zip inside the .zip) — unpacked here.
// - Evernote: .enex notebooks — each note becomes an HTML page, with its pictures and attachments.
// - Trello: a board's .json export — becomes a board database (lists as status columns).
// - Word: .docx — becomes an HTML page (headings, bold/italic, lists, tables, pictures).

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const textOf = (b: Uint8Array) => decoder.decode(b).replace(/^﻿/, '');
const safeName = (s: string) => (s.replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled').slice(0, 120);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const stem = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/** Converts any Notion, Evernote, Trello or Word files among `files`; everything else is kept as it is. */
export function convertForeignFormats(files: Map<string, Uint8Array>): { files: Map<string, Uint8Array>; notes: string[] } {
  const out = new Map<string, Uint8Array>();
  const notes: string[] = [];
  const add = (path: string, data: Uint8Array) => {
    let p = path;
    for (let i = 2; out.has(p); i++) p = path.replace(/(\.[^./]+)?$/, ` (${i})$1`);
    out.set(p, data);
  };
  const visit = (path: string, data: Uint8Array, depth: number) => {
    const lower = path.toLowerCase();
    try {
      if (lower.endsWith('.zip') && depth < 3) {
        // Notion's export can hold its parts as zips inside the zip.
        const dir = dirOf(path);
        for (const [inner, bytes] of Object.entries(unzipSync(data))) {
          if (inner.endsWith('/') || inner.startsWith('__MACOSX/') || /(^|\/)\.[^/]+$/.test(inner)) continue;
          visit(dir + inner.replace(/\\/g, '/'), bytes, depth + 1);
        }
        return;
      }
      if (lower.endsWith('.enex')) {
        const n = enexToPages(path, textOf(data), add);
        notes.push(`Evernote: ${n} note${n === 1 ? '' : 's'} from ${stem(path)}`);
        return;
      }
      if (lower.endsWith('.docx')) {
        docxToHtml(path, data, add);
        notes.push(`Document: ${stem(path)}`);
        return;
      }
      if (lower.endsWith('.json')) {
        const json = JSON.parse(textOf(data));
        if (isTrelloBoard(json)) {
          add(dirOf(path) + `trello-${safeName(json.name)}.json`, encoder.encode(JSON.stringify(trelloToBundle(json))));
          notes.push(`Trello: the board “${json.name}” (${json.cards.filter((c: TrelloCard) => !c.closed).length} cards)`);
          return;
        }
      }
    } catch (err) {
      notes.push(`Couldn't read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    add(path, data);
  };
  for (const [path, data] of files) visit(path, data, 0);
  // Notion writes each database twice: "Name.csv" (the current view) and "Name_all.csv" (every row).
  // Keep the complete one, under the plain name.
  for (const p of [...out.keys()]) {
    const m = /^(.*)_all\.csv$/i.exec(p);
    if (!m) continue;
    const data = out.get(p)!;
    out.delete(p);
    out.set(`${m[1]}.csv`, data);
  }
  return { files: out, notes };
}

// ---------- Evernote (.enex) ----------

function base64ToBytes(b64: string) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

function enexToPages(path: string, xml: string, add: (path: string, data: Uint8Array) => void): number {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const notebook = safeName(stem(path));
  const notes = Array.from(doc.getElementsByTagName('note'));
  const used = new Set<string>();
  for (const note of notes) {
    let title = safeName(note.getElementsByTagName('title')[0]?.textContent ?? 'Untitled');
    for (let i = 2; used.has(title.toLowerCase()); i++) title = `${safeName(note.getElementsByTagName('title')[0]?.textContent ?? 'Untitled')} ${i}`;
    used.add(title.toLowerCase());
    const filesDir = `${notebook}/${title}_files`;
    // Each attachment, written next to the page; matched to its place in the note in order.
    const resources = Array.from(note.getElementsByTagName('resource')).map((r, i) => {
      const mime = r.getElementsByTagName('mime')[0]?.textContent ?? 'application/octet-stream';
      const given = r.getElementsByTagName('file-name')[0]?.textContent;
      const name = safeName(given || `attachment-${i + 1}.${EXT[mime] ?? 'bin'}`);
      const data = r.getElementsByTagName('data')[0]?.textContent ?? '';
      if (data) add(`${filesDir}/${name}`, base64ToBytes(data));
      return { name, mime };
    });
    let content = note.getElementsByTagName('content')[0]?.textContent ?? '';
    content = content.replace(/<\?xml[^>]*>/g, '').replace(/<!DOCTYPE[^>]*>/g, '').replace(/<\/?en-note[^>]*>/g, '');
    // Checkboxes and attachments.
    content = content.replace(/<en-todo\s+checked="true"\s*\/?>/g, '☑ ').replace(/<en-todo[^>]*\/?>/g, '☐ ');
    let next = 0;
    content = content.replace(/<en-media[^>]*?(?:\/>|>\s*<\/en-media>)/g, () => {
      const r = resources[next++];
      if (!r) return '';
      const href = `${encodeURIComponent(title)}_files/${encodeURIComponent(r.name)}`;
      return r.mime.startsWith('image/') ? `<img src="${href}" alt="${esc(r.name)}">` : `<p><a href="${href}">${esc(r.name)}</a></p>`;
    });
    // Attachments the note didn't place go at the end.
    const rest = resources.slice(next).map((r) => {
      const href = `${encodeURIComponent(title)}_files/${encodeURIComponent(r.name)}`;
      return r.mime.startsWith('image/') ? `<img src="${href}" alt="${esc(r.name)}">` : `<p><a href="${href}">${esc(r.name)}</a></p>`;
    });
    const tags = Array.from(note.getElementsByTagName('tag')).map((t) => t.textContent ?? '').filter(Boolean);
    const html = `<html><head><title>${esc(title)}</title></head><body>${content}${rest.join('')}${tags.length ? `<p><em>Tags: ${esc(tags.join(', '))}</em></p>` : ''}</body></html>`;
    add(`${notebook}/${title}.html`, encoder.encode(html));
  }
  return notes.length;
}

// ---------- Trello (board .json) ----------

interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  idList: string;
  closed?: boolean;
  due?: string | null;
  dueComplete?: boolean;
  labels?: { name?: string; color?: string }[];
  idChecklists?: string[];
  pos?: number;
}
interface TrelloBoard {
  name: string;
  desc?: string;
  lists: { id: string; name: string; closed?: boolean; pos?: number }[];
  cards: TrelloCard[];
  checklists?: { id: string; name: string; checkItems: { name: string; state: string; pos?: number }[] }[];
}

function isTrelloBoard(v: unknown): v is TrelloBoard {
  const b = v as TrelloBoard;
  return !!b && typeof b === 'object' && typeof b.name === 'string' && Array.isArray(b.lists) && Array.isArray(b.cards) && (b.cards.length === 0 || 'idList' in b.cards[0]);
}

function trelloToBundle(board: TrelloBoard) {
  const lists = board.lists.filter((l) => !l.closed).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  const listName = new Map(lists.map((l) => [l.id, l.name || 'Untitled list']));
  const checklists = new Map((board.checklists ?? []).map((c) => [c.id, c]));
  const labels = [...new Set(board.cards.flatMap((c) => (c.labels ?? []).map((l) => l.name || l.color || '')).filter(Boolean))];
  const cards = board.cards
    .filter((c) => !c.closed && listName.has(c.idList))
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
    .map((c) => {
      const items = (c.idChecklists ?? []).map((id) => checklists.get(id)).filter(Boolean) as NonNullable<TrelloBoard['checklists']>;
      const checklistMd = items
        .map((cl) => `### ${cl.name}\n${[...cl.checkItems].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)).map((i) => `- [${i.state === 'complete' ? 'x' : ' '}] ${i.name}`).join('\n')}`)
        .join('\n\n');
      const content = [c.desc?.trim(), checklistMd].filter(Boolean).join('\n\n');
      return {
        Name: c.name || 'Untitled',
        List: listName.get(c.idList),
        ...(labels.length ? { Labels: (c.labels ?? []).map((l) => l.name || l.color || '').filter(Boolean) } : {}),
        ...(c.due ? { Due: c.due.slice(0, 10) } : {}),
        Done: !!c.dueComplete,
        ...(content ? { _content: content } : {}),
      };
    });
  return {
    format: 'workspace-pages',
    version: 1,
    pages: [
      {
        key: 'trello-board',
        title: board.name || 'Trello board',
        icon: '📋',
        type: 'board',
        properties: [
          { name: 'List', type: 'select', options: lists.map((l) => l.name || 'Untitled list') },
          ...(labels.length ? [{ name: 'Labels', type: 'multi_select', options: labels }] : []),
          { name: 'Due', type: 'date' },
          { name: 'Done', type: 'checkbox' },
        ],
        cards,
        views: [
          { type: 'board', name: 'Board', groupBy: 'List' },
          { type: 'grid', name: 'Table' },
          { type: 'calendar', name: 'Calendar', date: 'Due' },
        ],
      },
    ],
  };
}

// ---------- Word (.docx) ----------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function docxToHtml(path: string, data: Uint8Array, add: (path: string, data: Uint8Array) => void) {
  const zip = unzipSync(data);
  const xml = zip['word/document.xml'];
  if (!xml) throw new Error('not a Word document');
  const parse = (b: Uint8Array) => new DOMParser().parseFromString(textOf(b), 'application/xml');
  const doc = parse(xml);
  const name = stem(path);
  const dir = dirOf(path);
  const filesDir = `${name}_files`;
  // Pictures: relationship id → media file, copied next to the page.
  const rels = new Map<string, string>();
  const relXml = zip['word/_rels/document.xml.rels'];
  if (relXml) {
    for (const rel of Array.from(parse(relXml).getElementsByTagName('Relationship'))) {
      const target = rel.getAttribute('Target') ?? '';
      if (!/media\//.test(target)) continue;
      const file = target.split('/').pop()!;
      const bytes = zip[`word/${target.replace(/^\.?\//, '')}`] ?? zip[`word/media/${file}`];
      if (!bytes) continue;
      add(`${dir}${filesDir}/${file}`, bytes);
      rels.set(rel.getAttribute('Id') ?? '', `${encodeURIComponent(filesDir)}/${encodeURIComponent(file)}`);
    }
  }
  // Which list numbering ids are numbered (decimal) rather than bullets.
  const numbered = new Set<string>();
  const numXml = zip['word/numbering.xml'];
  if (numXml) {
    const nd = parse(numXml);
    const abstractFmt = new Map<string, string>();
    for (const a of Array.from(nd.getElementsByTagNameNS(W, 'abstractNum'))) {
      const fmt = a.getElementsByTagNameNS(W, 'numFmt')[0]?.getAttributeNS(W, 'val') ?? 'bullet';
      abstractFmt.set(a.getAttributeNS(W, 'abstractNumId') ?? '', fmt);
    }
    for (const n of Array.from(nd.getElementsByTagNameNS(W, 'num'))) {
      const abs = n.getElementsByTagNameNS(W, 'abstractNumId')[0]?.getAttributeNS(W, 'val') ?? '';
      if (abstractFmt.get(abs) && abstractFmt.get(abs) !== 'bullet') numbered.add(n.getAttributeNS(W, 'numId') ?? '');
    }
  }
  const val = (el: Element | undefined, tag: string) => el?.getElementsByTagNameNS(W, tag)[0]?.getAttributeNS(W, 'val');
  const has = (el: Element | undefined, tag: string) => {
    const t = el?.getElementsByTagNameNS(W, tag)[0];
    return !!t && t.getAttributeNS(W, 'val') !== '0' && t.getAttributeNS(W, 'val') !== 'false';
  };

  const runs = (p: Element): string => {
    let html = '';
    for (const node of Array.from(p.childNodes) as Element[]) {
      if (node.namespaceURI !== W) continue;
      if (node.localName === 'hyperlink') {
        const id = node.getAttributeNS(R, 'id');
        const target = id && relXml ? Array.from(parse(relXml).getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === id)?.getAttribute('Target') : null;
        const inner = runs(node);
        html += target ? `<a href="${esc(target)}">${inner}</a>` : inner;
        continue;
      }
      if (node.localName !== 'r') continue;
      const props = node.getElementsByTagNameNS(W, 'rPr')[0];
      let text = '';
      for (const c of Array.from(node.childNodes) as Element[]) {
        if (c.localName === 't') text += esc(c.textContent ?? '');
        else if (c.localName === 'tab') text += ' ';
        else if (c.localName === 'br') text += '<br>';
        else if (c.localName === 'drawing' || c.localName === 'pict') {
          const blip = c.getElementsByTagNameNS(A, 'blip')[0] ?? c.getElementsByTagName('v:imagedata')[0];
          const id = blip?.getAttributeNS(R, 'embed') || blip?.getAttributeNS(R, 'id');
          const src = id ? rels.get(id) : null;
          if (src) text += `<img src="${src}">`;
        }
      }
      if (!text) continue;
      if (has(props, 'b')) text = `<strong>${text}</strong>`;
      if (has(props, 'i')) text = `<em>${text}</em>`;
      if (has(props, 'u')) text = `<u>${text}</u>`;
      if (has(props, 'strike')) text = `<s>${text}</s>`;
      html += text;
    }
    return html;
  };

  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  for (const el of Array.from(body?.children ?? [])) {
    if (el.localName === 'tbl') {
      flush();
      const rows = Array.from(el.getElementsByTagNameNS(W, 'tr')).map(
        (tr) =>
          `<tr>${Array.from(tr.getElementsByTagNameNS(W, 'tc'))
            .map((tc) => `<td>${Array.from(tc.getElementsByTagNameNS(W, 'p')).map(runs).join('<br>')}</td>`)
            .join('')}</tr>`,
      );
      out.push(`<table>${rows.join('')}</table>`);
      continue;
    }
    if (el.localName !== 'p') continue;
    const props = el.getElementsByTagNameNS(W, 'pPr')[0];
    const style = (val(props, 'pStyle') ?? '').toLowerCase();
    const content = runs(el);
    const numId = props?.getElementsByTagNameNS(W, 'numPr')[0] ? val(props.getElementsByTagNameNS(W, 'numPr')[0], 'numId') : undefined;
    if (numId && numId !== '0') {
      const tag = numbered.has(numId) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      list.items.push(content);
      continue;
    }
    flush();
    const heading = /^(heading|berschrift|titre|título|titolo)\s*([1-6])$/.exec(style.replace(/[-_]/g, ' ')) ?? (style === 'title' ? [, , '1'] : null);
    if (heading) out.push(`<h${Math.min(3, Number(heading[2]))}>${content}</h${Math.min(3, Number(heading[2]))}>`);
    else if (/quote/.test(style)) out.push(`<blockquote>${content}</blockquote>`);
    else if (content) out.push(`<p>${content}</p>`);
  }
  flush();
  add(`${dir}${name}.html`, encoder.encode(`<html><head><title>${esc(name)}</title></head><body>${out.join('\n')}</body></html>`));
}
