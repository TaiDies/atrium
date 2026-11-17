import { unzipSync, zipSync, type Zippable } from 'fflate';

// Lossless .docx saving. The editor only models the text, so turning its HTML back into a whole Word
// file would drop everything else (headers and footers, page setup details, styles, themes, document
// properties, footnotes, comments…). Instead the stored file is kept as the base and only the body of
// its main document is swapped for the body LibreOffice made from the editor's content. Whatever that
// new body points at (images, links, list definitions, styles the base lacks) is copied across; every
// other part of the stored file stays byte-for-byte as it was.

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const REL_OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const REL_NUMBERING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
const REL_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const REL_FOOTNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
const REL_ENDNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const FALLBACK_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  webp: 'image/webp',
};

/** A short, stable fingerprint of a string (not cryptographic; works without a secure context). */
export function fingerprint(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}:${s.length}`;
}

// ---------------------------------------------------------------------------------------------------
// Package helpers

type Files = Record<string, Uint8Array>;

const dec = new TextDecoder();
const enc = new TextEncoder();

function parseXml(bytes: Uint8Array | undefined, name: string): XMLDocument {
  if (!bytes) throw new Error(`Missing ${name}`);
  const doc = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`Malformed XML in ${name}`);
  return doc;
}

const emptyXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

function writeXml(doc: XMLDocument): Uint8Array {
  return enc.encode(XML_DECL + new XMLSerializer().serializeToString(doc.documentElement));
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
const relsPathOf = (part: string) => `${dirOf(part)}_rels/${part.slice(dirOf(part).length)}.rels`;
const extOfPath = (path: string) => (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase();

/** A relationship target resolved against the folder of the part it belongs to. */
function resolveTarget(fromPart: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : dirOf(fromPart) + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/** `toPart` as a target relative to the folder of `fromPart`. */
function relativeTarget(fromPart: string, toPart: string): string {
  const from = dirOf(fromPart).split('/').filter(Boolean);
  const to = toPart.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

/** The path of the main document part (usually word/document.xml). */
function mainPart(files: Files): string {
  if (files['_rels/.rels']) {
    for (const rel of [...parseXml(files['_rels/.rels'], '_rels/.rels').getElementsByTagNameNS(PR, 'Relationship')]) {
      if (rel.getAttribute('Type') === REL_OFFICE_DOC) return resolveTarget('', rel.getAttribute('Target') ?? '');
    }
  }
  return 'word/document.xml';
}

class Rels {
  doc: XMLDocument;
  constructor(
    readonly files: Files,
    readonly part: string,
  ) {
    const path = relsPathOf(part);
    this.doc = files[path] ? parseXml(files[path], path) : emptyXml(`<Relationships xmlns="${PR}"/>`);
  }
  all() {
    return [...this.doc.getElementsByTagNameNS(PR, 'Relationship')];
  }
  byId(id: string) {
    return this.all().find((r) => r.getAttribute('Id') === id) ?? null;
  }
  byType(type: string) {
    return this.all().find((r) => r.getAttribute('Type') === type) ?? null;
  }
  targetPath(rel: Element) {
    return resolveTarget(this.part, rel.getAttribute('Target') ?? '');
  }
  add(type: string, target: string, external: boolean): string {
    const ids = new Set(this.all().map((r) => r.getAttribute('Id')));
    let n = 1;
    while (ids.has(`rIdM${n}`)) n++;
    const id = `rIdM${n}`;
    const rel = this.doc.createElementNS(PR, 'Relationship');
    rel.setAttribute('Id', id);
    rel.setAttribute('Type', type);
    rel.setAttribute('Target', target);
    if (external) rel.setAttribute('TargetMode', 'External');
    this.doc.documentElement.appendChild(rel);
    return id;
  }
  save() {
    this.files[relsPathOf(this.part)] = writeXml(this.doc);
  }
}

class ContentTypes {
  doc: XMLDocument;
  constructor(readonly files: Files) {
    this.doc = parseXml(files['[Content_Types].xml'], '[Content_Types].xml');
  }
  typeOf(path: string): string | null {
    for (const o of [...this.doc.getElementsByTagNameNS(CT, 'Override')]) {
      if ((o.getAttribute('PartName') ?? '').replace(/^\//, '').toLowerCase() === path.toLowerCase()) return o.getAttribute('ContentType');
    }
    return this.defaultFor(extOfPath(path));
  }
  defaultFor(ext: string): string | null {
    for (const d of [...this.doc.getElementsByTagNameNS(CT, 'Default')]) if ((d.getAttribute('Extension') ?? '').toLowerCase() === ext) return d.getAttribute('ContentType');
    return null;
  }
  /** Makes sure `path` is typed as `type`: by its extension's default when that matches, otherwise by an override. */
  ensure(path: string, type: string) {
    const ext = extOfPath(path);
    const def = this.defaultFor(ext);
    if (def === type) return;
    if (!def && ext && ext !== 'xml' && ext !== 'rels') {
      const d = this.doc.createElementNS(CT, 'Default');
      d.setAttribute('Extension', ext);
      d.setAttribute('ContentType', type);
      this.doc.documentElement.insertBefore(d, this.doc.documentElement.firstElementChild);
      return;
    }
    const o = this.doc.createElementNS(CT, 'Override');
    o.setAttribute('PartName', `/${path}`);
    o.setAttribute('ContentType', type);
    this.doc.documentElement.appendChild(o);
  }
  /** Drops the override for a part that's gone. */
  forget(path: string) {
    for (const o of [...this.doc.getElementsByTagNameNS(CT, 'Override')]) if ((o.getAttribute('PartName') ?? '').replace(/^\//, '').toLowerCase() === path.toLowerCase()) o.remove();
  }
  save() {
    this.files['[Content_Types].xml'] = writeXml(this.doc);
  }
}

function uniquePath(files: Files, wanted: string): string {
  const taken = new Set(Object.keys(files).map((p) => p.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const dir = dirOf(wanted);
  const file = wanted.slice(dir.length);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  for (let n = 1; ; n++) {
    const p = `${dir}${stem}_${n}${ext}`;
    if (!taken.has(p.toLowerCase())) return p;
  }
}

/** The part a .rels file belongs to (word/_rels/document.xml.rels → word/document.xml). */
const partOfRels = (rels: string) => rels.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');

/** Every relationship id used (r:id, r:embed…) in and under `nodes`. */
function relIds(nodes: Element[]): Set<string> {
  const ids = new Set<string>();
  const visit = (el: Element) => {
    for (const attr of [...el.attributes]) if (attr.namespaceURI === R && attr.value) ids.add(attr.value);
    for (const c of [...el.children]) visit(c);
  };
  nodes.forEach(visit);
  return ids;
}

const wAttr = (el: Element, name: string) => el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`);
const setWAttr = (el: Element, name: string, value: string) => el.setAttributeNS(W, `${el.lookupPrefix(W) ?? 'w'}:${name}`, value);
const wEls = (root: Document | Element, name: string) => [...root.getElementsByTagNameNS(W, name)];
const childEls = (el: Element, ns: string, name: string) => [...el.children].filter((c) => c.namespaceURI === ns && c.localName === name);

// ---------------------------------------------------------------------------------------------------
// The merge

interface Ctx {
  base: Files;
  gen: Files;
  baseCt: ContentTypes;
  genCt: ContentTypes;
  /** Generated part path → the path it was copied to in the base. */
  copied: Map<string, string>;
}

/** Copies a generated part (and, recursively, the parts it points at) into the base under a fresh name. */
function copyPart(ctx: Ctx, genPath: string): string {
  const done = ctx.copied.get(genPath);
  if (done) return done;
  const bytes = ctx.gen[genPath];
  if (!bytes) throw new Error(`Missing part ${genPath}`);
  const wanted = genPath.startsWith('word/media/') ? `word/media/edited-${genPath.slice('word/media/'.length)}` : genPath;
  const path = uniquePath(ctx.base, wanted);
  ctx.copied.set(genPath, path);
  ctx.base[path] = bytes;
  const type = ctx.genCt.typeOf(genPath) ?? FALLBACK_TYPES[extOfPath(genPath)];
  if (type) ctx.baseCt.ensure(path, type);
  // Its own relationships, pointed at the copies.
  if (ctx.gen[relsPathOf(genPath)]) {
    const genRels = new Rels(ctx.gen, genPath);
    const newRels = new Rels(ctx.base, path);
    for (const rel of genRels.all()) {
      const r = newRels.doc.importNode(rel, true) as Element;
      if (rel.getAttribute('TargetMode') !== 'External') r.setAttribute('Target', relativeTarget(path, copyPart(ctx, genRels.targetPath(rel))));
      newRels.doc.documentElement.appendChild(r);
    }
    newRels.save();
  }
  return path;
}

/** Points every relationship attribute (r:id, r:embed, r:link…) in `nodes` at copies made in the base. */
function remapRelationships(ctx: Ctx, nodes: Element[], genRels: Rels, baseRels: Rels) {
  const map = new Map<string, string>();
  const visit = (el: Element) => {
    for (const attr of [...el.attributes]) {
      if (attr.namespaceURI !== R || !attr.value) continue;
      let id = map.get(attr.value);
      if (!id) {
        const rel = genRels.byId(attr.value);
        if (!rel) throw new Error(`Unknown relationship ${attr.value}`);
        const type = rel.getAttribute('Type') ?? '';
        if (rel.getAttribute('TargetMode') === 'External') id = baseRels.add(type, rel.getAttribute('Target') ?? '', true);
        else id = baseRels.add(type, relativeTarget(baseRels.part, copyPart(ctx, genRels.targetPath(rel))), false);
        map.set(attr.value, id);
      }
      attr.value = id;
    }
    for (const c of [...el.children]) visit(c);
  };
  nodes.forEach(visit);
}

/** Declares on the base root any namespace prefixes the generated root declares and the base lacks. */
function carryNamespaces(baseRoot: Element, genRoot: Element) {
  const ignorable = new Set((baseRoot.getAttributeNS(MC, 'Ignorable') ?? '').split(/\s+/).filter(Boolean));
  const before = ignorable.size;
  const genIgnorable = (genRoot.getAttributeNS(MC, 'Ignorable') ?? '').split(/\s+/).filter(Boolean);
  for (const attr of [...genRoot.attributes]) {
    if (attr.namespaceURI !== XMLNS || attr.localName === 'xmlns') continue;
    const prefix = attr.localName;
    if (baseRoot.lookupNamespaceURI(prefix)) continue;
    baseRoot.setAttributeNS(XMLNS, `xmlns:${prefix}`, attr.value);
    if (genIgnorable.includes(prefix)) ignorable.add(prefix);
  }
  const mc = baseRoot.lookupPrefix(MC);
  if (ignorable.size !== before && mc) baseRoot.setAttributeNS(MC, `${mc}:Ignorable`, [...ignorable].join(' '));
}

/** A part reached from the main document by relationship type, with its XML. */
function partByType(files: Files, main: string, type: string) {
  const rels = new Rels(files, main);
  const rel = rels.byType(type);
  if (!rel) return null;
  const path = rels.targetPath(rel);
  return files[path] ? { path, doc: parseXml(files[path], path) } : null;
}

export interface PageGeometry {
  /** Page width and height in millimetres. */
  w: number;
  h: number;
  landscape: boolean;
  /** Margins in millimetres. */
  margins: { top: number; right: number; bottom: number; left: number };
}

const twips = (mm: number) => Math.round(mm * 56.6929);

/** Sets the page size and margins in a section's properties, leaving values that already match alone. */
function applyPage(sectPr: Element, page: PageGeometry) {
  const doc = sectPr.ownerDocument;
  const prefix = sectPr.prefix;
  const make = (name: string) => doc.createElementNS(W, prefix ? `${prefix}:${name}` : name);
  // Schema order inside sectPr: headerReference*, footerReference*, footnotePr, endnotePr, type, pgSz, pgMar, …
  let pgSz = childEls(sectPr, W, 'pgSz')[0];
  if (!pgSz) {
    pgSz = make('pgSz');
    let after: Element | null = null;
    for (const c of [...sectPr.children]) if (c.namespaceURI === W && ['headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type'].includes(c.localName)) after = c;
    sectPr.insertBefore(pgSz, after ? after.nextSibling : sectPr.firstChild);
  }
  const near = (a: string | null, b: number) => a !== null && Math.abs(Number(a) - b) <= 60; // ~1 mm
  const w = twips(page.w);
  const h = twips(page.h);
  if (!near(wAttr(pgSz, 'w'), w) || !near(wAttr(pgSz, 'h'), h) || (wAttr(pgSz, 'orient') === 'landscape') !== page.landscape) {
    setWAttr(pgSz, 'w', String(w));
    setWAttr(pgSz, 'h', String(h));
    if (page.landscape) setWAttr(pgSz, 'orient', 'landscape');
    else pgSz.removeAttributeNS(W, 'orient');
  }
  let pgMar = childEls(sectPr, W, 'pgMar')[0];
  if (!pgMar) {
    pgMar = make('pgMar');
    sectPr.insertBefore(pgMar, pgSz.nextSibling);
    setWAttr(pgMar, 'header', '708');
    setWAttr(pgMar, 'footer', '708');
    setWAttr(pgMar, 'gutter', '0');
  }
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const v = twips(page.margins[side]);
    if (!near(wAttr(pgMar, side), v)) setWAttr(pgMar, side, String(v));
  }
}

/**
 * The stored .docx (`baseBytes`) with its body replaced by the body of `genBytes` (the editor's content
 * as LibreOffice wrote it). `page` updates the page size and margins; leave it out to keep the stored ones.
 * Throws if anything doesn't add up, so the caller can fall back to the generated file.
 */
export function mergeDocx(baseBytes: Uint8Array, genBytes: Uint8Array, page?: PageGeometry | null): Uint8Array {
  const original: Files = unzipSync(baseBytes);
  const base: Files = { ...original };
  const gen: Files = unzipSync(genBytes);
  const ctx: Ctx = { base, gen, baseCt: new ContentTypes(base), genCt: new ContentTypes(gen), copied: new Map() };

  const baseMain = mainPart(base);
  const genMain = mainPart(gen);
  const baseDoc = parseXml(base[baseMain], baseMain);
  const genDoc = parseXml(gen[genMain], genMain);
  const baseBody = wEls(baseDoc, 'body')[0];
  const genBody = wEls(genDoc, 'body')[0];
  if (!baseBody || !genBody) throw new Error('No document body');
  const baseRels = new Rels(base, baseMain);
  const genRels = new Rels(gen, genMain);

  // The new content: everything in the generated body but its closing section properties.
  const genKids = [...genBody.children];
  const genLast = genKids[genKids.length - 1];
  const genSect = genLast && genLast.namespaceURI === W && genLast.localName === 'sectPr' ? genLast : null;
  const content = genKids.filter((c) => c !== genSect).map((c) => baseDoc.importNode(c, true) as Element);
  // Comment marks would point at the stored file's comments, which are about other text.
  for (const el of content) for (const name of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) for (const c of wEls(el, name)) c.remove();

  carryNamespaces(baseDoc.documentElement, genDoc.documentElement);
  remapRelationships(ctx, content, genRels, baseRels);

  // ---- Styles and lists the new content uses.
  const genStylesPart = partByType(gen, genMain, REL_STYLES);
  const genNumPart = partByType(gen, genMain, REL_NUMBERING);
  const genStyles = new Map<string, Element>();
  if (genStylesPart) for (const s of wEls(genStylesPart.doc, 'style')) genStyles.set(wAttr(s, 'styleId') ?? '', s);
  const genAbstract = new Map<string, Element>();
  const genNums = new Map<string, Element>();
  if (genNumPart) {
    for (const a of wEls(genNumPart.doc, 'abstractNum')) genAbstract.set(wAttr(a, 'abstractNumId') ?? '', a);
    for (const n of childEls(genNumPart.doc.documentElement, W, 'num')) genNums.set(wAttr(n, 'numId') ?? '', n);
  }
  const usedStyles = new Set<string>();
  const usedNums = new Set<string>();
  for (const el of content) {
    for (const name of ['pStyle', 'rStyle', 'tblStyle']) for (const s of wEls(el, name)) usedStyles.add(wAttr(s, 'val') ?? '');
    for (const n of wEls(el, 'numId')) usedNums.add(wAttr(n, 'val') ?? '');
  }
  // Close over styles' basedOn/next/link and lists' paragraph styles, until nothing new turns up.
  for (let size = -1; size !== usedStyles.size + usedNums.size; ) {
    size = usedStyles.size + usedNums.size;
    for (const id of [...usedStyles]) {
      const s = genStyles.get(id);
      if (!s) continue;
      for (const name of ['basedOn', 'next', 'link']) for (const r of childEls(s, W, name)) usedStyles.add(wAttr(r, 'val') ?? '');
      for (const n of wEls(s, 'numId')) usedNums.add(wAttr(n, 'val') ?? '');
    }
    for (const id of [...usedNums]) {
      const n = genNums.get(id);
      const absId = n && childEls(n, W, 'abstractNumId')[0];
      const abs = absId && genAbstract.get(wAttr(absId, 'val') ?? '');
      if (!abs) continue;
      for (const name of ['pStyle', 'numStyleLink', 'styleLink']) for (const s of wEls(abs, name)) usedStyles.add(wAttr(s, 'val') ?? '');
    }
  }
  usedStyles.delete('');
  usedNums.delete('');
  usedNums.delete('0'); // numId 0 means "not in a list"

  // ---- Lists: copy the generated definitions in under fresh ids.
  const numMap = new Map<string, string>();
  const listsToCopy = [...usedNums].filter((id) => genNums.has(id));
  if (listsToCopy.length && genNumPart) {
    let target = partByType(base, baseMain, REL_NUMBERING);
    if (!target) {
      const path = uniquePath(base, 'word/numbering.xml');
      target = { path, doc: emptyXml(`<w:numbering xmlns:w="${W}"/>`) };
      baseRels.add(REL_NUMBERING, relativeTarget(baseMain, path), false);
      ctx.baseCt.ensure(path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml');
    }
    const ndoc = target.doc;
    const root = ndoc.documentElement;
    carryNamespaces(root, genNumPart.doc.documentElement);
    let nextAbs = Math.max(-1, ...wEls(ndoc, 'abstractNum').map((a) => Number(wAttr(a, 'abstractNumId')) || 0)) + 1;
    let nextNum = Math.max(0, ...childEls(root, W, 'num').map((n) => Number(wAttr(n, 'numId')) || 0)) + 1;
    const absMap = new Map<string, string>();
    // Schema order: numPicBullet*, abstractNum*, num*, numIdMacAtCleanup?
    const cleanup = () => childEls(root, W, 'numIdMacAtCleanup')[0] ?? null;
    const absSlot = () => {
      const last = childEls(root, W, 'abstractNum').pop();
      return last ? last.nextSibling : (childEls(root, W, 'num')[0] ?? cleanup());
    };
    for (const id of listsToCopy) {
      const n = genNums.get(id)!;
      const absIdEl = childEls(n, W, 'abstractNumId')[0];
      const genAbsId = absIdEl ? (wAttr(absIdEl, 'val') ?? '') : '';
      if (genAbstract.has(genAbsId) && !absMap.has(genAbsId)) {
        const abs = ndoc.importNode(genAbstract.get(genAbsId)!, true) as Element;
        setWAttr(abs, 'abstractNumId', String(nextAbs));
        absMap.set(genAbsId, String(nextAbs++));
        for (const pic of wEls(abs, 'lvlPicBulletId')) pic.remove(); // picture bullets aren't copied
        root.insertBefore(abs, absSlot());
      }
      const num = ndoc.importNode(n, true) as Element;
      setWAttr(num, 'numId', String(nextNum));
      numMap.set(id, String(nextNum++));
      const newAbsIdEl = childEls(num, W, 'abstractNumId')[0];
      if (newAbsIdEl && absMap.has(genAbsId)) setWAttr(newAbsIdEl, 'val', absMap.get(genAbsId)!);
      root.insertBefore(num, cleanup());
    }
    base[target.path] = writeXml(ndoc);
  }
  const remapNums = (el: Element) => {
    for (const n of wEls(el, 'numId')) {
      const v = wAttr(n, 'val') ?? '';
      if (numMap.has(v)) setWAttr(n, 'val', numMap.get(v)!);
    }
  };
  content.forEach(remapNums);

  // ---- Styles: add the ones the base lacks (the base's own styles always win).
  if (usedStyles.size && genStylesPart) {
    const target = partByType(base, baseMain, REL_STYLES);
    if (!target) {
      // No styles at all in the stored file: bring the generated set across whole.
      const path = uniquePath(base, 'word/styles.xml');
      for (const s of wEls(genStylesPart.doc, 'style')) remapNums(s);
      base[path] = writeXml(genStylesPart.doc);
      baseRels.add(REL_STYLES, relativeTarget(baseMain, path), false);
      ctx.baseCt.ensure(path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml');
    } else {
      const sdoc = target.doc;
      const have = new Set(wEls(sdoc, 'style').map((s) => wAttr(s, 'styleId') ?? ''));
      let added = false;
      carryNamespaces(sdoc.documentElement, genStylesPart.doc.documentElement);
      for (const id of usedStyles) {
        if (have.has(id) || !genStyles.has(id)) continue;
        const s = sdoc.importNode(genStyles.get(id)!, true) as Element;
        remapNums(s);
        s.removeAttributeNS(W, 'default'); // the base keeps its own defaults
        sdoc.documentElement.appendChild(s);
        added = true;
      }
      if (added) base[target.path] = writeXml(sdoc);
    }
  }

  // ---- Footnotes/endnotes the new content refers to (rare: the editor has none of its own).
  for (const [kind, relType] of [
    ['footnote', REL_FOOTNOTES],
    ['endnote', REL_ENDNOTES],
  ] as const) {
    const refs = content.flatMap((el) => wEls(el, `${kind}Reference`));
    if (!refs.length) continue;
    const genPart = partByType(gen, genMain, relType);
    const genNotes = new Map(genPart ? wEls(genPart.doc, kind).map((f) => [wAttr(f, 'id') ?? '', f] as const) : []);
    let target = partByType(base, baseMain, relType);
    if (!genPart) {
      refs.forEach((r) => r.remove());
      continue;
    }
    if (!target) {
      const path = uniquePath(base, `word/${kind}s.xml`);
      target = { path, doc: emptyXml(`<w:${kind}s xmlns:w="${W}"/>`) };
      baseRels.add(relType, relativeTarget(baseMain, path), false);
      ctx.baseCt.ensure(path, ctx.genCt.typeOf(genPart.path) ?? `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml`);
      // Separator notes Word expects to find.
      for (const n of genNotes.values()) if (wAttr(n, 'type') && wAttr(n, 'type') !== 'normal') target.doc.documentElement.appendChild(target.doc.importNode(n, true));
    }
    const tdoc = target.doc;
    carryNamespaces(tdoc.documentElement, genPart.doc.documentElement);
    let next = Math.max(0, ...wEls(tdoc, kind).map((f) => Number(wAttr(f, 'id')) || 0)) + 1;
    const noteRels = new Rels(base, target.path);
    const genNoteRels = new Rels(gen, genPart.path);
    for (const ref of refs) {
      const note = genNotes.get(wAttr(ref, 'id') ?? '');
      if (!note) {
        ref.remove();
        continue;
      }
      const copy = tdoc.importNode(note, true) as Element;
      setWAttr(copy, 'id', String(next));
      setWAttr(ref, 'id', String(next++));
      remapRelationships(ctx, [copy], genNoteRels, noteRels);
      remapNums(copy);
      tdoc.documentElement.appendChild(copy);
    }
    if (noteRels.all().length) noteRels.save();
    base[target.path] = writeXml(tdoc);
  }

  // ---- Swap the body, keeping the stored file's closing section properties (headers, footers, columns…).
  const baseKids = [...baseBody.children];
  const baseLast = baseKids[baseKids.length - 1];
  let sect = baseLast && baseLast.namespaceURI === W && baseLast.localName === 'sectPr' ? baseLast : null;
  const oldIds = relIds(baseKids.filter((c) => c !== sect));
  const oldNums = new Set(baseKids.flatMap((c) => wEls(c, 'numId').map((n) => wAttr(n, 'val') ?? '')));
  while (baseBody.firstChild) baseBody.removeChild(baseBody.firstChild);
  for (const el of content) baseBody.appendChild(el);
  if (!sect && genSect) {
    sect = baseDoc.importNode(genSect, true) as Element;
    remapRelationships(ctx, [sect], genRels, baseRels);
  }
  if (sect) {
    if (page) applyPage(sect, page);
    baseBody.appendChild(sect);
  }

  // Pictures and links only the old text used go, so saving again and again doesn't pile up copies.
  const stillUsed = relIds([baseDoc.documentElement]);
  for (const rel of baseRels.all()) {
    const id = rel.getAttribute('Id') ?? '';
    if (!oldIds.has(id) || stillUsed.has(id) || !/\/(image|hyperlink)$/.test(rel.getAttribute('Type') ?? '')) continue;
    rel.remove();
    if (rel.getAttribute('TargetMode') === 'External') continue;
    const path = baseRels.targetPath(rel);
    const elsewhere = Object.keys(base).some((p) => p.endsWith('.rels') && p !== relsPathOf(baseMain) && new Rels(base, partOfRels(p)).all().some((r) => r.getAttribute('TargetMode') !== 'External' && resolveTarget(partOfRels(p), r.getAttribute('Target') ?? '') === path));
    if (elsewhere) continue;
    delete base[path];
    ctx.baseCt.forget(path);
  }

  // Likewise list definitions only the old text used.
  const numbering = oldNums.size ? partByType(base, baseMain, REL_NUMBERING) : null;
  if (numbering) {
    const used = new Set(wEls(baseDoc, 'numId').map((n) => wAttr(n, 'val') ?? ''));
    for (const [path, bytes] of Object.entries(base)) {
      if (path === baseMain || path === numbering.path || !/^word\/[^/]+\.xml$/i.test(path)) continue;
      for (const match of dec.decode(bytes).matchAll(/numId[^>]*?:val="(\d+)"/g)) used.add(match[1]);
    }
    const root = numbering.doc.documentElement;
    const dropped = new Set<string>();
    for (const num of childEls(root, W, 'num')) {
      const id = wAttr(num, 'numId') ?? '';
      if (!oldNums.has(id) || used.has(id)) continue;
      const abs = childEls(num, W, 'abstractNumId')[0];
      if (abs) dropped.add(wAttr(abs, 'val') ?? '');
      num.remove();
    }
    const stillUsedAbs = new Set(childEls(root, W, 'num').flatMap((n) => childEls(n, W, 'abstractNumId').map((a) => wAttr(a, 'val') ?? '')));
    for (const abs of childEls(root, W, 'abstractNum')) {
      const id = wAttr(abs, 'abstractNumId') ?? '';
      if (dropped.has(id) && !stillUsedAbs.has(id) && !childEls(abs, W, 'styleLink').length) abs.remove();
    }
    if (dropped.size) base[numbering.path] = writeXml(numbering.doc);
  }

  base[baseMain] = writeXml(baseDoc);
  if (baseRels.all().length) baseRels.save();
  ctx.baseCt.save();

  // Re-zip with [Content_Types].xml first, everything else in its original order.
  const out: Zippable = { '[Content_Types].xml': base['[Content_Types].xml'] };
  for (const [path, bytes] of Object.entries(base)) if (path !== '[Content_Types].xml') out[path] = bytes;
  const zipped = zipSync(out, { level: 6 });
  // Make sure what was made reads back.
  const check = unzipSync(zipped);
  for (const path of Object.keys(check)) if (/\.(xml|rels)$/i.test(path) && base[path] !== original[path]) parseXml(check[path], path);
  return zipped;
}

// ---------------------------------------------------------------------------------------------------
// What the stored file has that the editor doesn't show

export interface KeptReport {
  /** Everything in the file the editor doesn't show. */
  kept: string[];
  /** The subset that sits inside the text itself, so it can't keep its place once the text is edited. */
  lostOnEdit: string[];
}

export function inspectDocx(bytes: Uint8Array): KeptReport {
  const files: Files = unzipSync(bytes);
  const main = mainPart(files);
  const doc = parseXml(files[main], main);
  const paths = Object.keys(files);
  const find = (re: RegExp) => paths.find((p) => re.test(p));
  const count = (name: string) => wEls(doc, name).length;
  const kept: string[] = [];
  const lostOnEdit: string[] = [];
  const add = (label: string, inText = false) => {
    kept.push(label);
    if (inText) lostOnEdit.push(label);
  };
  const realNotes = (re: RegExp, kind: string) => {
    const path = find(re);
    return !!path && wEls(parseXml(files[path], path), kind).some((n) => !wAttr(n, 'type') || wAttr(n, 'type') === 'normal');
  };
  const comments = find(/^word\/comments\.xml$/i);

  if (find(/^word\/(header|footer)\d*\.xml$/i) || count('headerReference') + count('footerReference') > 0) add('Headers and footers');
  if (realNotes(/^word\/footnotes\.xml$/i, 'footnote')) add('Footnotes', true);
  if (realNotes(/^word\/endnotes\.xml$/i, 'endnote')) add('Endnotes', true);
  if (comments && wEls(parseXml(files[comments], comments), 'comment').length) add('Comments from Word', true);
  if (count('ins') + count('del') + count('moveFrom') + count('moveTo') + count('rPrChange') + count('pPrChange') > 0) add('Tracked changes', true);
  if (count('txbxContent') > 0) add('Text boxes', true);
  if (find(/^word\/charts\//i)) add('Charts', true);
  if (find(/^word\/diagrams\//i)) add('SmartArt diagrams', true);
  if (find(/^word\/embeddings\//i)) add('Embedded objects', true);
  if (doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'oMath').length) add('Equations', true);
  if (count('fldSimple') + count('instrText') > 0) add('Fields (page numbers, table of contents)', true);
  if (count('sdt') > 0) add('Content controls', true);
  if (count('ffData') > 0) add('Form fields', true);
  if (wEls(doc, 'pPr').some((p) => childEls(p, W, 'sectPr').length)) add('Section breaks with their own page layout', true);
  if (wEls(doc, 'bookmarkStart').some((b) => !(wAttr(b, 'name') ?? '_').startsWith('_'))) add('Bookmarks', true);
  if (doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'anchor').length) add('Floating pictures and shapes', true);
  if (childEls(doc.documentElement, W, 'background').length) add('Page background');
  if (find(/vbaProject\.bin$/i)) add('Macros');
  if (find(/^customXml\/item\d*\.xml$/i)) add('Custom data');
  return { kept, lostOnEdit };
}
