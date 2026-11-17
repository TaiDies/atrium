import type { Cell, CellWithRowAndCol, Sheet } from '@fortune-sheet/core';
import { update as formatValue } from '@fortune-sheet/core';
import type ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

// Converting between Excel workbooks (.xlsx, via ExcelJS) and the spreadsheet editor's sheets:
// values, formulas, number formats, fonts, colours, fills, alignment, wrapping, borders, merged
// cells, column widths, row heights, hidden rows/columns, frozen panes, hyperlinks, comments and images.

async function loadExcelJS() {
  const mod = await import('exceljs');
  return (mod.default ?? mod) as typeof ExcelJS;
}

// Office's default theme, for colours given as "theme N" in a workbook.
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

function tint(hex: string, t: number) {
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(t < 0 ? c * (1 + t) : c + (255 - c) * t));
  return ch.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function colorOf(c: Partial<ExcelJS.Color> | undefined): string | undefined {
  if (!c) return undefined;
  if (c.argb && /^[0-9a-f]{8}$/i.test(c.argb)) return `#${c.argb.slice(2)}`;
  if (typeof c.theme === 'number' && THEME[c.theme]) return `#${tint(THEME[c.theme], (c as { tint?: number }).tint ?? 0)}`;
  return undefined;
}

const argb = (hex: string | undefined) => (hex && /^#?[0-9a-f]{6}$/i.test(hex) ? `FF${hex.replace('#', '').toUpperCase()}` : undefined);

// Border styles: Excel name ↔ the editor's numeric style.
const BORDER_STYLES: Record<string, number> = {
  thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, double: 7, medium: 8,
  mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, slantDashDot: 12, thick: 13,
};
const BORDER_NAMES = Object.fromEntries(Object.entries(BORDER_STYLES).map(([k, v]) => [v, k])) as Record<number, ExcelJS.BorderStyle>;

const H_ALIGN: Record<string, number> = { center: 0, left: 1, right: 2, centerContinuous: 0, justify: 1, distributed: 0, fill: 1 };
const V_ALIGN: Record<string, number> = { middle: 0, top: 1, bottom: 2, justify: 1, distributed: 0 };

/** Excel's date serial number for a JavaScript date (1900 system). */
function dateSerial(d: Date) {
  return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

function display(fa: string, v: unknown): string {
  if (v === null || v === undefined) return '';
  try {
    const out = formatValue(fa || 'General', v);
    return out === undefined || out === null ? String(v) : String(out);
  } catch {
    return String(v);
  }
}

/** One Excel cell's value and formatting in the editor's form. */
function toCell(cell: ExcelJS.Cell): Cell | null {
  const out: Cell = {};
  const fa = cell.numFmt || 'General';
  const v = cell.value as ExcelJS.CellValue;
  let raw: unknown = v;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('formula' in v || 'sharedFormula' in v) {
      const f = v as ExcelJS.CellFormulaValue;
      out.f = `=${f.formula ?? (cell as unknown as { formula?: string }).formula ?? ''}`;
      raw = f.result instanceof Date ? dateSerial(f.result) : typeof f.result === 'object' && f.result ? (f.result as { error?: string }).error : f.result;
    } else if ('richText' in v) {
      raw = (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    } else if ('hyperlink' in v) {
      raw = (v as ExcelJS.CellHyperlinkValue).text;
    } else if ('error' in v) {
      raw = (v as ExcelJS.CellErrorValue).error;
    }
  }
  if (raw instanceof Date) {
    out.ct = { fa: fa === 'General' ? 'yyyy-MM-dd' : fa, t: 'd' };
    raw = dateSerial(raw);
  } else if (typeof raw === 'number') out.ct = { fa, t: 'n' };
  else if (typeof raw === 'boolean') out.ct = { fa: 'General', t: 'b' };
  else if (typeof raw === 'string') out.ct = { fa: fa === 'General' ? 'General' : fa, t: 's' };
  // A formula saved without its result: keep the number format for when it's worked out (fillMissingResults).
  if (out.f && (raw === undefined || raw === null)) out.ct = { fa, t: 'g' };
  if (raw !== undefined && raw !== null) {
    out.v = raw as string | number | boolean;
    out.m = typeof raw === 'string' ? raw : display(out.ct?.fa ?? 'General', raw);
  }

  const font = cell.font;
  if (font) {
    if (font.bold) out.bl = 1;
    if (font.italic) out.it = 1;
    if (font.strike) out.cl = 1;
    if (font.underline) out.un = 1;
    if (font.size) out.fs = font.size;
    if (font.name) out.ff = font.name;
    const fc = colorOf(font.color);
    if (fc && fc !== '#000000') out.fc = fc;
  }
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const bg = colorOf(fill.fgColor) ?? colorOf(fill.bgColor);
    if (bg) out.bg = bg;
  }
  const al = cell.alignment;
  if (al) {
    if (al.horizontal && al.horizontal in H_ALIGN) out.ht = H_ALIGN[al.horizontal];
    if (al.vertical && al.vertical in V_ALIGN) out.vt = V_ALIGN[al.vertical];
    if (al.wrapText) out.tb = '2';
    if (typeof al.textRotation === 'number' && al.textRotation) out.tr = al.textRotation === 90 ? '1' : al.textRotation === -90 || al.textRotation === 180 ? '2' : '0';
  }
  if (cell.note) {
    const note = typeof cell.note === 'string' ? cell.note : (cell.note.texts ?? []).map((t) => t.text).join('');
    if (note) out.ps = { left: null, top: null, width: null, height: null, value: note, isShow: false };
  }
  return Object.keys(out).length ? out : null;
}

const colLetter = (c: number) => {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function parseRef(ref: string) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.replace(/\$/g, ''));
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

// The XML prefixes ExcelJS expects. It reads tags by their written name, so a file that writes the same
// XML with other prefixes (or none: Python's openpyxl, .NET tools) fails to open — a drawing written as
// <wsDr> instead of <xdr:wsDr> stops the whole workbook loading. Such parts are rewritten for it.
const PREFIXES: Record<string, string> = {
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main': '',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing': 'xdr',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
};
const XMLNS = 'http://www.w3.org/2000/xmlns/';

function withPrefixes(src: Element, doc: Document): Element {
  const ns = src.namespaceURI;
  const prefix = ns !== null && ns in PREFIXES ? PREFIXES[ns] : src.prefix;
  const el = doc.createElementNS(ns, prefix ? `${prefix}:${src.localName}` : src.localName);
  for (const a of src.attributes) {
    if (a.namespaceURI === XMLNS) {
      // Declarations other prefixes rely on (mc:Ignorable lists prefixes by name) stay, unless they clash.
      const declared = a.prefix ? a.localName : '';
      if (Object.values(PREFIXES).includes(declared) && PREFIXES[a.value] !== declared) continue;
      el.setAttributeNS(XMLNS, a.name, a.value);
    } else if (a.namespaceURI) {
      const p = a.namespaceURI in PREFIXES ? PREFIXES[a.namespaceURI] : a.prefix;
      el.setAttributeNS(a.namespaceURI, p ? `${p}:${a.localName}` : a.localName, a.value);
    } else el.setAttribute(a.name, a.value);
  }
  for (const child of src.childNodes) {
    if (child.nodeType === 1) el.appendChild(withPrefixes(child as Element, doc));
    else if (child.nodeType === 3 || child.nodeType === 4) el.appendChild(doc.createTextNode(child.textContent ?? ''));
  }
  return el;
}

/** The file with any part ExcelJS would misread rewritten with the prefixes it expects. */
function forExcelJS(data: ArrayBuffer): ArrayBuffer {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data));
  } catch {
    return data;
  }
  let changed = false;
  for (const [path, bytes] of Object.entries(files)) {
    if (!/^xl\/.*\.xml$/.test(path) || bytes.length === 0) continue;
    const head = strFromU8(bytes.subarray(0, 600));
    const root = /<([\w.-]+:)?([\w.-]+)[\s>/]/.exec(head.replace(/<\?[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, ''));
    if (!root) continue;
    const expected = root[2] === 'wsDr' ? 'xdr:' : root[2] === 'chartSpace' ? 'c:' : '';
    if ((root[1] ?? '') === expected) continue;
    const src = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
    if (src.getElementsByTagName('parsererror').length) continue;
    const doc = document.implementation.createDocument(null, null, null);
    doc.appendChild(withPrefixes(src.documentElement, doc));
    files[path] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
${new XMLSerializer().serializeToString(doc)}`);
    changed = true;
  }
  // ExcelJS also expects notes, their drawings and tables at fixed names, linked by relative paths.
  const WANT: Record<string, [RegExp, (n: number) => string]> = {
    comments: [/^xl\/comments\d+\.xml$/, (n) => `xl/comments${n}.xml`],
    vmlDrawing: [/^xl\/drawings\/vmlDrawing\d+\.vml$/, (n) => `xl/drawings/vmlDrawing${n}.vml`],
    table: [/^xl\/tables\/table\d+\.xml$/, (n) => `xl/tables/table${n}.xml`],
  };
  const resolve = (target: string) => {
    const stack: string[] = [];
    for (const p of (target.startsWith('/') ? target.slice(1) : `xl/worksheets/${target}`).split('/')) {
      if (p === '..') stack.pop();
      else if (p && p !== '.') stack.push(p);
    }
    return stack.join('/');
  };
  for (const path of Object.keys(files)) {
    if (!/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(path)) continue;
    const doc = new DOMParser().parseFromString(strFromU8(files[path]), 'application/xml');
    let touched = false;
    for (const rel of doc.getElementsByTagName('Relationship')) {
      if (rel.getAttribute('TargetMode') === 'External') continue;
      const type = (rel.getAttribute('Type') ?? '').split('/').pop() ?? '';
      const target = rel.getAttribute('Target') ?? '';
      let abs = resolve(target);
      const want = WANT[type];
      if (want && !want[0].test(abs) && files[abs]) {
        let n = 1;
        while (files[want[1](n)]) n++;
        files[want[1](n)] = files[abs];
        delete files[abs];
        abs = want[1](n);
      }
      const relative = `../${abs.slice(3)}`;
      if (abs.startsWith('xl/') && relative !== target) {
        rel.setAttribute('Target', relative);
        touched = true;
      }
    }
    if (touched) {
      files[path] = strToU8(new XMLSerializer().serializeToString(doc));
      changed = true;
    }
  }
  if (!changed) return data;
  const out = zipSync(files);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/** An .xlsx file as the editor's sheets. `upload` stores embedded images and returns their URL. */
export async function xlsxToSheets(data: ArrayBuffer, upload?: (blob: Blob, ext: string) => Promise<string>): Promise<Sheet[]> {
  const Excel = await loadExcelJS();
  const wb = new Excel.Workbook();
  await wb.xlsx.load(forExcelJS(data));
  const sheets: Sheet[] = [];
  let order = 0;
  for (const ws of wb.worksheets) {
    const celldata: CellWithRowAndCol[] = [];
    const config: NonNullable<Sheet['config']> = { merge: {}, rowlen: {}, columnlen: {}, rowhidden: {}, colhidden: {}, borderInfo: [] };
    const hyperlink: NonNullable<Sheet['hyperlink']> = {};
    let maxR = 0;
    let maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      const r = rn - 1;
      if (row.height) config.rowlen![r] = Math.round(row.height * (4 / 3));
      if (row.hidden) config.rowhidden![r] = 0;
      row.eachCell({ includeEmpty: true }, (cell, cn) => {
        const c = cn - 1;
        if (cell.isMerged && cell.master !== cell) return;
        const v = toCell(cell);
        const b = cell.border;
        if (b && (b.left || b.right || b.top || b.bottom)) {
          const side = (s?: Partial<ExcelJS.Border>) => (s?.style ? { style: BORDER_STYLES[s.style] ?? 1, color: colorOf(s.color) ?? '#000000' } : undefined);
          config.borderInfo!.push({ rangeType: 'cell', value: { row_index: r, col_index: c, l: side(b.left), r: side(b.right), t: side(b.top), b: side(b.bottom) } });
        }
        const link = (cell.value as ExcelJS.CellHyperlinkValue | null)?.hyperlink;
        if (link) hyperlink[`${r}_${c}`] = { linkType: 'webpage', linkAddress: link };
        if (!v) return;
        celldata.push({ r, c, v });
        maxR = Math.max(maxR, r);
        maxC = Math.max(maxC, c);
      });
    });
    ws.columns?.forEach((col, i) => {
      if (col.width) config.columnlen![i] = Math.round(col.width * 7 + 5);
      if (col.hidden) config.colhidden![i] = 0;
    });
    // Merged ranges ("A1:C2").
    for (const range of (ws.model as { merges?: string[] }).merges ?? []) {
      const [a, b] = range.split(':').map(parseRef);
      if (!a || !b) continue;
      const m = { r: a.r, c: a.c, rs: b.r - a.r + 1, cs: b.c - a.c + 1 };
      config.merge![`${a.r}_${a.c}`] = m;
      const master = celldata.find((x) => x.r === a.r && x.c === a.c);
      if (master?.v) master.v.mc = m;
      else celldata.push({ r: a.r, c: a.c, v: { mc: m } });
      for (let r = a.r; r <= b.r; r++) for (let c = a.c; c <= b.c; c++) if (r !== a.r || c !== a.c) celldata.push({ r, c, v: { mc: { r: a.r, c: a.c } } });
    }
    const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
    let frozen: Sheet['frozen'];
    if (view?.state === 'frozen' && (view.xSplit || view.ySplit)) {
      frozen = { type: 'rangeBoth', range: { row_focus: Math.max(0, (view.ySplit ?? 0) - 1), column_focus: Math.max(0, (view.xSplit ?? 0) - 1) } };
      if (!view.xSplit) frozen = { type: 'rangeRow', range: { row_focus: (view.ySplit ?? 1) - 1, column_focus: 0 } };
      if (!view.ySplit) frozen = { type: 'rangeColumn', range: { row_focus: 0, column_focus: (view.xSplit ?? 1) - 1 } };
    }
    // Pictures placed on the sheet.
    const images: NonNullable<Sheet['images']> = [];
    if (upload) {
      for (const img of ws.getImages()) {
        const media = wb.getImage(Number(img.imageId)) as { buffer?: ArrayBuffer; extension?: string } | undefined;
        const buffer = media?.buffer;
        if (!buffer) continue;
        const ext = media.extension ?? 'png';
        const tl = img.range.tl as { nativeCol: number; nativeRow: number; col: number; row: number };
        const br = img.range.br as { col: number; row: number } | undefined;
        const colX = (c: number) => Array.from({ length: Math.floor(c) }, (_, i) => config.columnlen![i] ?? 73).reduce((a, b) => a + b, 0) + (c % 1) * (config.columnlen![Math.floor(c)] ?? 73);
        const rowY = (r: number) => Array.from({ length: Math.floor(r) }, (_, i) => config.rowlen![i] ?? 19).reduce((a, b) => a + b, 0) + (r % 1) * (config.rowlen![Math.floor(r)] ?? 19);
        const left = colX(tl.col);
        const top = rowY(tl.row);
        const ext2 = (img.range as unknown as { ext?: { width?: number; height?: number } }).ext;
        const width = ext2?.width ?? (br ? colX(br.col) - left : 200);
        const height = ext2?.height ?? (br ? rowY(br.row) - top : 150);
        try {
          const src = await upload(new Blob([buffer], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }), ext);
          images.push({ id: crypto.randomUUID(), src, left, top, width, height });
        } catch {
          // Skip an image that can't be stored.
        }
      }
    }
    sheets.push({
      name: ws.name,
      id: crypto.randomUUID(),
      order: order++,
      status: order === 1 ? 1 : 0,
      hide: ws.state === 'hidden' || ws.state === 'veryHidden' ? 1 : 0,
      celldata,
      config,
      row: Math.max(100, maxR + 20),
      column: Math.max(26, maxC + 5),
      hyperlink,
      images,
      ...(frozen ? { frozen } : {}),
      ...(ws.properties.tabColor ? { color: colorOf(ws.properties.tabColor) } : {}),
      ...(ws.views?.[0] && (ws.views[0] as { showGridLines?: boolean }).showGridLines === false ? { showGridLines: 0 } : {}),
    });
  }
  if (!sheets.length) return [blankSheet()];
  await fillMissingResults(sheets);
  return sheets;
}

/** Formulas saved without their last result (files written by scripts and some apps) would show as
 *  empty cells, because the editor only recalculates a formula when something it uses changes. Works
 *  those results out once, here. Formulas that already carry a result keep it. */
async function fillMissingResults(sheets: Sheet[]) {
  const missing = sheets.some((s) => s.celldata?.some((x) => x.v?.f && x.v.v === undefined));
  if (!missing) return;
  const { Parser } = await import('@fortune-sheet/formula-parser');
  (await import('./formulas')).patchFormulaEngine();
  const byName = new Map(sheets.map((s) => [s.name.toUpperCase(), new Map((s.celldata ?? []).filter((x) => x.v).map((x) => [`${x.r}_${x.c}`, x.v!]))]));
  const busy = new Set<string>();
  const parser = new Parser();
  let current = sheets[0].name.toUpperCase();

  const valueAt = (sheet: string, r: number, c: number): unknown => {
    const cell = byName.get(sheet)?.get(`${r}_${c}`);
    if (!cell) return null;
    if (cell.v !== undefined || !cell.f) return cell.v ?? null;
    const key = `${sheet}!${r}_${c}`;
    if (busy.has(key)) return '#REF!'; // a formula that depends on itself
    busy.add(key);
    const before = current;
    current = sheet;
    const out = parser.parse(cell.f.replace(/^=/, ''));
    current = before;
    busy.delete(key);
    const result = out.error ?? out.result;
    // Dates come back as "2024-01-31" (or with a time): store the day number, shown as a date.
    const date = !out.error && typeof result === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(result) : null;
    if (date) {
      const [, y, mo, d, h = '0', mi = '0', se = '0'] = date.map((x) => x ?? '0');
      const day = (Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - Date.UTC(1899, 11, 30)) / 86_400_000;
      const fa = cell.ct?.fa && cell.ct.fa !== 'General' ? cell.ct.fa : date[4] ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd';
      cell.v = day;
      cell.ct = { fa, t: 'd' };
      cell.m = display(fa, day);
      return day;
    }
    cell.v = result as Cell['v'];
    if (out.error) {
      cell.ct = { fa: 'General', t: 'e' };
      cell.m = String(result);
    } else if (typeof result === 'number') {
      const fa = cell.ct?.fa ?? 'General';
      cell.ct = { fa, t: 'n' };
      cell.m = display(fa, result);
    } else {
      cell.ct = { fa: 'General', t: typeof result === 'boolean' ? 'b' : 's' };
      cell.m = String(result ?? '');
    }
    return result;
  };
  const sheetOf = (name: string | null | undefined) => (name ? name.toUpperCase() : current);

  parser.on('callCellValue', (ref: { row: { index: number }; column: { index: number }; sheetName?: string | null }, _o: unknown, done: (v: unknown) => void) => {
    done(valueAt(sheetOf(ref.sheetName), ref.row.index, ref.column.index));
  });
  parser.on('callRangeValue', (a: { row: { index: number }; column: { index: number }; sheetName?: string | null }, b: { row: { index: number }; column: { index: number } }, _o: unknown, done: (v: unknown[][]) => void) => {
    const sheet = sheetOf(a.sheetName);
    const rows: unknown[][] = [];
    for (let r = a.row.index; r <= b.row.index; r++) {
      const row: unknown[] = [];
      for (let c = a.column.index; c <= b.column.index; c++) row.push(valueAt(sheet, r, c));
      rows.push(row);
    }
    done(rows);
  });

  for (const s of sheets) {
    current = s.name.toUpperCase();
    for (const x of s.celldata ?? []) if (x.v?.f && x.v.v === undefined) valueAt(current, x.r, x.c);
  }
}

export function blankSheet(name = 'Sheet1'): Sheet {
  return { name, id: crypto.randomUUID(), order: 0, status: 1, celldata: [], config: {}, row: 100, column: 26 };
}

/** A sheet's cells as a matrix (sheets from the editor carry `data`; freshly loaded ones `celldata`). */
function cellsOf(sheet: Sheet): { r: number; c: number; v: Cell }[] {
  if (sheet.data?.length) {
    const out: { r: number; c: number; v: Cell }[] = [];
    sheet.data.forEach((row, r) => row?.forEach((v, c) => v && out.push({ r, c, v })));
    return out;
  }
  return (sheet.celldata ?? []).filter((x): x is { r: number; c: number; v: Cell } => !!x.v);
}

/** The editor's sheets as an .xlsx file. */
export async function sheetsToXlsx(sheets: Sheet[], fetchImage?: (src: string) => Promise<{ buffer: ArrayBuffer; ext: string } | null>): Promise<Blob> {
  const Excel = await loadExcelJS();
  const wb = new Excel.Workbook();
  wb.creator = 'Atrium';
  const ordered = [...sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const sheet of ordered) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31) || 'Sheet', {
      state: sheet.hide ? 'hidden' : 'visible',
      properties: { tabColor: sheet.color ? { argb: argb(sheet.color) } : undefined } as never,
    });
    const cfg = sheet.config ?? {};
    for (const { r, c, v } of cellsOf(sheet)) {
      if (v.mc && (v.mc.r !== r || v.mc.c !== c)) continue; // covered by a merge
      const cell = ws.getCell(r + 1, c + 1);
      const raw = v.v;
      if (v.f) cell.value = { formula: v.f.replace(/^=/, ''), result: (raw ?? undefined) as never };
      else if (v.ct?.t === 'd' && typeof raw === 'number') cell.value = new Date(Date.UTC(1899, 11, 30) + raw * 86_400_000);
      else if (raw !== undefined && raw !== null && raw !== '') cell.value = raw as ExcelJS.CellValue;
      else if (v.ct?.t === 'inlineStr' && Array.isArray(v.ct.s)) cell.value = (v.ct.s as { v?: string }[]).map((s) => s.v ?? '').join('');
      if (v.ct?.fa && v.ct.fa !== 'General') cell.numFmt = v.ct.fa;
      const font: Partial<ExcelJS.Font> = {};
      if (v.bl) font.bold = true;
      if (v.it) font.italic = true;
      if (v.cl) font.strike = true;
      if (v.un) font.underline = true;
      if (v.fs) font.size = Number(v.fs);
      if (v.ff && typeof v.ff === 'string') font.name = v.ff;
      if (v.fc) font.color = { argb: argb(v.fc) };
      if (Object.keys(font).length) cell.font = font;
      if (v.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(v.bg) } };
      const alignment: Partial<ExcelJS.Alignment> = {};
      if (v.ht !== undefined) alignment.horizontal = (['center', 'left', 'right'] as const)[Number(v.ht)] ?? 'left';
      if (v.vt !== undefined) alignment.vertical = (['middle', 'top', 'bottom'] as const)[Number(v.vt)] ?? 'bottom';
      if (v.tb === '2') alignment.wrapText = true;
      if (v.tr === '1') alignment.textRotation = 90;
      if (v.tr === '2') alignment.textRotation = -90;
      if (Object.keys(alignment).length) cell.alignment = alignment;
      if (v.ps?.value) cell.note = v.ps.value;
      const link = sheet.hyperlink?.[`${r}_${c}`];
      if (link?.linkAddress) cell.value = { text: String(raw ?? link.linkAddress), hyperlink: link.linkAddress };
    }
    for (const m of Object.values(cfg.merge ?? {})) {
      if (m.rs > 1 || m.cs > 1) ws.mergeCells(m.r + 1, m.c + 1, m.r + m.rs, m.c + m.cs);
    }
    for (const [c, w] of Object.entries(cfg.columnlen ?? {})) ws.getColumn(Number(c) + 1).width = Math.max(1, (Number(w) - 5) / 7);
    for (const [r, h] of Object.entries(cfg.rowlen ?? {})) ws.getRow(Number(r) + 1).height = Number(h) * 0.75;
    for (const c of Object.keys(cfg.colhidden ?? {})) ws.getColumn(Number(c) + 1).hidden = true;
    for (const r of Object.keys(cfg.rowhidden ?? {})) ws.getRow(Number(r) + 1).hidden = true;
    for (const b of cfg.borderInfo ?? []) {
      const val = b?.value;
      if (b?.rangeType !== 'cell' || !val) continue;
      const side = (s?: { style: number; color: string }) => (s ? { style: BORDER_NAMES[s.style] ?? 'thin', color: { argb: argb(s.color) ?? 'FF000000' } } : undefined);
      ws.getCell(val.row_index + 1, val.col_index + 1).border = { left: side(val.l), right: side(val.r), top: side(val.t), bottom: side(val.b) } as ExcelJS.Borders;
    }
    if (sheet.frozen?.range) {
      const { row_focus, column_focus } = sheet.frozen.range;
      const t = sheet.frozen.type;
      ws.views = [{ state: 'frozen', xSplit: t === 'rangeRow' || t === 'row' ? 0 : column_focus + 1, ySplit: t === 'rangeColumn' || t === 'column' ? 0 : row_focus + 1 }];
    } else if (sheet.frozen?.type === 'row') ws.views = [{ state: 'frozen', ySplit: 1 }];
    else if (sheet.frozen?.type === 'column') ws.views = [{ state: 'frozen', xSplit: 1 }];
    if (sheet.showGridLines === 0 || sheet.showGridLines === false) ws.views = [{ ...(ws.views?.[0] ?? {}), showGridLines: false }];
    if (fetchImage) {
      for (const img of sheet.images ?? []) {
        const got = await fetchImage(img.src).catch(() => null);
        if (!got) continue;
        const id = wb.addImage({ buffer: got.buffer as never, extension: (got.ext === 'jpg' ? 'jpeg' : got.ext) as 'png' | 'jpeg' | 'gif' });
        const colAt = (x: number) => {
          let acc = 0;
          for (let i = 0; i < 16384; i++) {
            const w = cfg.columnlen?.[i] ?? 73;
            if (acc + w > x) return i + (x - acc) / w;
            acc += w;
          }
          return 0;
        };
        const rowAt = (y: number) => {
          let acc = 0;
          for (let i = 0; i < 1_048_576; i++) {
            const h = cfg.rowlen?.[i] ?? 19;
            if (acc + h > y) return i + (y - acc) / h;
            acc += h;
          }
          return 0;
        };
        ws.addImage(id, { tl: { col: colAt(img.left), row: rowAt(img.top) } as never, ext: { width: img.width, height: img.height } });
      }
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** CSV or TSV text as one sheet (numbers stay numbers). */
export function delimitedToSheet(text: string, separator: string, name = 'Sheet1'): Sheet {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const celldata: CellWithRowAndCol[] = [];
  rows.forEach((cells, r) =>
    cells.forEach((value, c) => {
      if (value === '') return;
      const n = Number(value);
      const numeric = value.trim() !== '' && Number.isFinite(n) && !/^0\d/.test(value.trim());
      celldata.push({ r, c, v: numeric ? { v: n, m: value, ct: { fa: 'General', t: 'n' } } : { v: value, m: value, ct: { fa: 'General', t: 'g' } } });
    }),
  );
  return { ...blankSheet(name), celldata, row: Math.max(100, rows.length + 20), column: Math.max(26, Math.max(0, ...rows.map((r) => r.length)) + 5) };
}

/** One sheet's displayed values as CSV/TSV. */
export function sheetToDelimited(sheet: Sheet, separator: string): string {
  const cells = cellsOf(sheet);
  const maxR = Math.max(-1, ...cells.map((x) => x.r));
  const maxC = Math.max(-1, ...cells.map((x) => x.c));
  const grid: string[][] = Array.from({ length: maxR + 1 }, () => Array.from({ length: maxC + 1 }, () => ''));
  for (const { r, c, v } of cells) grid[r][c] = String(v.m ?? v.v ?? '');
  const quote = (s: string) => (s.includes(separator) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return grid.map((row) => row.map(quote).join(separator)).join('\r\n') + '\r\n';
}

export { colLetter };
