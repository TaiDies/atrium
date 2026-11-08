import { unzipSync } from 'fflate';
import { baseElement, type Deck, newId, type ShapeType, type Slide, type SlideElement, themeOf } from './model';

// PowerPoint files in and out of the presentation editor. Reading .pptx is done here (slide size,
// theme colours, backgrounds, placeholders inherited from layouts and masters, text with fonts, sizes,
// colours, bold/italic/underline, alignment and bullets, pictures, shapes, tables, groups, lines and
// speaker notes). Writing uses PptxGenJS. Other formats (.ppt, .odp, .key, PDF) go through LibreOffice.

const EMU_PER_PX = 9525; // 914400 EMU per inch, 96 px per inch

const SHAPES = new Set<ShapeType>([
  'rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'parallelogram',
  'trapezoid', 'chevron', 'star5', 'heart', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'cloud', 'plus',
]);
const SHAPE_ALIASES: Record<string, ShapeType> = { wedgeRectCallout: 'callout', wedgeRoundRectCallout: 'callout', homePlate: 'pentagon', flowChartProcess: 'rect', flowChartDecision: 'diamond', flowChartTerminator: 'roundRect', snip1Rect: 'rect', round2SameRect: 'roundRect' };

type Xml = Element;
const parse = (bytes: Uint8Array | undefined) => (bytes ? new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml') : null);
/** Children (or descendants) by local name, ignoring XML namespaces. */
const kids = (el: Xml | null | undefined, name: string) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el: Xml | null | undefined, name: string) => kids(el, name)[0] ?? null;
const path = (el: Xml | null | undefined, ...names: string[]) => names.reduce<Xml | null>((e, n) => kid(e, n), el ?? null);
const all = (el: Xml | Document | null | undefined, name: string) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
const attr = (el: Xml | null | undefined, name: string) => el?.getAttribute(name) ?? null;

function relsOf(files: Record<string, Uint8Array>, part: string): Map<string, string> {
  const dir = part.slice(0, part.lastIndexOf('/'));
  const relsPath = `${dir}/_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
  const doc = parse(files[relsPath]);
  const out = new Map<string, string>();
  for (const r of all(doc, 'Relationship')) {
    const target = attr(r, 'Target') ?? '';
    // Resolve "../media/image1.png" relative to the part's folder.
    const parts = (target.startsWith('/') ? target.slice(1) : `${dir}/${target}`).split('/');
    const stack: string[] = [];
    for (const p of parts) {
      if (p === '..') stack.pop();
      else if (p && p !== '.') stack.push(p);
    }
    out.set(attr(r, 'Id') ?? '', stack.join('/'));
  }
  return out;
}

interface ThemeColors {
  [name: string]: string;
}

function themeColors(doc: Document | null): ThemeColors {
  const out: ThemeColors = {};
  const scheme = all(doc, 'clrScheme')[0];
  for (const c of scheme ? [...scheme.children] : []) {
    const v = kid(c, 'srgbClr') ?? kid(c, 'sysClr');
    const hex = attr(v, 'val') && v?.localName === 'srgbClr' ? attr(v, 'val') : attr(v, 'lastClr');
    if (hex) out[c.localName] = hex;
  }
  // Aliases used in slides.
  out.tx1 = out.dk1 ?? '000000';
  out.bg1 = out.lt1 ?? 'FFFFFF';
  out.tx2 = out.dk2 ?? '44546A';
  out.bg2 = out.lt2 ?? 'E7E6E6';
  return out;
}

function adjust(hex: string, el: Xml) {
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const mod of [...el.children]) {
    const v = Number(attr(mod, 'val') ?? 0) / 100000;
    if (mod.localName === 'lumMod') [r, g, b] = [r, g, b].map((c) => c * v);
    else if (mod.localName === 'lumOff') [r, g, b] = [r, g, b].map((c) => c + 255 * v);
    else if (mod.localName === 'tint') [r, g, b] = [r, g, b].map((c) => c + (255 - c) * (1 - v));
    else if (mod.localName === 'shade') [r, g, b] = [r, g, b].map((c) => c * v);
  }
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/** A colour from a fill or text-colour element (srgbClr, schemeClr with tints, prstClr). */
function colorIn(el: Xml | null, theme: ThemeColors): string | null {
  if (!el) return null;
  const srgb = kid(el, 'srgbClr');
  if (srgb) return adjust(attr(srgb, 'val') ?? '000000', srgb);
  const scheme = kid(el, 'schemeClr');
  if (scheme) return adjust(theme[attr(scheme, 'val') ?? ''] ?? '000000', scheme);
  const sys = kid(el, 'sysClr');
  if (sys) return `#${attr(sys, 'lastClr') ?? '000000'}`;
  const prst = kid(el, 'prstClr');
  if (prst) return ({ black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', yellow: '#ffff00' } as Record<string, string>)[attr(prst, 'val') ?? ''] ?? null;
  return null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

function xfrmOf(spPr: Xml | null): Box | null {
  const x = kid(spPr, 'xfrm');
  const off = kid(x, 'off');
  const ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return {
    x: Number(attr(off, 'x')) / EMU_PER_PX,
    y: Number(attr(off, 'y')) / EMU_PER_PX,
    w: Number(attr(ext, 'cx')) / EMU_PER_PX,
    h: Number(attr(ext, 'cy')) / EMU_PER_PX,
    rot: Number(attr(x, 'rot') ?? 0) / 60000,
    flipH: attr(x, 'flipH') === '1',
    flipV: attr(x, 'flipV') === '1',
  };
}

interface Placeholder {
  type: string;
  idx: string | null;
  box: Box | null;
  size: number | null;
  color: string | null;
}

function placeholderOf(sp: Xml): { type: string; idx: string | null } | null {
  const ph = all(sp, 'ph')[0];
  return ph ? { type: attr(ph, 'type') ?? 'body', idx: attr(ph, 'idx') } : null;
}

/** Placeholders defined in a layout or master: where they sit and their default text size. */
function placeholders(doc: Document | null, theme: ThemeColors): Placeholder[] {
  const out: Placeholder[] = [];
  for (const sp of all(doc, 'sp')) {
    const ph = placeholderOf(sp);
    if (!ph) continue;
    const defRPr = all(kid(sp, 'txBody'), 'defRPr')[0] ?? all(kid(sp, 'txBody'), 'rPr')[0];
    out.push({ ...ph, box: xfrmOf(kid(sp, 'spPr')), size: attr(defRPr, 'sz') ? Number(attr(defRPr, 'sz')) / 100 : null, color: colorIn(kid(defRPr, 'solidFill'), theme) });
  }
  return out;
}

const matchPh = (list: Placeholder[], ph: { type: string; idx: string | null }) =>
  list.find((p) => p.idx !== null && p.idx === ph.idx && p.type === ph.type) ??
  list.find((p) => p.idx !== null && p.idx === ph.idx) ??
  list.find((p) => p.type === ph.type) ??
  list.find((p) => (ph.type === 'ctrTitle' && p.type === 'title') || (ph.type === 'subTitle' && p.type === 'body'));

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A text body as simple HTML (paragraphs, bullet and numbered lists, styled runs). */
function textHtml(txBody: Xml | null, theme: ThemeColors, defaultSize: number, defaultColor: string | null): { html: string; align: SlideElement['align']; valign: SlideElement['valign']; size: number } {
  const bodyPr = kid(txBody, 'bodyPr');
  const anchor = attr(bodyPr, 'anchor');
  const valign: SlideElement['valign'] = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
  const scale = Number(attr(kid(bodyPr, 'normAutofit'), 'fontScale') ?? 100000) / 100000;
  let align: SlideElement['align'] = 'left';
  let firstSize = defaultSize;
  const blocks: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let items: string[] = [];
  const flush = () => {
    if (list && items.length) blocks.push(`<${list}>${items.join('')}</${list}>`);
    list = null;
    items = [];
  };
  kids(txBody, 'p').forEach((p, pi) => {
    const pPr = kid(p, 'pPr');
    const algn = attr(pPr, 'algn');
    const pAlign = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : 'left';
    if (pi === 0) align = pAlign;
    const bullet = kid(pPr, 'buAutoNum') ? 'ol' : kid(pPr, 'buChar') ? 'ul' : null;
    let inner = '';
    for (const r of [...p.children]) {
      if (r.localName === 'br') inner += '<br>';
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const rPr = kid(r, 'rPr');
      const text = kid(r, 't')?.textContent ?? '';
      if (!text) continue;
      const styles: string[] = [];
      const sz = attr(rPr, 'sz');
      const size = sz ? (Number(sz) / 100) * scale : null;
      if (size) {
        styles.push(`font-size: ${Math.round(size * (4 / 3))}px`);
        if (pi === 0) firstSize = size;
      }
      const color = colorIn(kid(rPr, 'solidFill'), theme);
      // Values from the file go into a style attribute: only a real colour, and a font name with no quotes or brackets.
      if (color && color !== defaultColor && /^#[0-9a-f]{3,8}$/i.test(color)) styles.push(`color: ${color}`);
      const face = attr(kid(rPr, 'latin'), 'typeface')?.replace(/[^\p{L}\p{N} ._-]/gu, '').trim();
      if (face && !face.startsWith('+')) styles.push(`font-family: '${face}'`);
      let t = esc(text);
      if (styles.length) t = `<span style="${styles.join('; ')}">${t}</span>`;
      if (attr(rPr, 'b') === '1') t = `<strong>${t}</strong>`;
      if (attr(rPr, 'i') === '1') t = `<em>${t}</em>`;
      if (attr(rPr, 'u') && attr(rPr, 'u') !== 'none') t = `<u>${t}</u>`;
      if (attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike') t = `<s>${t}</s>`;
      inner += t;
    }
    const style = pAlign !== 'left' ? ` style="text-align: ${pAlign}"` : '';
    if (bullet) {
      if (list !== bullet) {
        flush();
        list = bullet;
      }
      items.push(`<li${style}>${inner || '<br>'}</li>`);
    } else {
      flush();
      blocks.push(`<p${style}>${inner || '<br>'}</p>`);
    }
  });
  flush();
  return { html: blocks.join(''), align, valign, size: firstSize };
}

/** Reads a .pptx into slides, uploading pictures with `upload`. */
export async function pptxToSlides(data: ArrayBuffer, upload: (blob: Blob, ext: string) => Promise<string>): Promise<{ deck: Deck; slides: Slide[] }> {
  const files = unzipSync(new Uint8Array(data));
  const pres = parse(files['ppt/presentation.xml']);
  const size = all(pres, 'sldSz')[0];
  const width = Math.round(Number(attr(size, 'cx') ?? 12192000) / EMU_PER_PX);
  const height = Math.round(Number(attr(size, 'cy') ?? 6858000) / EMU_PER_PX);
  const deck: Deck = { width, height, theme: 'simple' };
  const presRels = relsOf(files, 'ppt/presentation.xml');
  const order = all(pres, 'sldId').map((s) => presRels.get(s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? attr(s, 'r:id') ?? '') ?? '');
  const themePath = [...presRels.values()].find((p) => /theme\d*\.xml$/.test(p));
  const theme = themeColors(parse(themePath ? files[themePath] : undefined));

  const uploaded = new Map<string, string>();
  const media = async (partPath: string) => {
    if (uploaded.has(partPath)) return uploaded.get(partPath)!;
    const bytes = files[partPath];
    if (!bytes) return null;
    const ext = partPath.split('.').pop()?.toLowerCase() ?? 'png';
    const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/emf', wmf: 'image/wmf' }[ext] ?? 'application/octet-stream';
    if (ext === 'emf' || ext === 'wmf') return null; // browsers can't show these vector formats
    const url = await upload(new Blob([bytes as BlobPart], { type }), ext);
    uploaded.set(partPath, url);
    return url;
  };

  const slides: Slide[] = [];
  for (const slidePath of order) {
    const doc = parse(files[slidePath]);
    if (!doc) continue;
    const rels = relsOf(files, slidePath);
    const layoutPath = [...rels.values()].find((p) => p.includes('slideLayouts/'));
    const layoutDoc = parse(layoutPath ? files[layoutPath] : undefined);
    const masterPath = layoutPath ? [...relsOf(files, layoutPath).values()].find((p) => p.includes('slideMasters/')) : undefined;
    const masterDoc = parse(masterPath ? files[masterPath] : undefined);
    const layoutPh = placeholders(layoutDoc, theme);
    const masterPh = placeholders(masterDoc, theme);
    const masterTitleSize = Number(attr(all(all(masterDoc, 'titleStyle')[0], 'defRPr')[0], 'sz') ?? 4400) / 100;
    const masterBodySize = Number(attr(all(all(masterDoc, 'bodyStyle')[0], 'defRPr')[0], 'sz') ?? 2800) / 100;
    const masterText = colorIn(kid(all(all(masterDoc, 'bodyStyle')[0], 'defRPr')[0], 'solidFill'), theme) ?? `#${theme.tx1}`;

    const slide: Slide = { id: newId(), background: null, backgroundImage: null, notes: '', transition: 'none', hidden: attr(doc.documentElement, 'show') === '0', elements: [] };
    // Background: the slide's own, else the layout's, else the master's.
    for (const [bgDoc, bgPath] of [[doc, slidePath], [layoutDoc, layoutPath], [masterDoc, masterPath]] as const) {
      const bgPr = all(bgDoc, 'bgPr')[0];
      const bgRef = all(bgDoc, 'bgRef')[0];
      if (bgPr) {
        const color = colorIn(kid(bgPr, 'solidFill'), theme);
        const blip = all(bgPr, 'blip')[0];
        if (blip && bgPath) {
          const target = relsOf(files, bgPath).get(blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ?? '');
          if (target) slide.backgroundImage = await media(target);
        }
        if (color) slide.background = color;
        if (color || slide.backgroundImage) break;
      } else if (bgRef) {
        const c = colorIn(bgRef, theme);
        if (c) {
          slide.background = c;
          break;
        }
      }
    }

    // Speaker notes.
    const notesPath = [...rels.values()].find((p) => p.includes('notesSlides/'));
    const notesDoc = parse(notesPath ? files[notesPath] : undefined);
    for (const sp of all(notesDoc, 'sp')) {
      if (placeholderOf(sp)?.type !== 'body') continue;
      slide.notes = kids(kid(sp, 'txBody'), 'p')
        .map((p) => all(p, 't').map((t) => t.textContent).join(''))
        .join('\n')
        .trim();
    }

    const walk = async (tree: Xml, offset: { dx: number; dy: number; sx: number; sy: number }) => {
      for (const node of [...tree.children]) {
        const place = (b: Box | null) => (b ? { ...b, x: offset.dx + b.x * offset.sx, y: offset.dy + b.y * offset.sy, w: b.w * offset.sx, h: b.h * offset.sy } : null);
        if (node.localName === 'grpSp') {
          // Children of a group are laid out in the group's own coordinates.
          const x = kid(kid(node, 'grpSpPr'), 'xfrm');
          const off = kid(x, 'off');
          const ext = kid(x, 'ext');
          const chOff = kid(x, 'chOff');
          const chExt = kid(x, 'chExt');
          if (off && ext && chOff && chExt) {
            const sx = (Number(attr(ext, 'cx')) / Math.max(1, Number(attr(chExt, 'cx')))) * offset.sx;
            const sy = (Number(attr(ext, 'cy')) / Math.max(1, Number(attr(chExt, 'cy')))) * offset.sy;
            await walk(node, {
              dx: offset.dx + (Number(attr(off, 'x')) / EMU_PER_PX) * offset.sx - (Number(attr(chOff, 'x')) / EMU_PER_PX) * sx,
              dy: offset.dy + (Number(attr(off, 'y')) / EMU_PER_PX) * offset.sy - (Number(attr(chOff, 'y')) / EMU_PER_PX) * sy,
              sx,
              sy,
            });
          } else await walk(node, offset);
          continue;
        }
        if (node.localName === 'sp' || node.localName === 'cxnSp') {
          const spPr = kid(node, 'spPr');
          const ph = placeholderOf(node);
          const inherited = ph ? (matchPh(layoutPh, ph) ?? matchPh(masterPh, ph)) : undefined;
          const box = place(xfrmOf(spPr) ?? inherited?.box ?? null);
          if (!box) continue;
          const prst = attr(kid(spPr, 'prstGeom'), 'prst') ?? 'rect';
          const fill = kid(spPr, 'noFill') ? null : colorIn(kid(spPr, 'solidFill'), theme) ?? (ph ? null : colorIn(all(kid(node, 'style'), 'fillRef')[0] ?? null, theme));
          const ln = kid(spPr, 'ln');
          const stroke = ln && !kid(ln, 'noFill') ? colorIn(kid(ln, 'solidFill'), theme) : null;
          const strokeWidth = ln && attr(ln, 'w') ? Math.max(1, Number(attr(ln, 'w')) / EMU_PER_PX) : 2;
          if (node.localName === 'cxnSp' || prst === 'line' || prst === 'straightConnector1') {
            slide.elements.push(
              baseElement('line', { ...box, stroke: stroke ?? '#404040', strokeWidth, arrow: !!kid(ln, 'tailEnd') && attr(kid(ln, 'tailEnd'), 'type') !== 'none', html: undefined }),
            );
            continue;
          }
          const isTitle = ph?.type === 'title' || ph?.type === 'ctrTitle';
          const defaultSize = inherited?.size ?? (isTitle ? masterTitleSize : masterBodySize);
          const text = textHtml(kid(node, 'txBody'), theme, defaultSize, inherited?.color ?? masterText);
          const hasText = text.html.replace(/<[^>]+>/g, '').trim().length > 0;
          const shape: ShapeType = SHAPES.has(prst as ShapeType) ? (prst as ShapeType) : (SHAPE_ALIASES[prst] ?? 'rect');
          const asShape = !!fill || !!stroke || (prst !== 'rect' && !ph);
          if (!asShape && !hasText) continue; // an empty placeholder
          slide.elements.push(
            baseElement(asShape ? 'shape' : 'text', {
              ...box,
              shape: asShape ? shape : undefined,
              fill,
              stroke,
              strokeWidth,
              html: hasText ? text.html : '',
              fontSize: Math.round(text.size * (4 / 3)),
              color: inherited?.color ?? masterText,
              align: text.align,
              valign: asShape && attr(kid(kid(node, 'txBody'), 'bodyPr'), 'anchor') === null ? 'middle' : text.valign,
            }),
          );
          continue;
        }
        if (node.localName === 'pic') {
          const box = place(xfrmOf(kid(node, 'spPr')));
          const blip = all(node, 'blip')[0];
          const target = rels.get(blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ?? '');
          if (!box || !target) continue;
          const src = await media(target);
          if (src) slide.elements.push(baseElement('image', { ...box, src }));
          continue;
        }
        if (node.localName === 'graphicFrame') {
          const tbl = all(node, 'tbl')[0];
          const x = kid(node, 'xfrm');
          const off = kid(x, 'off');
          const ext = kid(x, 'ext');
          if (!tbl || !off || !ext) continue;
          const box = place({ x: Number(attr(off, 'x')) / EMU_PER_PX, y: Number(attr(off, 'y')) / EMU_PER_PX, w: Number(attr(ext, 'cx')) / EMU_PER_PX, h: Number(attr(ext, 'cy')) / EMU_PER_PX, rot: 0, flipH: false, flipV: false })!;
          const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => textHtml(kid(tc, 'txBody'), theme, 18, null).html));
          const size = Number(attr(all(tbl, 'rPr')[0], 'sz') ?? 1800) / 100;
          slide.elements.push(baseElement('table', { ...box, rows, headerRow: attr(kid(tbl, 'tblPr'), 'firstRow') === '1', fontSize: Math.round(size * (4 / 3)), stroke: '#9aa0a6', strokeWidth: 1 }));
        }
      }
    };
    const tree = all(doc, 'spTree')[0];
    if (tree) await walk(tree, { dx: 0, dy: 0, sx: 1, sy: 1 });
    slides.push(slide);
  }
  return { deck, slides };
}

// ---------- writing .pptx ----------

const hex = (c: string | null | undefined) => (c ? c.replace('#', '').slice(0, 6).toUpperCase() : undefined);

interface Run {
  text: string;
  options: Record<string, unknown>;
}

/** An element's HTML as PptxGenJS text runs (paragraphs, bullets, bold/italic/underline/colour/size). */
function runsOf(html: string, base: { fontSize: number; color: string; fontFace: string; align: string }): Run[] {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const runs: Run[] = [];
  const blocks = [...doc.body.firstElementChild!.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, div')].filter((b) => !b.querySelector('p, li'));
  const list = blocks.length ? blocks : [doc.body.firstElementChild!];
  list.forEach((block, bi) => {
    const align = (block as HTMLElement).style.textAlign || base.align;
    const li = block.tagName === 'LI' ? block : null;
    const paragraph: Record<string, unknown> = { align, ...(li ? { bullet: block.parentElement?.tagName === 'OL' ? { type: 'number' } : true } : {}) };
    const pieces: Run[] = [];
    const visit = (node: Node, style: Record<string, unknown>) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) pieces.push({ text: node.textContent, options: { ...style } });
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.tagName === 'BR') {
        pieces.push({ text: '', options: { ...style, breakLine: true } });
        return;
      }
      const s = { ...style };
      if (/^(B|STRONG)$/.test(node.tagName)) s.bold = true;
      if (/^(I|EM)$/.test(node.tagName)) s.italic = true;
      if (node.tagName === 'U') s.underline = { style: 'sng' };
      if (/^(S|STRIKE|DEL)$/.test(node.tagName)) s.strike = 'sngStrike';
      if (node.style.color) s.color = hex(rgbToHex(node.style.color));
      if (node.style.fontSize) s.fontSize = Math.round(parseFloat(node.style.fontSize) * (node.style.fontSize.endsWith('pt') ? 1 : 0.75));
      if (node.style.fontFamily) s.fontFace = node.style.fontFamily.replace(/['"]/g, '').split(',')[0];
      if (node.style.fontWeight === 'bold' || Number(node.style.fontWeight) >= 600) s.bold = true;
      if (node.style.fontStyle === 'italic') s.italic = true;
      for (const c of node.childNodes) visit(c, s);
    };
    for (const c of block.childNodes) visit(c, { fontSize: Math.round(base.fontSize * 0.75), color: hex(base.color), fontFace: base.fontFace });
    if (!pieces.length) pieces.push({ text: '', options: { fontSize: Math.round(base.fontSize * 0.75) } });
    pieces[0].options = { ...pieces[0].options, ...paragraph };
    if (bi < list.length - 1) pieces[pieces.length - 1].options.breakLine = true;
    runs.push(...pieces);
  });
  return runs;
}

function rgbToHex(c: string) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : c;
}

const PPTX_SHAPES: Record<ShapeType, string> = {
  rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', rtTriangle: 'rtTriangle', diamond: 'diamond', pentagon: 'pentagon',
  hexagon: 'hexagon', octagon: 'octagon', parallelogram: 'parallelogram', trapezoid: 'trapezoid', chevron: 'chevron', star5: 'star5', heart: 'heart',
  rightArrow: 'rightArrow', leftArrow: 'leftArrow', upArrow: 'upArrow', downArrow: 'downArrow', cloud: 'cloud', plus: 'mathPlus', callout: 'wedgeRectCallout',
};

async function dataUrl(src: string) {
  const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
  return new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

/** Slides as a .pptx file. */
export async function slidesToPptx(deck: Deck, slides: Slide[], title: string): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  const PX = 96;
  pptx.defineLayout({ name: 'APP', width: deck.width / PX, height: deck.height / PX });
  pptx.layout = 'APP';
  pptx.title = title;
  const theme = themeOf(deck);
  const inch = (v: number) => v / PX;
  for (const s of slides) {
    const slide = pptx.addSlide();
    if (s.backgroundImage) slide.background = { data: await dataUrl(s.backgroundImage).catch(() => '') };
    else slide.background = { color: hex(s.background ?? theme.background) };
    if (s.hidden) (slide as unknown as { hidden: boolean }).hidden = true;
    for (const el of s.elements) {
      const pos = { x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h), rotate: el.rot || undefined, flipH: el.flipH, flipV: el.flipV };
      const text = { fontSize: el.fontSize, color: el.color || theme.text, fontFace: el.fontFamily || theme.font, align: el.align };
      const transparency = el.opacity < 1 ? Math.round((1 - el.opacity) * 100) : undefined;
      if (el.type === 'text') {
        slide.addText(runsOf(el.html ?? '', text) as never, { ...pos, valign: el.valign, margin: 6, fill: el.fill ? { color: hex(el.fill), transparency } : undefined, line: el.stroke ? { color: hex(el.stroke), width: el.strokeWidth * 0.75 } : undefined, hyperlink: el.link ? { url: el.link } : undefined });
      } else if (el.type === 'shape') {
        const shapeType = PPTX_SHAPES[el.shape ?? 'rect'];
        const fill = el.fill ? { color: hex(el.fill), transparency } : { type: 'none' as const };
        const line = el.stroke ? { color: hex(el.stroke), width: el.strokeWidth * 0.75 } : undefined;
        if (el.html && el.html.replace(/<[^>]+>/g, '').trim()) slide.addText(runsOf(el.html, text) as never, { ...pos, shape: shapeType as never, fill: fill as never, line, valign: el.valign, margin: 6 });
        else slide.addShape(shapeType as never, { ...pos, fill: fill as never, line });
      } else if (el.type === 'line') {
        slide.addShape('line' as never, { ...pos, line: { color: hex(el.stroke ?? '#404040'), width: el.strokeWidth * 0.75, endArrowType: el.arrow ? 'triangle' : undefined } });
      } else if (el.type === 'image' && el.src) {
        const data = await dataUrl(el.src).catch(() => null);
        if (data) slide.addImage({ data, ...pos, transparency } as never);
      } else if (el.type === 'table' && el.rows?.length) {
        const rows = el.rows.map((row, ri) =>
          row.map((cell) => ({
            text: runsOf(cell, { ...text, fontSize: el.fontSize }) as never,
            options: { bold: el.headerRow && ri === 0, fill: el.headerRow && ri === 0 ? { color: hex(theme.accent) } : undefined, color: el.headerRow && ri === 0 ? 'FFFFFF' : undefined },
          })),
        );
        slide.addTable(rows as never, { x: pos.x, y: pos.y, w: pos.w, border: { type: 'solid', color: hex(el.stroke ?? '#9aa0a6'), pt: 0.75 }, fontSize: Math.round(el.fontSize * 0.75), fontFace: text.fontFace });
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return (await pptx.write({ outputType: 'blob' })) as Blob;
}
