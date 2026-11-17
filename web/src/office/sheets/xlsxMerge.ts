import type { Cell, Sheet } from '@fortune-sheet/core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

// Saving a spreadsheet without losing what the editor can't show. Instead of replacing the stored
// .xlsx with a workbook rebuilt from the editor (which would drop charts, pivot tables, macros,
// conditional formatting, slicers…), the editor's workbook is merged into the stored file:
//  - a sheet that hasn't changed since the file was opened keeps its original XML untouched;
//  - a changed sheet gets the editor's cells, column widths, merged cells, links, frozen panes (and
//    pictures and notes when those changed), while everything else in it is kept;
//  - sheets added, removed, renamed, reordered or hidden in the editor are added, removed, renamed…
//    in the workbook; every other part of the file is copied as it was.
// The editor's styles are added to the file's own (reusing identical ones), so repeated saves don't grow it.

type Files = Record<string, Uint8Array>;

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const CP = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Where each editor sheet lives in the stored file, and how it looked when the file was opened. */
export interface SheetOrigin {
  part: string;
  content: string;
  images: string;
  notes: string;
}
export type Origins = Record<string, SheetOrigin>;

// ---------- fingerprints ----------

const CELL_KEYS = ['v', 'f', 'bl', 'it', 'cl', 'un', 'fs', 'ff', 'fc', 'bg', 'ht', 'vt', 'tb', 'tr'] as const;

function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

function cellsOf(sheet: Sheet): { r: number; c: number; v: Cell }[] {
  if (sheet.data?.length) {
    const out: { r: number; c: number; v: Cell }[] = [];
    sheet.data.forEach((row, r) => row?.forEach((v, c) => v && out.push({ r, c, v })));
    return out;
  }
  return (sheet.celldata ?? []).filter((x): x is { r: number; c: number; v: Cell } => !!x.v);
}

const nonEmpty = (o: Record<string, unknown> | undefined | null) => (o && Object.keys(o).length ? o : undefined);

/** What a sheet looks like, in three parts, ignoring what the editor adds on its own (selection, scroll…). */
export function sheetFingerprint(sheet: Sheet): Omit<SheetOrigin, 'part'> {
  const cells: unknown[] = [];
  const notes: unknown[] = [];
  for (const { r, c, v } of cellsOf(sheet).sort((a, b) => a.r - b.r || a.c - b.c)) {
    const out: Record<string, unknown> = {};
    for (const k of CELL_KEYS) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined && x !== null && x !== '' && !(k !== 'v' && (x === 0 || x === '0' || x === false))) out[k] = x;
    }
    if (v.ct?.fa && v.ct.fa !== 'General') out.fa = v.ct.fa;
    if (v.ct?.t === 'inlineStr' && Array.isArray(v.ct.s)) out.s = (v.ct.s as { v?: string }[]).map((x) => x.v ?? '').join('');
    if (v.mc) out.mc = v.mc.rs || v.mc.cs ? [v.mc.rs, v.mc.cs] : 1;
    if (Object.keys(out).length) cells.push([r, c, out]);
    if (v.ps?.value) notes.push([r, c, v.ps.value]);
  }
  const cfg = sheet.config ?? {};
  const content = {
    cells,
    merge: nonEmpty(cfg.merge as Record<string, unknown>),
    rowlen: nonEmpty(cfg.rowlen as Record<string, unknown>),
    columnlen: nonEmpty(cfg.columnlen as Record<string, unknown>),
    rowhidden: nonEmpty(cfg.rowhidden as Record<string, unknown>),
    colhidden: nonEmpty(cfg.colhidden as Record<string, unknown>),
    borders: cfg.borderInfo?.length ? cfg.borderInfo : undefined,
    links: nonEmpty(sheet.hyperlink as Record<string, unknown>),
    frozen: sheet.frozen ?? undefined,
    color: sheet.color || undefined,
    grid: sheet.showGridLines === 0 || sheet.showGridLines === false ? 0 : undefined,
  };
  const images = (sheet.images ?? []).map((i) => [i.src, Math.round(i.left), Math.round(i.top), Math.round(i.width), Math.round(i.height)]);
  return { content: hash(JSON.stringify(content)), images: hash(JSON.stringify(images)), notes: hash(JSON.stringify(notes)) };
}

// ---------- package helpers ----------

const parse = (bytes: Uint8Array) => new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
const serialize = (doc: Document) => {
  const xml = new XMLSerializer().serializeToString(doc);
  return strToU8(xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`);
};
const kids = (el: Element | null | undefined, name: string) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] ?? null;
const relType = (t: string) => t.slice(t.lastIndexOf('/') + 1);

function resolve(dir: string, target: string) {
  const parts = (target.startsWith('/') ? target.slice(1) : `${dir}/${target}`).split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '..') stack.pop();
    else if (p && p !== '.') stack.push(p);
  }
  return stack.join('/');
}

const relsPathOf = (part: string) => {
  const at = part.lastIndexOf('/');
  return `${part.slice(0, at)}/_rels/${part.slice(at + 1)}.rels`;
};

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
  el: Element;
}

class Pkg {
  private docs = new Map<string, Document>();
  constructor(readonly files: Files) {}

  has(path: string) {
    return path in this.files || this.docs.has(path);
  }
  xml(path: string): Document | null {
    if (this.docs.has(path)) return this.docs.get(path)!;
    const bytes = this.files[path];
    if (!bytes) return null;
    const doc = parse(bytes);
    this.docs.set(path, doc);
    return doc;
  }
  /** Marks a parsed part as changed (it's written back when the package is zipped). */
  touch(path: string, doc: Document) {
    this.docs.set(path, doc);
    this.files[path] = new Uint8Array(0);
  }
  remove(path: string) {
    delete this.files[path];
    this.docs.delete(path);
  }

  rels(part: string): Rel[] {
    const doc = this.xml(relsPathOf(part));
    if (!doc) return [];
    const dir = part.slice(0, part.lastIndexOf('/'));
    return [...doc.getElementsByTagNameNS(PR, 'Relationship')].map((el) => {
      const external = el.getAttribute('TargetMode') === 'External';
      const target = el.getAttribute('Target') ?? '';
      return { id: el.getAttribute('Id') ?? '', type: el.getAttribute('Type') ?? '', target: external ? target : resolve(dir, target), external, el };
    });
  }
  private relsDoc(part: string) {
    const path = relsPathOf(part);
    let doc = this.xml(path);
    if (!doc) {
      doc = new DOMParser().parseFromString(`<Relationships xmlns="${PR}"/>`, 'application/xml');
      this.contentTypes().ensureDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml');
    }
    this.touch(path, doc);
    return doc;
  }
  addRel(part: string, type: string, target: string, external = false) {
    const doc = this.relsDoc(part);
    const used = new Set([...doc.getElementsByTagNameNS(PR, 'Relationship')].map((e) => e.getAttribute('Id')));
    let n = used.size + 1;
    while (used.has(`rId${n}`)) n++;
    const el = doc.createElementNS(PR, 'Relationship');
    el.setAttribute('Id', `rId${n}`);
    el.setAttribute('Type', type);
    el.setAttribute('Target', external ? target : `/${target}`);
    if (external) el.setAttribute('TargetMode', 'External');
    doc.documentElement.appendChild(el);
    return `rId${n}`;
  }
  removeRel(part: string, id: string) {
    const doc = this.relsDoc(part);
    for (const el of [...doc.getElementsByTagNameNS(PR, 'Relationship')]) if (el.getAttribute('Id') === id) el.remove();
  }

  contentTypes() {
    const doc = this.xml('[Content_Types].xml')!;
    const self = this;
    return {
      typeOf(path: string): string | null {
        for (const o of doc.getElementsByTagNameNS(CT, 'Override')) if (o.getAttribute('PartName') === `/${path}`) return o.getAttribute('ContentType');
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        for (const d of doc.getElementsByTagNameNS(CT, 'Default')) if (d.getAttribute('Extension')?.toLowerCase() === ext) return d.getAttribute('ContentType');
        return null;
      },
      setOverride(path: string, type: string) {
        this.removeOverride(path);
        const el = doc.createElementNS(CT, 'Override');
        el.setAttribute('PartName', `/${path}`);
        el.setAttribute('ContentType', type);
        doc.documentElement.appendChild(el);
        self.touch('[Content_Types].xml', doc);
      },
      removeOverride(path: string) {
        for (const o of [...doc.getElementsByTagNameNS(CT, 'Override')]) if (o.getAttribute('PartName') === `/${path}`) o.remove();
        self.touch('[Content_Types].xml', doc);
      },
      ensureDefault(ext: string, type: string) {
        for (const d of doc.getElementsByTagNameNS(CT, 'Default')) if (d.getAttribute('Extension')?.toLowerCase() === ext.toLowerCase()) return;
        const el = doc.createElementNS(CT, 'Default');
        el.setAttribute('Extension', ext);
        el.setAttribute('ContentType', type);
        doc.documentElement.insertBefore(el, doc.documentElement.firstChild);
        self.touch('[Content_Types].xml', doc);
      },
    };
  }

  /** A part name not used yet: `xl/media/image` + `png` → xl/media/image3.png. */
  freePath(stem: string, ext: string) {
    for (let n = 1; ; n++) if (!this.has(`${stem}${n}.${ext}`)) return `${stem}${n}.${ext}`;
  }

  zip(): Uint8Array {
    for (const [path, doc] of this.docs) if (path in this.files) this.files[path] = serialize(doc);
    return zipSync(this.files, { level: 6 });
  }
}

/** Copies a part of the generated workbook (and the parts it points to) into the stored one; returns its new name. */
function copyPart(gen: Pkg, base: Pkg, from: string): string {
  const dot = from.lastIndexOf('.');
  const stem = from.slice(0, dot).replace(/\d+$/, '');
  const ext = from.slice(dot + 1);
  const to = base.freePath(stem, ext);
  const type = gen.contentTypes().typeOf(from);
  base.files[to] = gen.files[from];
  const genCT = gen.xml('[Content_Types].xml')!;
  const isOverride = [...genCT.getElementsByTagNameNS(CT, 'Override')].some((o) => o.getAttribute('PartName') === `/${from}`);
  if (type && isOverride) base.contentTypes().setOverride(to, type);
  else if (type) base.contentTypes().ensureDefault(ext, type);
  const rels = gen.rels(from);
  if (rels.length) {
    // The copy's own relationships, pointing at copies of their targets, under the same ids.
    const doc = new DOMParser().parseFromString(`<Relationships xmlns="${PR}"/>`, 'application/xml');
    for (const rel of rels) {
      const el = doc.createElementNS(PR, 'Relationship');
      el.setAttribute('Id', rel.id);
      el.setAttribute('Type', rel.type);
      if (rel.external) {
        el.setAttribute('Target', rel.target);
        el.setAttribute('TargetMode', 'External');
      } else el.setAttribute('Target', `/${gen.has(rel.target) ? copyPart(gen, base, rel.target) : rel.target}`);
      doc.documentElement.appendChild(el);
    }
    base.touch(relsPathOf(to), doc);
  }
  return to;
}

// ---------- styles ----------

/** A canonical form of an element, so identical styles written by different programs compare equal. */
function canon(el: Element): string {
  const attrs = [...el.attributes].filter((a) => a.name !== 'xmlns' && !a.name.startsWith('xmlns:')).map((a) => `${a.localName}=${a.value}`).sort();
  return `<${el.localName} ${attrs.join(' ')}>${[...el.children].map(canon).sort().join('')}</${el.localName}>`;
}

const STYLE_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst'];

function section(doc: Document, name: string) {
  const root = doc.documentElement;
  let el = kid(root, name);
  if (!el) {
    el = doc.createElementNS(root.namespaceURI ?? S, name);
    insertOrdered(root, el, STYLE_ORDER);
  }
  return el;
}

/** Adds the generated workbook's cell styles to the stored workbook's; returns old index → new index. */
function mergeStyles(base: Pkg, basePath: string, gen: Pkg, genPath: string): Map<number, number> {
  const bd = base.xml(basePath)!;
  const gd = gen.xml(genPath)!;
  const out = new Map<number, number>();

  // Number formats: built-in ids (< 164) are the same everywhere; custom ones are matched by their code.
  const bFmts = section(bd, 'numFmts');
  const fmtMap = new Map<string, string>();
  let nextFmt = Math.max(163, ...kids(bFmts, 'numFmt').map((n) => Number(n.getAttribute('numFmtId')) || 0)) + 1;
  for (const n of kids(kid(gd.documentElement, 'numFmts'), 'numFmt')) {
    const id = n.getAttribute('numFmtId') ?? '0';
    const code = n.getAttribute('formatCode') ?? '';
    const same = kids(bFmts, 'numFmt').find((b) => b.getAttribute('formatCode') === code);
    if (same) fmtMap.set(id, same.getAttribute('numFmtId')!);
    else {
      const copy = bd.importNode(n, true) as Element;
      copy.setAttribute('numFmtId', String(nextFmt));
      bFmts.appendChild(copy);
      fmtMap.set(id, String(nextFmt++));
    }
  }
  if (kids(bFmts, 'numFmt').length) bFmts.setAttribute('count', String(kids(bFmts, 'numFmt').length));
  else bFmts.remove();

  const mergeList = (name: string, item: string) => {
    const b = section(bd, name);
    const index = new Map(kids(b, item).map((el, i) => [canon(el), i]));
    const map: number[] = [];
    for (const el of kids(kid(gd.documentElement, name), item)) {
      const key = canon(el);
      let i = index.get(key);
      if (i === undefined) {
        b.appendChild(bd.importNode(el, true));
        i = kids(b, item).length - 1;
        index.set(key, i);
      }
      map.push(i);
    }
    b.setAttribute('count', String(kids(b, item).length));
    return map;
  };
  const fonts = mergeList('fonts', 'font');
  const fills = mergeList('fills', 'fill');
  const borders = mergeList('borders', 'border');

  const bXfs = section(bd, 'cellXfs');
  const index = new Map(kids(bXfs, 'xf').map((el, i) => [canon(el), i]));
  kids(kid(gd.documentElement, 'cellXfs'), 'xf').forEach((xf, gi) => {
    const copy = bd.importNode(xf, true) as Element;
    const remap = (attr: string, map: number[]) => {
      const v = copy.getAttribute(attr);
      if (v !== null) copy.setAttribute(attr, String(map[Number(v)] ?? 0));
    };
    remap('fontId', fonts);
    remap('fillId', fills);
    remap('borderId', borders);
    const fmt = copy.getAttribute('numFmtId');
    if (fmt !== null && Number(fmt) >= 164) copy.setAttribute('numFmtId', fmtMap.get(fmt) ?? '0');
    copy.setAttribute('xfId', '0');
    const key = canon(copy);
    let i = index.get(key);
    if (i === undefined) {
      bXfs.appendChild(copy);
      i = kids(bXfs, 'xf').length - 1;
      index.set(key, i);
    }
    out.set(gi, i);
  });
  bXfs.setAttribute('count', String(kids(bXfs, 'xf').length));
  base.touch(basePath, bd);
  return out;
}

// ---------- sheets ----------

/** The order elements must appear in inside <worksheet> (Excel refuses files that get it wrong). */
const SHEET_ORDER = [
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges',
  'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting',
  'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture',
  'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst',
];
const WORKBOOK_ORDER = [
  'fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences',
  'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing',
  'fileRecoveryPr', 'webPublishObjects', 'extLst',
];

function insertOrdered(parent: Element, el: Element, order: string[]) {
  const at = order.indexOf(el.localName);
  const next = [...parent.children].find((c) => c !== el && order.indexOf(c.localName) > at);
  parent.insertBefore(el, next ?? null);
}

/** Replaces (or removes) the element `name` of `target` with the one in `source`. */
function replaceChild(target: Element, source: Element, name: string, order: string[]) {
  const doc = target.ownerDocument;
  for (const old of kids(target, name)) old.remove();
  for (const el of kids(source, name)) insertOrdered(target, doc.importNode(el, true) as Element, order);
}

/** Cell text from the generated workbook's shared strings, as inline strings (so the stored file's list stays as it was). */
function inlineStrings(sheetData: Element, sst: Element[]) {
  const doc = sheetData.ownerDocument;
  for (const c of [...sheetData.getElementsByTagNameNS('*', 'c')]) {
    if (c.getAttribute('t') !== 's') continue;
    const v = kid(c, 'v');
    const si = sst[Number(v?.textContent ?? -1)];
    if (!v || !si) continue;
    const is = doc.createElementNS(sheetData.namespaceURI ?? S, 'is');
    for (const child of [...si.children]) is.appendChild(doc.importNode(child, true));
    v.remove();
    c.appendChild(is);
    c.setAttribute('t', 'inlineStr');
  }
}

/** The stored sheet's cells by address. */
function baseCells(sheetData: Element | null) {
  const out = new Map<string, Element>();
  if (!sheetData) return out;
  for (const c of sheetData.getElementsByTagNameNS('*', 'c')) out.set(c.getAttribute('r') ?? '', c);
  return out;
}

const textOf = (el: Element | null) => (el ? [...el.getElementsByTagNameNS('*', 't')].map((t) => t.textContent ?? '').join('') : '');

/**
 * Keeps details of unchanged cells that the editor can't hold: array and data-table formulas (and the
 * dynamic-array markers Excel 365 adds), and text with mixed formatting inside one cell.
 */
function keepCellDetails(genData: Element, base: Map<string, Element>, baseSst: Element[]) {
  const doc = genData.ownerDocument;
  for (const c of [...genData.getElementsByTagNameNS('*', 'c')]) {
    const old = base.get(c.getAttribute('r') ?? '');
    if (!old) continue;
    const f = kid(c, 'f');
    const oldF = kid(old, 'f');
    if (f && oldF && (oldF.getAttribute('t') === 'array' || oldF.getAttribute('t') === 'dataTable') && (f.textContent ?? '').trim() === (oldF.textContent ?? '').trim()) {
      for (const a of ['t', 'ref', 'aca', 'dt2D', 'dtr', 'del1', 'del2', 'r1', 'r2', 'ca']) {
        const v = oldF.getAttribute(a);
        if (v !== null) f.setAttribute(a, v);
      }
      for (const a of ['cm', 'vm']) {
        const v = old.getAttribute(a);
        if (v !== null) c.setAttribute(a, v);
      }
      continue;
    }
    if (f || oldF) continue;
    // Rich text: the same words as before → the original runs.
    const oldSi = old.getAttribute('t') === 's' ? baseSst[Number(kid(old, 'v')?.textContent ?? -1)] : old.getAttribute('t') === 'inlineStr' ? kid(old, 'is') : null;
    if (!oldSi || !kids(oldSi, 'r').length) continue;
    const now = c.getAttribute('t') === 'inlineStr' ? textOf(kid(c, 'is')) : c.getAttribute('t') === 'str' ? (kid(c, 'v')?.textContent ?? '') : null;
    if (now === null || now !== textOf(oldSi)) continue;
    for (const ch of [...c.children]) if (ch.localName === 'is' || ch.localName === 'v') ch.remove();
    const is = doc.createElementNS(genData.namespaceURI ?? S, 'is');
    for (const child of [...oldSi.children]) is.appendChild(doc.importNode(child, true));
    c.appendChild(is);
    c.setAttribute('t', 'inlineStr');
  }
}

function remapStyles(root: Element, xf: Map<number, number>) {
  for (const el of root.getElementsByTagNameNS('*', 'c')) {
    const s = el.getAttribute('s');
    if (s !== null) el.setAttribute('s', String(xf.get(Number(s)) ?? 0));
  }
  for (const el of root.getElementsByTagNameNS('*', 'row')) {
    const s = el.getAttribute('s');
    if (s !== null) el.setAttribute('s', String(xf.get(Number(s)) ?? 0));
  }
  for (const el of root.getElementsByTagNameNS('*', 'col')) {
    const s = el.getAttribute('style');
    if (s !== null) el.setAttribute('style', String(xf.get(Number(s)) ?? 0));
  }
}

function sharedStrings(pkg: Pkg, workbookPath: string): Element[] {
  const rel = pkg.rels(workbookPath).find((r) => relType(r.type) === 'sharedStrings');
  const doc = rel && pkg.xml(rel.target);
  return doc ? kids(doc.documentElement, 'si') : [];
}

interface Ctx {
  base: Pkg;
  gen: Pkg;
  xf: () => Map<number, number>;
  baseSst: Element[];
  genSst: Element[];
}

/** Brings the editor's version of one sheet into the stored sheet part `basePath`. */
function patchSheet(ctx: Ctx, basePath: string, genPath: string, change: { images: boolean; notes: boolean }) {
  const { base, gen } = ctx;
  const bd = base.xml(basePath)!;
  const gd = gen.xml(genPath)!;
  const b = bd.documentElement;
  const g = gd.documentElement;

  const genData = kid(g, 'sheetData');
  if (genData) {
    inlineStrings(genData, ctx.genSst);
    keepCellDetails(genData, baseCells(kid(b, 'sheetData')), ctx.baseSst);
  }
  remapStyles(g, ctx.xf());
  for (const name of ['dimension', 'cols', 'sheetData', 'mergeCells']) replaceChild(b, g, name, SHEET_ORDER);

  // Tab colour, frozen panes and gridlines.
  const gPr = kid(g, 'sheetPr');
  let bPr = kid(b, 'sheetPr');
  const tab = kid(gPr, 'tabColor');
  if (tab || bPr) {
    if (!bPr) {
      bPr = bd.createElementNS(b.namespaceURI ?? S, 'sheetPr');
      insertOrdered(b, bPr, SHEET_ORDER);
    }
    for (const old of kids(bPr, 'tabColor')) old.remove();
    if (tab) bPr.insertBefore(bd.importNode(tab, true), bPr.firstChild);
  }
  const gView = kid(kid(g, 'sheetViews'), 'sheetView');
  let bViews = kid(b, 'sheetViews');
  if (!bViews) {
    bViews = bd.createElementNS(b.namespaceURI ?? S, 'sheetViews');
    insertOrdered(b, bViews, SHEET_ORDER);
  }
  let bView = kid(bViews, 'sheetView');
  if (!bView) {
    bView = bd.createElementNS(b.namespaceURI ?? S, 'sheetView');
    bView.setAttribute('workbookViewId', '0');
    bViews.appendChild(bView);
  }
  for (const old of kids(bView, 'pane')) old.remove();
  const pane = kid(gView, 'pane');
  if (pane) bView.insertBefore(bd.importNode(pane, true), bView.firstChild);
  if (gView?.getAttribute('showGridLines') === '0') bView.setAttribute('showGridLines', '0');
  else bView.removeAttribute('showGridLines');

  // Links: the stored ones are replaced by the editor's.
  const baseRels = base.rels(basePath);
  for (const rel of baseRels) if (relType(rel.type) === 'hyperlink') base.removeRel(basePath, rel.id);
  for (const old of kids(b, 'hyperlinks')) old.remove();
  const gLinks = kid(g, 'hyperlinks');
  const genRels = new Map(gen.rels(genPath).map((r) => [r.id, r]));
  if (gLinks) {
    const links = bd.importNode(gLinks, true) as Element;
    for (const h of kids(links, 'hyperlink')) {
      const id = h.getAttributeNS(R, 'id');
      const rel = id ? genRels.get(id) : undefined;
      if (rel) h.setAttributeNS(R, 'r:id', base.addRel(basePath, rel.type, rel.target, rel.external));
    }
    insertOrdered(b, links, SHEET_ORDER);
  }

  // Pictures: the stored drawing keeps its charts and shapes; its pictures are replaced by the editor's.
  if (change.images) {
    const gDrawingRel = (() => {
      const id = kid(g, 'drawing')?.getAttributeNS(R, 'id');
      return id ? genRels.get(id) : undefined;
    })();
    const bDrawing = kid(b, 'drawing');
    const bDrawingRel = bDrawing ? baseRels.find((r) => r.id === bDrawing.getAttributeNS(R, 'id')) : undefined;
    if (bDrawingRel && base.has(bDrawingRel.target)) {
      const dd = base.xml(bDrawingRel.target)!;
      for (const anchor of [...dd.documentElement.children]) if (anchor.getElementsByTagNameNS('*', 'pic').length) anchor.remove();
      if (gDrawingRel) {
        const gdd = gen.xml(gDrawingRel.target)!;
        const gdRels = new Map(gen.rels(gDrawingRel.target).map((r) => [r.id, r]));
        for (const anchor of [...gdd.documentElement.children]) {
          const copy = dd.importNode(anchor, true) as Element;
          for (const blip of copy.getElementsByTagNameNS('*', 'blip')) {
            const id = blip.getAttributeNS(R, 'embed');
            const rel = id ? gdRels.get(id) : undefined;
            if (rel) blip.setAttributeNS(R, 'r:embed', base.addRel(bDrawingRel.target, rel.type, copyPart(gen, base, rel.target)));
          }
          dd.documentElement.appendChild(copy);
        }
      }
      base.touch(bDrawingRel.target, dd);
    } else if (gDrawingRel) {
      const part = copyPart(gen, base, gDrawingRel.target);
      for (const old of kids(b, 'drawing')) old.remove();
      const el = bd.createElementNS(b.namespaceURI ?? S, 'drawing');
      el.setAttributeNS(R, 'r:id', base.addRel(basePath, gDrawingRel.type, part));
      insertOrdered(b, el, SHEET_ORDER);
    }
  }

  // Notes: replaced as a whole when they changed (threaded replies, which the editor doesn't keep, go too).
  if (change.notes) {
    for (const rel of baseRels) {
      const t = relType(rel.type);
      if (t === 'comments' || t === 'threadedComment' || (t === 'vmlDrawing' && kid(b, 'legacyDrawing')?.getAttributeNS(R, 'id') === rel.id)) base.removeRel(basePath, rel.id);
    }
    for (const old of kids(b, 'legacyDrawing')) old.remove();
    for (const rel of genRels.values()) {
      const t = relType(rel.type);
      if (t === 'comments') base.addRel(basePath, rel.type, copyPart(gen, base, rel.target));
      if (t === 'vmlDrawing') {
        const el = bd.createElementNS(b.namespaceURI ?? S, 'legacyDrawing');
        el.setAttributeNS(R, 'r:id', base.addRel(basePath, rel.type, copyPart(gen, base, rel.target)));
        insertOrdered(b, el, SHEET_ORDER);
      }
    }
  }
  base.touch(basePath, bd);
}

// ---------- workbook ----------

function workbookPath(pkg: Pkg) {
  const doc = pkg.xml('_rels/.rels');
  const off = doc && [...doc.getElementsByTagNameNS(PR, 'Relationship')].find((r) => relType(r.getAttribute('Type') ?? '') === 'officeDocument');
  return off ? resolve('', off.getAttribute('Target') ?? 'xl/workbook.xml') : 'xl/workbook.xml';
}

/** The workbook's sheets in order: name, part, element. */
function sheetList(pkg: Pkg, wbPath: string) {
  const wb = pkg.xml(wbPath)!;
  const rels = new Map(pkg.rels(wbPath).map((r) => [r.id, r]));
  return kids(kid(wb.documentElement, 'sheets'), 'sheet').map((el) => {
    const rel = rels.get(el.getAttributeNS(R, 'id') ?? '');
    return { name: el.getAttribute('name') ?? '', part: rel?.target ?? '', type: relType(rel?.type ?? ''), el };
  });
}

/** Where each sheet of a stored .xlsx is, by sheet name (for files opened before origins were recorded). */
export function sheetParts(data: ArrayBuffer): Map<string, string> {
  const pkg = new Pkg(unzipSync(new Uint8Array(data)));
  return new Map(sheetList(pkg, workbookPath(pkg)).filter((s) => s.type === 'worksheet').map((s) => [s.name, s.part]));
}

const SHEET_IDS = 'AtriumSheets';

/** The sheet-id → part map saved inside a file by an earlier save. */
function savedIds(pkg: Pkg): Record<string, string> {
  const root = pkg.xml('_rels/.rels');
  const rel = root ? [...root.getElementsByTagNameNS(PR, 'Relationship')].find((r) => relType(r.getAttribute('Type') ?? '') === 'custom-properties') : undefined;
  const doc = rel && pkg.xml(resolve('', rel.getAttribute('Target') ?? ''));
  const prop = doc && [...doc.getElementsByTagNameNS(CP, 'property')].find((p) => p.getAttribute('name') === SHEET_IDS);
  try {
    return prop ? JSON.parse(prop.textContent ?? '{}') : {};
  } catch {
    return {};
  }
}

function saveIds(pkg: Pkg, ids: Record<string, string>) {
  const rootRels = pkg.xml('_rels/.rels')!;
  let rel = [...rootRels.getElementsByTagNameNS(PR, 'Relationship')].find((r) => relType(r.getAttribute('Type') ?? '') === 'custom-properties');
  let path: string;
  if (rel) path = resolve('', rel.getAttribute('Target') ?? '');
  else {
    path = 'docProps/custom.xml';
    if (pkg.has(path)) path = pkg.freePath('docProps/custom', 'xml');
    pkg.touch(path, new DOMParser().parseFromString(`<Properties xmlns="${CP}" xmlns:vt="${VT}"/>`, 'application/xml'));
    pkg.contentTypes().setOverride(path, 'application/vnd.openxmlformats-officedocument.custom-properties+xml');
    rel = rootRels.createElementNS(PR, 'Relationship');
    const used = new Set([...rootRels.getElementsByTagNameNS(PR, 'Relationship')].map((e) => e.getAttribute('Id')));
    let n = used.size + 1;
    while (used.has(`rId${n}`)) n++;
    rel.setAttribute('Id', `rId${n}`);
    rel.setAttribute('Type', `${REL_BASE}/custom-properties`);
    rel.setAttribute('Target', path);
    rootRels.documentElement.appendChild(rel);
    pkg.touch('_rels/.rels', rootRels);
  }
  const doc = pkg.xml(path)!;
  const root = doc.documentElement;
  let prop = [...doc.getElementsByTagNameNS(CP, 'property')].find((p) => p.getAttribute('name') === SHEET_IDS);
  if (!prop) {
    const props = [...doc.getElementsByTagNameNS(CP, 'property')];
    const pid = Math.max(1, ...props.map((p) => Number(p.getAttribute('pid')) || 0)) + 1;
    prop = doc.createElementNS(CP, 'property');
    prop.setAttribute('fmtid', '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}');
    prop.setAttribute('pid', String(pid));
    prop.setAttribute('name', SHEET_IDS);
    root.appendChild(prop);
  }
  while (prop.firstChild) prop.firstChild.remove();
  const v = doc.createElementNS(VT, 'vt:lpwstr');
  v.textContent = JSON.stringify(ids);
  prop.appendChild(v);
  pkg.touch(path, doc);
}

/**
 * The editor's workbook merged into the stored file. `generated` is the editor's workbook as written by
 * sheetsToXlsx (same sheet names); `origins` says where each sheet came from and how it looked then.
 */
export function mergeIntoStored(stored: ArrayBuffer, generated: ArrayBuffer, sheets: Sheet[], origins: Origins): Uint8Array {
  const base = new Pkg(unzipSync(new Uint8Array(stored)));
  const gen = new Pkg(unzipSync(new Uint8Array(generated)));
  const wbPath = workbookPath(base);
  const genWbPath = workbookPath(gen);
  const wb = base.xml(wbPath)!;
  const baseList = sheetList(base, wbPath);
  const genParts = new Map(sheetList(gen, genWbPath).map((s) => [s.name, s.part]));
  const ids = savedIds(base);

  const stylesRel = base.rels(wbPath).find((r) => relType(r.type) === 'styles');
  const genStylesRel = gen.rels(genWbPath).find((r) => relType(r.type) === 'styles');
  let xf: Map<number, number> | null = null;
  const ctx: Ctx = {
    base,
    gen,
    baseSst: sharedStrings(base, wbPath),
    genSst: sharedStrings(gen, genWbPath),
    xf: () => {
      if (!xf) {
        if (!stylesRel || !genStylesRel) throw new Error('No styles part');
        xf = mergeStyles(base, stylesRel.target, gen, genStylesRel.target);
      }
      return xf;
    },
  };

  const ordered = [...sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const byPart = new Map(baseList.map((s) => [s.part, s]));
  const used = new Set<string>();
  const finalIds: Record<string, string> = {};
  let patched = false;
  const sheetsEl = kid(wb.documentElement, 'sheets')!;
  const oldOrder = baseList.map((s) => s.el);
  const newEls: Element[] = [];

  for (const sheet of ordered) {
    const id = String(sheet.id);
    const genPart = genParts.get(sheet.name.slice(0, 31) || 'Sheet');
    const origin = origins[id];
    let part: string | undefined = ids[id] ?? origin?.part;
    if (!part || !byPart.has(part) || used.has(part)) part = baseList.find((s) => s.name === sheet.name && s.type === 'worksheet' && !used.has(s.part))?.part;
    const entry = part ? byPart.get(part) : undefined;
    if (entry && entry.type === 'worksheet') {
      used.add(entry.part);
      const now = sheetFingerprint(sheet);
      const same = origin && origin.part === entry.part && origin.content === now.content && origin.images === now.images && origin.notes === now.notes;
      if (!same && genPart) {
        patchSheet(ctx, entry.part, genPart, { images: !origin || origin.images !== now.images, notes: !origin || origin.notes !== now.notes });
        patched = true;
      }
      entry.el.setAttribute('name', sheet.name.slice(0, 31) || 'Sheet');
      if (sheet.hide) {
        if (entry.el.getAttribute('state') !== 'veryHidden') entry.el.setAttribute('state', 'hidden');
      } else entry.el.removeAttribute('state');
      newEls.push(entry.el);
      finalIds[id] = entry.part;
    } else if (genPart) {
      // A sheet made in the editor.
      const partPath = base.freePath('xl/worksheets/sheet', 'xml');
      base.files[partPath] = gen.files[genPart];
      base.contentTypes().setOverride(partPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
      // Its relationships (links, pictures, notes) come along, re-pointed at copies.
      const copyDoc = base.xml(partPath)!;
      const genRels = gen.rels(genPart);
      const ridMap = new Map<string, string>();
      for (const rel of genRels) ridMap.set(rel.id, base.addRel(partPath, rel.type, rel.external ? rel.target : copyPart(gen, base, rel.target), rel.external));
      for (const el of copyDoc.getElementsByTagName('*')) {
        for (const a of ['id', 'embed']) {
          const v = el.getAttributeNS(R, a);
          if (v && ridMap.has(v)) el.setAttributeNS(R, `r:${a}`, ridMap.get(v)!);
        }
      }
      const data = kid(copyDoc.documentElement, 'sheetData');
      if (data) inlineStrings(data, ctx.genSst);
      remapStyles(copyDoc.documentElement, ctx.xf());
      base.touch(partPath, copyDoc);
      const el = wb.createElementNS(sheetsEl.namespaceURI ?? S, 'sheet');
      el.setAttribute('name', sheet.name.slice(0, 31) || 'Sheet');
      const sheetIds = kids(sheetsEl, 'sheet').map((s) => Number(s.getAttribute('sheetId')) || 0);
      el.setAttribute('sheetId', String(Math.max(0, ...sheetIds, ...newEls.map((s) => Number(s.getAttribute('sheetId')) || 0)) + 1));
      if (sheet.hide) el.setAttribute('state', 'hidden');
      el.setAttributeNS(R, 'r:id', base.addRel(wbPath, `${REL_BASE}/worksheet`, partPath));
      newEls.push(el);
      finalIds[id] = partPath;
      patched = true;
    }
  }

  // Chart sheets and other kinds of sheet the editor doesn't show stay where they were relative to the others.
  for (const s of baseList) {
    if (s.type === 'worksheet' || newEls.includes(s.el)) continue;
    const i = oldOrder.indexOf(s.el);
    const after = oldOrder.slice(0, i).reverse().find((e) => newEls.includes(e));
    newEls.splice(after ? newEls.indexOf(after) + 1 : 0, 0, s.el);
  }

  // Sheets deleted in the editor.
  const removed = baseList.filter((s) => s.type === 'worksheet' && !used.has(s.part));
  for (const s of removed) {
    const id = s.el.getAttributeNS(R, 'id');
    if (id) base.removeRel(wbPath, id);
    base.remove(s.part);
    base.remove(relsPathOf(s.part));
    base.contentTypes().removeOverride(s.part);
    patched = true;
  }

  // New order. Names local to a sheet are numbered by position, so they follow their sheet.
  const reordered = newEls.length !== oldOrder.length || newEls.some((e, i) => e !== oldOrder[i]);
  if (reordered) {
    for (const el of kids(sheetsEl, 'sheet')) el.remove();
    for (const el of newEls) sheetsEl.appendChild(el);
    const names = kid(wb.documentElement, 'definedNames');
    for (const dn of kids(names, 'definedName')) {
      const local = dn.getAttribute('localSheetId');
      if (local === null) continue;
      const at = newEls.indexOf(oldOrder[Number(local)]);
      if (at < 0) dn.remove();
      else dn.setAttribute('localSheetId', String(at));
    }
    if (names && !kids(names, 'definedName').length) names.remove();
    for (const view of wb.getElementsByTagNameNS('*', 'workbookView')) {
      if (Number(view.getAttribute('activeTab') ?? 0) >= newEls.length) view.setAttribute('activeTab', '0');
      if (Number(view.getAttribute('firstSheet') ?? 0) >= newEls.length) view.setAttribute('firstSheet', '0');
    }
  }

  if (patched) {
    // The calculation chain lists formula cells by address; Excel rebuilds it, and works every formula out
    // again on opening (the editor's results can differ from Excel's in rare cases).
    for (const rel of base.rels(wbPath)) {
      if (relType(rel.type) !== 'calcChain') continue;
      base.removeRel(wbPath, rel.id);
      base.remove(rel.target);
      base.contentTypes().removeOverride(rel.target);
    }
    let calc = kid(wb.documentElement, 'calcPr');
    if (!calc) {
      calc = wb.createElementNS(wb.documentElement.namespaceURI ?? S, 'calcPr');
      insertOrdered(wb.documentElement, calc, WORKBOOK_ORDER);
    }
    calc.setAttribute('fullCalcOnLoad', '1');
  }
  base.touch(wbPath, wb);
  if (JSON.stringify(ids) !== JSON.stringify(finalIds)) saveIds(base, finalIds);
  return base.zip();
}

// ---------- what's kept but not shown ----------

/** Things in a stored .xlsx that the editor doesn't show (they stay in the file when it's saved). */
export function keptFeatures(data: ArrayBuffer): string[] {
  let files: Files;
  try {
    files = unzipSync(new Uint8Array(data));
  } catch {
    return [];
  }
  const names = Object.keys(files);
  const any = (re: RegExp) => names.some((n) => re.test(n));
  const inSheets = (re: RegExp) => names.some((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n) && re.test(strFromU8(files[n])));
  const out: string[] = [];
  if (any(/^xl\/charts\/chart/) || any(/^xl\/chartsheets\//)) out.push('Charts');
  if (any(/^xl\/pivotTables\//)) out.push('Pivot tables');
  if (any(/^xl\/slicers\//) || any(/^xl\/timelines\//)) out.push('Slicers and timelines');
  if (any(/^xl\/tables\//)) out.push('Formatted tables');
  if (inSheets(/<(\w+:)?conditionalFormatting[\s>]/)) out.push('Conditional formatting');
  if (inSheets(/<(\w+:)?dataValidations?[\s>]/)) out.push('Data validation and dropdown lists');
  if (inSheets(/sparklineGroup/)) out.push('Sparklines');
  if (any(/vbaProject\.bin$/)) out.push('Macros');
  if (any(/^xl\/threadedComments\//)) out.push('Comment replies');
  if (any(/^xl\/externalLinks\//)) out.push('Links to other workbooks');
  if (any(/^xl\/ctrlProps\//) || any(/^xl\/activeX\//)) out.push('Buttons and form controls');
  if (any(/^xl\/drawings\/drawing/) && names.some((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n) && /<(\w+:)?sp[\s>]/.test(strFromU8(files[n])))) out.push('Shapes and text boxes');
  if (inSheets(/<(\w+:)?autoFilter[\s>]/)) out.push('Filters');
  const workbook = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  if (inSheets(/<(\w+:)?sheetProtection[^>]*\ssheet="(1|true)"/) || /<(\w+:)?workbookProtection[^>]*\slock(Structure|Windows)="(1|true)"/.test(workbook)) out.push('Sheet protection');
  if (/<(\w+:)?definedName[\s>]/.test(workbook)) out.push('Named ranges');
  return out;
}
