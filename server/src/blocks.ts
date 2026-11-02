import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { boardDocName, fileDocName, hocuspocus } from './collab.js';
import { one } from './db.js';
import { type IndexOptions, updateDocIndex } from './docIndex.js';

// Helpers for editing the block structure of page and card documents on the server, used to move
// attachments between pages. The structure mirrors the editor's: a root blockGroup of blockContainers,
// each holding one block element and optionally a nested blockGroup of child blocks.

export type BlockPosition = 'start' | 'end' | 'after' | 'inside';

export interface BlockOutline {
  id: string;
  type: string;
  text: string;
  depth: number;
}

export interface BlockTemplate {
  nodeName: string;
  attrs: Record<string, unknown>;
}

const docName = (pageId: string, rowId: string | null) => (rowId ? `${pageId}:${rowId}` : pageId);

/** Runs `fn` on a live page or card document (loading it if needed) and refreshes its file references. */
export async function editDoc<T>(pageId: string, rowId: string | null, fn: (doc: Y.Doc) => T, index: IndexOptions = {}): Promise<T> {
  const connection = await hocuspocus.openDirectConnection(docName(pageId, rowId), {});
  try {
    let value!: T;
    await connection.transact((doc) => {
      value = fn(doc);
    });
    if (connection.document) await updateDocIndex(pageId, rowId, connection.document, index);
    return value;
  } finally {
    await connection.disconnect();
  }
}

async function readStored<T>(state: Buffer | undefined, fn: (doc: Y.Doc) => T): Promise<T> {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, new Uint8Array(state));
  try {
    return fn(doc);
  } finally {
    doc.destroy();
  }
}

/** Reads a document without keeping it open: the live copy if someone has it open, else the stored one. */
export async function readDoc<T>(pageId: string, rowId: string | null, fn: (doc: Y.Doc) => T): Promise<T> {
  const live = hocuspocus.documents.get(docName(pageId, rowId));
  if (live) return fn(live);
  const row = rowId
    ? await one<{ state: Buffer }>('select state from row_documents where page_id = $1 and row_id = $2', [pageId, rowId])
    : await one<{ state: Buffer }>('select state from page_content where page_id = $1', [pageId]);
  return readStored(row?.state, fn);
}

/** Reads a whiteboard's document (live or stored). */
export async function readBoardDoc<T>(boardId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  const live = hocuspocus.documents.get(boardDocName(boardId));
  if (live) return fn(live);
  const row = await one<{ state: Buffer | null }>('select state from whiteboards where id = $1', [boardId]);
  return readStored(row?.state ?? undefined, fn);
}

/** Reads a file's annotation document (live or stored). */
export async function readFileDoc<T>(fileId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  const live = hocuspocus.documents.get(fileDocName(fileId));
  if (live) return fn(live);
  const row = await one<{ state: Buffer }>('select state from file_annotations where file_id = $1', [fileId]);
  return readStored(row?.state, fn);
}

function blockContent(container: Y.XmlElement): Y.XmlElement | null {
  const first = container.get(0);
  return first instanceof Y.XmlElement ? first : null;
}

function childGroup(container: Y.XmlElement): Y.XmlElement | null {
  const second = container.get(1);
  return second instanceof Y.XmlElement && second.nodeName === 'blockGroup' ? second : null;
}

function rootGroup(doc: Y.Doc): Y.XmlElement {
  const fragment = doc.getXmlFragment('document-store');
  let group = fragment.get(0);
  if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') {
    group = new Y.XmlElement('blockGroup');
    fragment.insert(fragment.length, [group]);
  }
  return group as Y.XmlElement;
}

function containers(group: Y.XmlElement, depth = 0, out: { el: Y.XmlElement; depth: number }[] = []) {
  for (const child of group.toArray()) {
    if (!(child instanceof Y.XmlElement) || child.nodeName !== 'blockContainer') continue;
    out.push({ el: child, depth });
    const nested = childGroup(child);
    if (nested) containers(nested, depth + 1, out);
  }
  return out;
}

function textOf(el: Y.XmlElement): string {
  return el
    .toArray()
    .map((c) => (c instanceof Y.XmlText ? c.toDelta().map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : '')).join('') : c instanceof Y.XmlElement ? textOf(c) : ''))
    .join('');
}

/** The blocks of a document, flattened with their nesting depth, for choosing where to put a file. */
export function outlineOf(doc: Y.Doc): BlockOutline[] {
  return containers(rootGroup(doc)).map(({ el, depth }) => {
    const content = blockContent(el);
    const attrs = content?.getAttributes() ?? {};
    const text = (content ? textOf(content) : '').trim() || String(attrs.name ?? attrs.caption ?? '').trim();
    return { id: String(el.getAttribute('id') ?? ''), type: content?.nodeName ?? 'paragraph', text: text.slice(0, 120), depth };
  });
}

/** Picks out the blocks of one attachment, event or whiteboard. */
export type BlockMatch = (content: Y.XmlElement) => boolean;

export const fileBlock =
  (fileId: string): BlockMatch =>
  (content) => {
    const url = content.getAttribute('url');
    return typeof url === 'string' && url.toLowerCase().includes(fileId.toLowerCase());
  };

export const eventBlock =
  (eventId: string): BlockMatch =>
  (content) =>
    content.nodeName === 'event' && String(content.getAttribute('eventId') ?? '').toLowerCase() === eventId.toLowerCase();

export const boardBlock =
  (boardId: string): BlockMatch =>
  (content) =>
    content.nodeName === 'whiteboard' && String(content.getAttribute('boardId') ?? '').toLowerCase() === boardId.toLowerCase();

function emptyParagraph() {
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', randomUUID());
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText()]);
  container.insert(0, [p]);
  return container;
}

/**
 * Removes every matching block from a document. Blocks nested under a removed block are kept and
 * moved up in its place. Returns a copy of the first removed block so it can be re-created elsewhere.
 */
export function removeBlocks(doc: Y.Doc, match: BlockMatch): BlockTemplate | null {
  let template: BlockTemplate | null = null;
  const visit = (group: Y.XmlElement) => {
    for (let i = group.length - 1; i >= 0; i--) {
      const child = group.get(i);
      if (!(child instanceof Y.XmlElement) || child.nodeName !== 'blockContainer') continue;
      const nested = childGroup(child);
      if (nested) visit(nested);
      const content = blockContent(child);
      if (!content || !match(content)) continue;
      template ??= { nodeName: content.nodeName, attrs: { ...content.getAttributes() } };
      const lifted = nested ? nested.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement).map((c) => c.clone()) : [];
      group.delete(i, 1);
      if (lifted.length) group.insert(i, lifted);
    }
  };
  const root = rootGroup(doc);
  visit(root);
  // Never leave a document without any block.
  if (root.length === 0) root.insert(0, [emptyParagraph()]);
  return template;
}

/** Sets attributes (e.g. the file name) on every matching block. */
export function updateBlocks(doc: Y.Doc, match: BlockMatch, attrs: Record<string, string>) {
  for (const { el } of containers(rootGroup(doc))) {
    const content = blockContent(el);
    if (content && match(content)) for (const [k, v] of Object.entries(attrs)) content.setAttribute(k, v);
  }
}

/** Inserts a block at the start or end of a document, or after / nested inside a given block. */
export function insertBlock(doc: Y.Doc, template: BlockTemplate, anchorId: string | null, position: BlockPosition): boolean {
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', randomUUID());
  const block = new Y.XmlElement(template.nodeName);
  for (const [k, v] of Object.entries(template.attrs)) block.setAttribute(k, v as string);
  container.insert(0, [block]);

  const root = rootGroup(doc);
  if (position === 'start') {
    root.insert(0, [container]);
    return true;
  }
  if (position === 'end' || !anchorId) {
    // Keep the editor's trailing empty paragraph last.
    const blocks = root.toArray();
    const last = blocks[blocks.length - 1];
    const lastContent = last instanceof Y.XmlElement ? blockContent(last) : null;
    const lastEmpty = last instanceof Y.XmlElement && !childGroup(last) && lastContent?.nodeName === 'paragraph' && textOf(lastContent) === '';
    root.insert(lastEmpty ? blocks.length - 1 : blocks.length, [container]);
    return true;
  }
  const anchor = containers(root).find(({ el }) => el.getAttribute('id') === anchorId)?.el;
  if (!anchor) return false;
  if (position === 'inside') {
    let nested = childGroup(anchor);
    if (!nested) {
      nested = new Y.XmlElement('blockGroup');
      anchor.insert(1, [nested]);
    }
    nested.insert(nested.length, [container]);
    return true;
  }
  const parent = anchor.parent as Y.XmlElement;
  parent.insert(parent.toArray().indexOf(anchor) + 1, [container]);
  return true;
}

/** Card ids and titles of a database page. */
export function databaseRows(doc: Y.Doc): { id: string; title: string }[] {
  const fields = doc.getArray<Y.Map<unknown>>('fields').toArray().filter((f) => f instanceof Y.Map);
  const primary = fields.find((f) => f.get('primary')) ?? fields[0];
  const pid = primary ? String(primary.get('id')) : null;
  return doc
    .getArray<Y.Map<unknown>>('rows')
    .toArray()
    .filter((r) => r instanceof Y.Map)
    .map((r) => {
      const cells = r.get('cells');
      const title = pid && cells instanceof Y.Map ? cells.get(pid) : null;
      return { id: String(r.get('id')), title: typeof title === 'string' && title.trim() ? title.trim() : 'Untitled' };
    });
}

/** A blank A4 PDF with `pages` pages, used for new handwritten notes. */
export function blankPdf(pages = 1): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> >>'),
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
