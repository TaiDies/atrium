import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import * as Y from 'yjs';
import { type Deck, readDeck, readSlides, type Slide } from './model';

// Saving a .pptx without losing what the editor doesn't model.
//
// The editor only understands part of a PowerPoint file (text, shapes, pictures, tables, lines, notes),
// and PptxGenJS writes a brand-new file from that. Writing that file over the stored one would throw away
// masters, layouts, themes, transitions, animations, charts, SmartArt, media and so on. Instead the saved
// file is built from the *stored* file:
//
//  - Each slide imported from the file remembers which slide part it came from and a fingerprint of how it
//    looked when imported (the "pptxOrigin" map in the live document, shared by everyone).
//  - Slides that still match their fingerprint, and whose part in the stored file is still the imported
//    one byte for byte, are kept exactly as they are (XML, relationships, notes, media). Speaker notes and
//    "hidden" don't count: when only those changed, only the notes text and the slide's show flag change.
//  - Changed slides are rewritten in place (same part name, same slide id): the slide XML comes from
//    PptxGenJS, its pictures are copied in under new names, it keeps the original layout, transition and
//    timing (when the animations only refer to things carried over), its background when unchanged, its
//    notes slide (only the text is updated when it changed), and anything the editor doesn't show
//    (charts, SmartArt, OLE objects, ink, EMF/WMF pictures, comments) is carried over from the old part.
//  - New slides are added from PptxGenJS on the stored file's blank layout.
//  - Slides that are gone are removed, and every part that only they used is dropped.
//  - Everything else in the package is kept byte for byte.
//
// The origin map is written only at import, never at save. A changed slide keeps its part name, so its
// origin stays valid (it just no longer matches, so it's rebuilt from the editor at every save, carrying
// over what the previous save carried). A new slide has no origin, so every save adds it afresh, and the
// copy the previous save wrote, which no slide claims, is removed like any other unclaimed slide. So a
// failed or concurrent save can never make an edit look "unchanged".

type Files = Record<string, Uint8Array>;

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL_NS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_NOTES = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  webp: 'image/webp', emf: 'image/x-emf', wmf: 'image/x-wmf', mp4: 'video/mp4', m4v: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// ---------- fingerprints and the origin map ----------

export interface PptxOrigin {
  /** The slide part it was imported from, e.g. "ppt/slides/slide3.xml". */
  part: string;
  /** Fingerprint of the slide (and deck) as imported. */
  hash: string;
  /** The same without speaker notes and "hidden", which can change without rewriting the slide. */
  look?: string;
  /** Fingerprint of the slide part's bytes as imported. */
  partHash: string;
  /** Background as imported, to tell whether the original background can be kept. */
  bg: string;
}

function hashBytes(b: Uint8Array): string {
  let h1 = 0xdeadbeef ^ b.length;
  let h2 = 0x41c6ce57 ^ b.length;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 2654435761);
    h2 = Math.imul(h2 ^ b[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** JSON with object keys sorted, so the same content always gives the same text. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const slideFingerprint = (slide: Slide, deck: Deck) => hashBytes(strToU8(stableJson({ slide, w: deck.width, h: deck.height, t: deck.theme })));
const lookFingerprint = (slide: Slide, deck: Deck) => slideFingerprint({ ...slide, notes: '', hidden: false }, deck);
/** Fingerprint of a slide part's bytes, ignoring its "hidden" flag (which a save may set on a kept slide). */
const partFingerprint = (bytes: Uint8Array) => hashBytes(strToU8(strFromU8(bytes).replace(/^([\s\S]*?<(?:[\w-]+:)?sld\b[^>]*?)\sshow="(?:0|1|false|true)"/, '$1')));
const bgKey = (slide: Slide) => stableJson([slide.background, slide.backgroundImage]);

const ORIGIN_MAP = 'pptxOrigin';

/** At import: remembers which part of the file each slide came from (call once the slides are in the doc). */
export function recordOrigins(doc: Y.Doc, data: ArrayBuffer | Uint8Array, parts: string[]) {
  const files = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
  const slides = readSlides(doc.getArray<Y.Map<unknown>>('slides'));
  const deck = readDeck(doc.getMap<unknown>('deck'));
  const map = doc.getMap<string>(ORIGIN_MAP);
  doc.transact(() => {
    slides.forEach((s, i) => {
      const part = parts[i];
      if (!part || !files[part]) return;
      const origin: PptxOrigin = { part, hash: slideFingerprint(s, deck), look: lookFingerprint(s, deck), partHash: partFingerprint(files[part]), bg: bgKey(s) };
      map.set(s.id, JSON.stringify(origin));
    });
  });
}

export function readOrigins(doc: Y.Doc): Map<string, PptxOrigin> {
  const out = new Map<string, PptxOrigin>();
  doc.getMap<string>(ORIGIN_MAP).forEach((v, k) => {
    try {
      out.set(k, JSON.parse(v) as PptxOrigin);
    } catch {
      // A broken entry: that slide is treated as new.
    }
  });
  return out;
}

// ---------- package helpers ----------

function parseXml(bytes: Uint8Array, name: string) {
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`Could not read ${name}`);
  return doc;
}
const serialize = (doc: Document) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${new XMLSerializer().serializeToString(doc.documentElement)}`);
const kids = (el: Element | null | undefined, name: string) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] ?? null;
const desc = (el: Element | Document | null | undefined, name: string) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
const selfAndDesc = (el: Element) => [el, ...el.getElementsByTagNameNS('*', '*')];
const relAttr = (el: Element, name: string) => REL_NS.map((ns) => el.getAttributeNS(ns, name)).find((v) => v) ?? null;
const isRelAttr = (a: Attr) => REL_NS.includes(a.namespaceURI ?? '');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isRelsFile = (name: string) => /(^|\/)_rels\/[^/]+\.rels$/.test(name);

const dirOf = (part: string) => part.slice(0, Math.max(0, part.lastIndexOf('/')));
const relsPathOf = (part: string) => (part === '' ? '_rels/.rels' : `${dirOf(part) ? `${dirOf(part)}/` : ''}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`);
/** The part a rels file describes ('' for the package itself). */
function sourceOfRels(relsPath: string) {
  const m = /^(.*?)_rels\/([^/]*)\.rels$/.exec(relsPath);
  if (!m) return null;
  return m[2] === '' ? '' : `${m[1]}${m[2]}`;
}

function resolve(dir: string, target: string) {
  const parts = (target.startsWith('/') ? target.slice(1) : `${dir}/${target}`).split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '..') stack.pop();
    else if (p && p !== '.') stack.push(p);
  }
  return stack.join('/');
}

function relative(fromDir: string, to: string) {
  const a = fromDir ? fromDir.split('/') : [];
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** The part it points at (internal relationships only). */
  abs: string | null;
}

function readRels(files: Files, part: string): Rel[] {
  const path = relsPathOf(part);
  const bytes = files[path];
  if (!bytes) return [];
  return desc(parseXml(bytes, path), 'Relationship').map((r) => {
    const external = r.getAttribute('TargetMode') === 'External';
    const target = r.getAttribute('Target') ?? '';
    return { id: r.getAttribute('Id') ?? '', type: r.getAttribute('Type') ?? '', target, external, abs: external ? null : resolve(dirOf(part), target) };
  });
}

const writeRels = (rels: Rel[]) =>
  strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PKG_REL_NS}">${rels
      .map((r) => `<Relationship Id="${escAttr(r.id)}" Type="${escAttr(r.type)}" Target="${escAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
      .join('')}</Relationships>`,
  );

const isType = (r: Rel, name: string) => r.type.endsWith(`/${name}`);
const internalRel = (id: string, type: string, fromDir: string, to: string): Rel => ({ id, type: REL_TYPE + type, target: relative(fromDir, to), external: false, abs: to });

/** Hands out ids that aren't used yet ("rId7", "rId8", ...). */
function idAllocator(used: Iterable<string>) {
  const taken = new Set(used);
  let n = 0;
  for (const id of taken) {
    const m = /(\d+)$/.exec(id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return () => {
    let id: string;
    do id = `rId${++n}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
}

/** [Content_Types].xml, edited in place. */
class ContentTypes {
  doc: Document;
  changed = false;
  constructor(bytes: Uint8Array) {
    this.doc = parseXml(bytes, '[Content_Types].xml');
  }
  private get root() {
    return this.doc.documentElement;
  }
  private overrideEls(part: string) {
    return kids(this.root, 'Override').filter((o) => o.getAttribute('PartName')?.toLowerCase() === `/${part}`.toLowerCase());
  }
  override(part: string) {
    return this.overrideEls(part)[0]?.getAttribute('ContentType') ?? null;
  }
  defaultFor(ext: string) {
    return kids(this.root, 'Default').find((d) => d.getAttribute('Extension')?.toLowerCase() === ext.toLowerCase())?.getAttribute('ContentType') ?? null;
  }
  setOverride(part: string, type: string) {
    if (this.override(part) === type) return;
    this.removeOverride(part);
    const el = this.doc.createElementNS(this.root.namespaceURI, 'Override');
    el.setAttribute('PartName', `/${part}`);
    el.setAttribute('ContentType', type);
    this.root.appendChild(el);
    this.changed = true;
  }
  removeOverride(part: string) {
    for (const o of this.overrideEls(part)) {
      o.remove();
      this.changed = true;
    }
  }
  ensureDefault(ext: string, type: string) {
    if (this.defaultFor(ext)) return;
    const el = this.doc.createElementNS(this.root.namespaceURI, 'Default');
    el.setAttribute('Extension', ext);
    el.setAttribute('ContentType', type);
    this.root.insertBefore(el, kids(this.root, 'Override')[0] ?? null);
    this.changed = true;
  }
}

/** The parts that can be reached by following relationships from the package root. */
function reachable(files: Files): Set<string> {
  const seen = new Set<string>();
  const queue = [''];
  while (queue.length) {
    const part = queue.shift()!;
    let rels: Rel[];
    try {
      rels = readRels(files, part);
    } catch {
      rels = [];
    }
    for (const r of rels) {
      if (!r.abs || seen.has(r.abs) || !files[r.abs]) continue;
      seen.add(r.abs);
      queue.push(r.abs);
    }
  }
  return seen;
}

const notesBody = (doc: Document) =>
  desc(doc, 'sp').find((sp) => {
    const ph = desc(sp, 'ph')[0];
    return ph && (ph.getAttribute('type') ?? 'body') === 'body';
  }) ?? null;

/** Speaker notes text, read the same way the importer reads it. */
function notesTextOf(doc: Document) {
  const sp = notesBody(doc);
  if (!sp) return null;
  return kids(kid(sp, 'txBody'), 'p')
    .map((p) => desc(p, 't').map((t) => t.textContent).join(''))
    .join('\n')
    .trim();
}

/** Replaces the text of a notes slide's body, keeping the formatting of its first paragraph and run. */
function setNotesText(doc: Document, text: string): boolean {
  const body = kid(notesBody(doc), 'txBody');
  if (!body) return false;
  const paras = kids(body, 'p');
  const first = paras[0] ?? null;
  const pPr = kid(first, 'pPr');
  const rPr = kid(first ? (kids(first, 'r')[0] ?? null) : null, 'rPr');
  const endPr = kid(first, 'endParaRPr');
  const ns = first?.namespaceURI ?? A_NS;
  const prefix = first ? first.prefix : (body.lookupPrefix(A_NS) ?? 'a');
  const make = (name: string) => doc.createElementNS(ns, prefix ? `${prefix}:${name}` : name);
  for (const p of paras) p.remove();
  for (const line of text.split('\n')) {
    const p = make('p');
    if (pPr) p.appendChild(pPr.cloneNode(true));
    if (line) {
      const r = make('r');
      if (rPr) r.appendChild(rPr.cloneNode(true));
      const t = make('t');
      t.textContent = line;
      r.appendChild(t);
      p.appendChild(r);
    }
    if (endPr) p.appendChild(endPr.cloneNode(true));
    body.appendChild(p);
  }
  return true;
}

// ---------- the merge ----------

/**
 * The .pptx to save: the stored file (`base`) with the editor's slides merged in (see the top of this
 * file). `generated` is PptxGenJS's file for the same `slides`, in the same order. Throws when something
 * about the files is unexpected; the caller then saves the generated file instead.
 */
export async function mergePptx(base: ArrayBuffer, generated: Blob, slides: Slide[], origins: Map<string, PptxOrigin>, deck: Deck): Promise<Blob> {
  const B = unzipSync(new Uint8Array(base));
  const G = unzipSync(new Uint8Array(await generated.arrayBuffer()));
  const out: Files = { ...B };

  const presPart = readRels(B, '').find((r) => isType(r, 'officeDocument'))?.abs;
  if (!presPart || !B[presPart] || !B['[Content_Types].xml']) throw new Error('Not a presentation package');
  const ct = new ContentTypes(B['[Content_Types].xml']);
  const gct = new ContentTypes(G['[Content_Types].xml']);
  const presDoc = parseXml(B[presPart], presPart);
  const presRoot = presDoc.documentElement;
  const presRels = readRels(B, presPart);
  const presDir = dirOf(presPart);

  // The stored file's slides.
  const sldIdLst = kid(presRoot, 'sldIdLst');
  if (!sldIdLst) throw new Error('No slide list');
  const baseSlides = new Map<string, { el: Element; rid: string }>();
  for (const el of kids(sldIdLst, 'sldId')) {
    const rid = relAttr(el, 'id') ?? '';
    const part = presRels.find((r) => r.id === rid)?.abs;
    if (part && B[part] && !baseSlides.has(part)) baseSlides.set(part, { el, rid });
  }
  const originalOrder = kids(sldIdLst, 'sldId').map((el) => el.getAttribute('id') ?? '');

  // PptxGenJS's slides, which follow the editor's order.
  const gPres = parseXml(G['ppt/presentation.xml'], 'generated presentation');
  const gPresRels = readRels(G, 'ppt/presentation.xml');
  const gSlides = kids(kid(gPres.documentElement, 'sldIdLst'), 'sldId').map((el) => gPresRels.find((r) => r.id === relAttr(el, 'id'))?.abs ?? '');
  if (gSlides.length !== slides.length || gSlides.some((p) => !G[p])) throw new Error('Generated file does not match the slides');

  // What happens to each slide.
  type Plan = { kind: 'keep' | 'replace' | 'new'; part: string; origin?: PptxOrigin };
  const claimed = new Set<string>();
  const plans: Plan[] = slides.map((s) => {
    const o = origins.get(s.id);
    if (o && baseSlides.has(o.part) && !claimed.has(o.part)) {
      claimed.add(o.part);
      // Speaker notes and "hidden" can change on a kept slide; anything else rewrites it.
      const same = (o.look ? lookFingerprint(s, deck) === o.look : slideFingerprint(s, deck) === o.hash) && partFingerprint(B[o.part]) === o.partHash;
      return { kind: same ? 'keep' : 'replace', part: o.part, origin: o };
    }
    return { kind: 'new', part: '' };
  });
  const removed = [...baseSlides.keys()].filter((p) => !claimed.has(p));

  // The layout new slides use: the stored file's blank layout, else the first layout of the first master.
  let chosenLayout: string | null = null;
  const layoutForNew = () => {
    if (chosenLayout) return chosenLayout;
    const masters = kids(kid(presRoot, 'sldMasterIdLst'), 'sldMasterId')
      .map((m) => presRels.find((r) => r.id === relAttr(m, 'id'))?.abs)
      .filter((p): p is string => !!p && !!B[p]);
    const layouts: string[] = [];
    for (const m of masters) {
      const mRels = readRels(B, m);
      for (const l of kids(kid(parseXml(B[m], m).documentElement, 'sldLayoutIdLst'), 'sldLayoutId')) {
        const p = mRels.find((r) => r.id === relAttr(l, 'id'))?.abs;
        if (p && B[p] && !layouts.includes(p)) layouts.push(p);
      }
    }
    if (!layouts.length) layouts.push(...Object.keys(B).filter((k) => /^ppt\/slideLayouts\/[^/]+\.xml$/.test(k)));
    if (!layouts.length) throw new Error('No slide layouts');
    chosenLayout = layouts.find((l) => parseXml(B[l], l).documentElement.getAttribute('type') === 'blank') ?? layouts[0];
    return chosenLayout;
  };

  const unusedName = (dir: string, stem: string, ext: string) => {
    for (let n = 1; ; n++) {
      const name = `${dir}/${stem}${n}.${ext}`;
      if (!out[name] && !B[name]) return name;
    }
  };

  /** Copies a part of the generated file (and what it refers to) into the result under a new name. */
  const copied = new Map<string, string>();
  const copyGenerated = (gPart: string): string => {
    const done = copied.get(gPart);
    if (done) return done;
    const bytes = G[gPart];
    const ext = (gPart.split('.').pop() ?? 'bin').toLowerCase();
    const dir = dirOf(gPart);
    const gRels = readRels(G, gPart);
    // A picture with the same bytes gets the same name, so one used on several slides is stored once.
    const name = gRels.length ? unusedName(dir, `${(gPart.split('/').pop() ?? 'part').replace(/\.[^.]+$/, '').replace(/[\d-]+$/, '')}-atrium`, ext) : `${dir}/atrium-${hashBytes(bytes)}.${ext}`;
    copied.set(gPart, name);
    out[name] = bytes;
    const type = gct.override(gPart);
    if (type) ct.setOverride(name, type);
    else ct.ensureDefault(ext, gct.defaultFor(ext) ?? MEDIA_TYPES[ext] ?? 'application/octet-stream');
    if (gRels.length) out[relsPathOf(name)] = writeRels(gRels.map((r) => (r.abs && G[r.abs] ? { ...r, target: relative(dirOf(name), copyGenerated(r.abs)) } : r)));
    return name;
  };

  const notesMaster = presRels.find((r) => isType(r, 'notesMaster'))?.abs;

  /**
   * Speaker notes for the slide at `index`, written as `target`: the original notes slide (from
   * `baseRels`) with its text updated when it changed, or a new one from the generated file when there
   * was none (only if the stored file has a notes master to hang it on). Returns the slide's relationship
   * to it (its id is replaced by the caller), or null for no notes.
   */
  const notesFor = (index: number, target: string, baseRels: Rel[]): Rel | null => {
    const slide = slides[index];
    const notes = slide.notes.trim();
    const tDir = dirOf(target);
    const baseNotes = baseRels.find((r) => isType(r, 'notesSlide') && r.abs && B[r.abs])?.abs;
    if (baseNotes) {
      const nDoc = parseXml(B[baseNotes], baseNotes);
      const current = notesTextOf(nDoc);
      if (current !== null && current !== notes && setNotesText(nDoc, slide.notes)) out[baseNotes] = serialize(nDoc);
      return internalRel('', 'notesSlide', tDir, baseNotes);
    }
    if (!notes || !notesMaster || !B[notesMaster]) return null;
    const gNotes = readRels(G, gSlides[index]).find((r) => isType(r, 'notesSlide'))?.abs;
    if (!gNotes || !G[gNotes]) return null;
    const name = unusedName('ppt/notesSlides', 'notesSlide', 'xml');
    out[name] = G[gNotes];
    out[relsPathOf(name)] = writeRels([internalRel('rId1', 'notesMaster', dirOf(name), notesMaster), internalRel('rId2', 'slide', dirOf(name), target)]);
    ct.setOverride(name, CT_NOTES);
    return internalRel('', 'notesSlide', tDir, name);
  };

  /** A kept slide whose notes or "hidden" changed: only those are touched. */
  const touchUpKept = (index: number, part: string) => {
    const slide = slides[index];
    const doc = parseXml(B[part], part);
    const hidden = ['0', 'false'].includes(doc.documentElement.getAttribute('show') ?? '');
    if (hidden !== slide.hidden) {
      if (slide.hidden) doc.documentElement.setAttribute('show', '0');
      else doc.documentElement.removeAttribute('show');
      out[part] = serialize(doc);
    }
    const rels = readRels(B, part);
    const hadNotes = rels.some((r) => isType(r, 'notesSlide') && r.abs && B[r.abs]);
    const notesRel = notesFor(index, part, rels);
    if (notesRel && !hadNotes) {
      rels.push({ ...notesRel, id: idAllocator(rels.map((r) => r.id))() });
      out[relsPathOf(part)] = writeRels(rels);
    }
  };

  /** Writes a changed or new slide into the result (see the top of this file). */
  const buildSlide = (index: number, plan: Plan) => {
    const slide = slides[index];
    const gPart = gSlides[index];
    const target = plan.part;
    const tDir = dirOf(target);
    const doc = parseXml(G[gPart], gPart);
    const root = doc.documentElement;
    const gRels = readRels(G, gPart);
    const baseDoc = plan.kind === 'replace' ? parseXml(B[target], target) : null;
    const baseRels = plan.kind === 'replace' ? readRels(B, target) : [];
    const nextId = idAllocator(gRels.map((r) => r.id));
    const rels: Rel[] = [];

    const layout = baseRels.find((r) => isType(r, 'slideLayout') && r.abs && B[r.abs])?.abs ?? layoutForNew();
    for (const r of gRels) {
      if (isType(r, 'slideLayout')) rels.push({ ...r, target: relative(tDir, layout), abs: layout });
      else if (isType(r, 'notesSlide')) continue;
      else if (r.external || !r.abs || !G[r.abs]) rels.push(r);
      else {
        const name = copyGenerated(r.abs);
        rels.push({ ...r, target: relative(tDir, name), abs: name });
      }
    }
    if (!rels.some((r) => isType(r, 'slideLayout'))) rels.push(internalRel(nextId(), 'slideLayout', tDir, layout));

    if (baseDoc) {
      const baseRoot = baseDoc.documentElement;
      // Relationships the carried-over XML refers to get new ids in the new slide.
      const remapped = new Map<string, string>();
      const remap = (node: Element) => {
        for (const el of selfAndDesc(node)) {
          for (const a of [...el.attributes]) {
            if (!isRelAttr(a)) continue;
            const old = baseRels.find((r) => r.id === a.value);
            if (!old) continue;
            let id = remapped.get(old.id);
            if (!id) {
              id = nextId();
              remapped.set(old.id, id);
              rels.push({ ...old, id });
            }
            a.value = id;
          }
        }
        return node;
      };
      // The original root's namespace declarations (e.g. for mc:AlternateContent's Requires="p14").
      for (const a of [...baseRoot.attributes]) {
        if (a.namespaceURI === XMLNS_NS && a.prefix === 'xmlns' && !root.hasAttribute(a.name)) root.setAttributeNS(XMLNS_NS, a.name, a.value);
      }
      const ignorable = baseRoot.getAttributeNodeNS(MC_NS, 'Ignorable');
      if (ignorable && !root.hasAttributeNS(MC_NS, 'Ignorable')) root.setAttributeNS(MC_NS, ignorable.name, ignorable.value);

      // What the editor doesn't show, from the old slide: charts, SmartArt, OLE objects, ink, EMF/WMF pictures.
      const tree = desc(doc, 'spTree')[0];
      const baseTree = desc(baseDoc, 'spTree')[0];
      const carried: Element[] = [];
      for (const node of baseTree ? [...baseTree.children] : []) {
        const name = node.localName;
        let carry = false;
        if (name === 'graphicFrame') carry = !desc(node, 'tbl').length;
        else if (name === 'AlternateContent' || name === 'contentPart') carry = true;
        else if (name === 'pic') {
          const embed = desc(node, 'blip').map((b) => relAttr(b, 'embed')).find(Boolean);
          carry = !embed || /\.(emf|wmf)$/i.test(baseRels.find((r) => r.id === embed)?.abs ?? '');
        }
        if (carry) carried.push(node);
      }
      const carriedIds = new Set(carried.flatMap((n) => selfAndDesc(n).filter((e) => e.localName === 'cNvPr').map((e) => e.getAttribute('id') ?? '')));
      if (tree && carried.length) {
        const genIds = desc(tree, 'cNvPr');
        let max = Math.max(0, ...[...genIds.map((e) => Number(e.getAttribute('id'))), ...[...carriedIds].map(Number)].filter(Number.isFinite));
        for (const e of genIds) if (carriedIds.has(e.getAttribute('id') ?? '')) e.setAttribute('id', String(++max));
        for (const node of carried) tree.appendChild(remap(doc.importNode(node, true) as Element));
      }

      // The original background, while the editor's is still the imported one.
      const cSld = kid(root, 'cSld');
      if (plan.origin && cSld && bgKey(slide) === plan.origin.bg) {
        kid(cSld, 'bg')?.remove();
        const baseBg = kid(kid(baseRoot, 'cSld'), 'bg');
        if (baseBg) cSld.insertBefore(remap(doc.importNode(baseBg, true) as Element), cSld.firstElementChild);
      }

      // Transition and timing. Animations are kept only when every shape they animate was carried over.
      for (const n of [...root.children]) if (n.localName === 'transition' || n.localName === 'timing') n.remove();
      const extra: Element[] = [];
      for (const n of [...baseRoot.children]) {
        if (n.localName === 'transition') extra.push(n);
        else if (n.localName === 'AlternateContent' && desc(n, 'transition').length) extra.push(n);
        else if (n.localName === 'timing') {
          const ids = selfAndDesc(n).map((e) => e.getAttribute('spid')).filter((v): v is string => v !== null);
          if (ids.every((id) => carriedIds.has(id))) extra.push(n);
        }
      }
      let after: Element | null = kid(root, 'clrMapOvr') ?? kid(root, 'cSld');
      for (const n of extra) {
        const copy = remap(doc.importNode(n, true) as Element);
        root.insertBefore(copy, after ? after.nextSibling : root.firstChild);
        after = copy;
      }

      // Relationships nothing in the XML refers to (comments and the like) stay with the slide.
      const referenced = new Set<string>();
      for (const el of selfAndDesc(baseRoot)) for (const a of [...el.attributes]) if (isRelAttr(a)) referenced.add(a.value);
      for (const r of baseRels) {
        if (referenced.has(r.id) || isType(r, 'slideLayout') || isType(r, 'notesSlide')) continue;
        if (!r.external && (!r.abs || !B[r.abs])) continue;
        rels.push({ ...r, id: nextId() });
      }
    }

    const notesRel = notesFor(index, target, baseRels);
    if (notesRel) rels.push({ ...notesRel, id: nextId() });

    out[target] = serialize(doc);
    out[relsPathOf(target)] = writeRels(rels);
    ct.setOverride(target, CT_SLIDE);
  };

  // Slides that are gone lose their parts and their relationship from presentation.xml.
  const removedRids = new Set<string>();
  for (const part of removed) {
    removedRids.add(baseSlides.get(part)!.rid);
    delete out[part];
    delete out[relsPathOf(part)];
    ct.removeOverride(part);
  }
  const newPresRels = presRels.filter((r) => !removedRids.has(r.id));
  let presRelsChanged = removedRids.size > 0;

  const nextPresRid = idAllocator(presRels.map((r) => r.id));
  let maxSldId = Math.max(255, ...originalOrder.map((v) => Number(v) || 0));
  const anyRid = kids(sldIdLst, 'sldId').flatMap((e) => [...e.attributes]).find(isRelAttr);
  const rNs = anyRid?.namespaceURI ?? REL_NS[0];
  const rPrefix = anyRid?.prefix ?? presRoot.lookupPrefix(rNs) ?? 'r';
  const entries: Element[] = [];
  plans.forEach((plan, i) => {
    if (plan.kind === 'new') {
      plan.part = unusedName('ppt/slides', 'slide', 'xml');
      out[plan.part] = new Uint8Array(); // reserves the name while the slide is built
    }
    if (plan.kind === 'keep') touchUpKept(i, plan.part);
    else buildSlide(i, plan);
    if (plan.kind !== 'new') {
      entries.push(baseSlides.get(plan.part)!.el);
      return;
    }
    const rid = nextPresRid();
    newPresRels.push(internalRel(rid, 'slide', presDir, plan.part));
    presRelsChanged = true;
    if (maxSldId + 1 >= 2147483648) throw new Error('No slide ids left');
    const el = presDoc.createElementNS(sldIdLst.namespaceURI, sldIdLst.prefix ? `${sldIdLst.prefix}:sldId` : 'sldId');
    el.setAttribute('id', String(++maxSldId));
    el.setAttributeNS(rNs, `${rPrefix}:id`, rid);
    entries.push(el);
  });

  // presentation.xml: the slide list in the editor's order; custom shows and sections follow.
  let presChanged = false;
  const newOrder = entries.map((e) => e.getAttribute('id') ?? '');
  if (newOrder.join(',') !== originalOrder.join(',')) {
    presChanged = true;
    while (sldIdLst.firstChild) sldIdLst.firstChild.remove();
    for (const e of entries) sldIdLst.appendChild(e);
  }
  for (const s of desc(kid(presRoot, 'custShowLst'), 'sld')) {
    if (removedRids.has(relAttr(s, 'id') ?? '')) {
      s.remove();
      presChanged = true;
    }
  }
  const sectionLst = desc(presRoot, 'sectionLst')[0];
  if (sectionLst && presChanged) {
    // Each slide stays in its section where it can; a new slide joins the one before it. Sections stay in
    // order, so a slide moved back before its section's start joins the section it now sits in.
    const sections = kids(sectionLst, 'section');
    const sectionOf = new Map<string, number>();
    sections.forEach((sec, si) => desc(sec, 'sldId').forEach((s) => sectionOf.set(s.getAttribute('id') ?? '', si)));
    const lists = sections.map((sec) => {
      let l = kid(sec, 'sldIdLst');
      if (!l) {
        l = presDoc.createElementNS(sec.namespaceURI, sec.prefix ? `${sec.prefix}:sldIdLst` : 'sldIdLst');
        sec.insertBefore(l, sec.firstChild);
      }
      while (l.firstChild) l.firstChild.remove();
      return l;
    });
    let cur = 0;
    for (const id of newOrder) {
      const s = sectionOf.get(id);
      if (s !== undefined && s > cur) cur = s;
      const list = lists[cur];
      if (!list) continue;
      const el = presDoc.createElementNS(list.namespaceURI, list.prefix ? `${list.prefix}:sldId` : 'sldId');
      el.setAttribute('id', id);
      list.appendChild(el);
    }
  }
  const sldSz = kid(presRoot, 'sldSz');
  if (sldSz) {
    const w = Math.round(Number(sldSz.getAttribute('cx')) / 9525);
    const h = Math.round(Number(sldSz.getAttribute('cy')) / 9525);
    if (w !== deck.width || h !== deck.height) {
      sldSz.setAttribute('cx', String(Math.round(deck.width * 9525)));
      sldSz.setAttribute('cy', String(Math.round(deck.height * 9525)));
      sldSz.removeAttribute('type');
      presChanged = true;
    }
  }
  if (presChanged) out[presPart] = serialize(presDoc);
  if (presRelsChanged) out[relsPathOf(presPart)] = writeRels(newPresRels);

  // Drop parts that only removed or rewritten slides used (parts the stored file itself never referred to
  // are left alone).
  const before = reachable(B);
  const after = reachable(out);
  for (const name of Object.keys(out)) {
    if (name.endsWith('/') || name === '[Content_Types].xml' || isRelsFile(name)) continue;
    if (after.has(name) || (B[name] && !before.has(name))) continue;
    delete out[name];
    delete out[relsPathOf(name)];
    ct.removeOverride(name);
  }
  for (const name of Object.keys(out)) {
    const src = isRelsFile(name) ? sourceOfRels(name) : null;
    if (src && !out[src]) delete out[name];
  }
  // Links from remaining slides to a removed one now go to the first slide (a link to a missing part would
  // make PowerPoint repair the file).
  const firstSlide = plans[0]?.part;
  if (removed.length && firstSlide) {
    for (const name of Object.keys(out)) {
      const src = isRelsFile(name) ? sourceOfRels(name) : null;
      if (src === null || (src !== '' && !after.has(src))) continue;
      const rels = readRels(out, src);
      let fixed = false;
      for (const r of rels) {
        if (r.abs && !out[r.abs] && removed.includes(r.abs)) {
          r.target = relative(dirOf(src), firstSlide);
          fixed = true;
        }
      }
      if (fixed) out[name] = writeRels(rels);
    }
  }

  if (ct.changed) out['[Content_Types].xml'] = serialize(ct.doc);

  // [Content_Types].xml first, then the stored file's order, then new parts.
  const ordered: Files = { '[Content_Types].xml': out['[Content_Types].xml'] };
  for (const k of [...Object.keys(B), ...Object.keys(out)]) if (out[k] && !(k in ordered)) ordered[k] = out[k];
  return new Blob([zipSync(ordered, { level: 6 }) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

// ---------- what's kept but not shown ----------

/** Short descriptions of what the file has that the editor keeps but doesn't show. */
export function keptFeatures(data: ArrayBuffer | Uint8Array): string[] {
  const files = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
  const names = Object.keys(files);
  const texts = (re: RegExp) => names.filter((n) => re.test(n)).map((n) => strFromU8(files[n]));
  const slides = texts(/^ppt\/slides\/[^/]+\.xml$/);
  const slideRels = texts(/^ppt\/slides\/_rels\/[^/]+\.rels$/);
  const designs = [...slides, ...texts(/^ppt\/(slideLayouts|slideMasters)\/[^/]+\.xml$/)];
  const has = (list: string[], re: RegExp) => list.some((t) => re.test(t));
  const tag = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}[\\s>/]`);
  const pres = files['ppt/presentation.xml'] ? strFromU8(files['ppt/presentation.xml']) : '';
  const out: string[] = [];
  if (names.some((n) => n.startsWith('ppt/slideMasters/'))) out.push('Slide masters and layouts');
  if (has(slides, tag('transition')) || has(slides, tag('timing'))) out.push('Transitions and animations');
  if (names.some((n) => /^ppt\/charts\/[^/]+\.xml$/.test(n))) out.push('Charts');
  if (names.some((n) => n.startsWith('ppt/diagrams/'))) out.push('SmartArt diagrams');
  if (names.some((n) => /^ppt\/media\/.+\.(mp4|m4v|mov|avi|wmv|mpe?g|webm|mp3|wav|m4a|wma|aac|ogg)$/i.test(n)) || has(slideRels, /relationships\/(video|audio|media)"/)) out.push('Video and audio');
  if (has(designs, tag('gradFill')) || has(designs, tag('pattFill')) || has(designs, /<(?:[\w-]+:)?effectLst>\s*<(?!\/)/) || has(designs, tag('scene3d')) || has(designs, tag('sp3d'))) out.push('Gradients and effects');
  if (has(slides, tag('grpSp'))) out.push('Shape groups');
  if (has(slideRels, /relationships\/(oleObject|package)"/)) out.push('Embedded objects');
  if (names.some((n) => n.startsWith('ppt/ink/')) || has(slides, tag('contentPart'))) out.push('Ink drawings');
  if (names.some((n) => n.startsWith('ppt/notesSlides/'))) out.push('Speaker note formatting');
  if (names.some((n) => n.startsWith('ppt/comments/'))) out.push('Comments');
  if (tag('sectionLst').test(pres)) out.push('Sections');
  if (tag('custShowLst').test(pres)) out.push('Custom slide shows');
  if (names.some((n) => n.startsWith('ppt/fonts/'))) out.push('Embedded fonts');
  if (names.some((n) => /vbaProject\.bin$/i.test(n))) out.push('Macros');
  return out;
}
