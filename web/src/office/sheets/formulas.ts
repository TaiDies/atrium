import { update as formatValue } from '@fortune-sheet/core';
import { utils } from '@formulajs/formulajs';
import { Parser } from '@fortune-sheet/formula-parser';

// Fixes to the spreadsheet editor's formula engine (@fortune-sheet/formula-parser, built on formulajs), so
// formulas work the way they do in Excel. The editor and the .xlsx import share one Parser class; this
// patches it once, before any sheet is worked out:
//  - TRUE and FALSE: the engine read them as cell names and gave #NAME? (so VLOOKUP(…, FALSE) failed).
//  - Empty cells count as 0 in sums and "" in text: =A1*2, =A1&"x" and =A1="" broke on an empty A1.
//  - Errors are real errors: 1/0 gave the text "DIV/0", which IFERROR and ISERROR didn't recognise.
//  - Dates are dates: DATE(), TODAY(), EDATE()… showed as "Wed Jan 31 2024 00:00:00 GMT…" and couldn't
//    be added to.
//  - Functions the engine lacks or gets wrong: TEXT, TEXTJOIN, XLOOKUP, MAXIFS, MINIFS, DOLLAR, FIXED,
//    EDATE, MATCH (failed on text), and COUNTIF/SUMIF/AVERAGEIF and their -IFS forms (no * and ? wildcards).

const ERR = utils.errors as Record<'nil' | 'div0' | 'value' | 'ref' | 'name' | 'num' | 'na' | 'error', Error>;
const ERROR_BY_TEXT: Record<string, Error> = {
  '#NULL!': ERR.nil,
  '#DIV/0!': ERR.div0,
  '#VALUE!': ERR.value,
  '#REF!': ERR.ref,
  '#NAME?': ERR.name,
  '#NUM!': ERR.num,
  '#N/A': ERR.na,
  '#ERROR!': ERR.error,
};
/** What the engine's own operators return for an error instead of throwing it. */
const ENGINE_ERRORS: Record<string, Error> = { 'DIV/0': ERR.div0, VALUE: ERR.value, NUM: ERR.num };

const isError = (v: unknown): v is Error => v instanceof Error;
/** A cell holding an error shows it as text ("#DIV/0!"); formulas that use the cell get the error. */
const asError = (v: unknown) => (typeof v === 'string' ? (ERROR_BY_TEXT[v] ?? ENGINE_ERRORS[v]) : undefined);
const blank = (v: unknown) => v === null || v === undefined;

const DAY = 86_400_000;
/** Excel's day number for a date (the 1900 system, as the editor stores dates). */
const serial = (d: Date) => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - Date.UTC(1899, 11, 30)) / DAY;
const fromSerial = (n: number) => {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * DAY));
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
};
const pad = (n: number) => String(n).padStart(2, '0');

/** A value as a number the way Excel's arithmetic sees it (NaN when it isn't one). */
function num(v: unknown): number {
  if (blank(v) || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return serial(v);
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t)) return t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
  }
  return NaN;
}

/** A value as text the way Excel's & sees it. */
function text(v: unknown): string {
  if (blank(v)) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return String(serial(v));
  if (typeof v === 'number') return String(Number(v.toPrecision(15)));
  return String(v);
}

/** Excel's comparison: an empty cell equals 0, "" and FALSE; text ignores case; numbers < text < TRUE/FALSE. */
function compare(a: unknown, b: unknown): number {
  const kind = (v: unknown) => (typeof v === 'boolean' ? 2 : typeof v === 'string' ? 1 : 0);
  if (blank(a)) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (blank(b)) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  if (a instanceof Date) a = serial(a);
  if (b instanceof Date) b = serial(b);
  if (kind(a) !== kind(b)) return kind(a) - kind(b);
  if (typeof a === 'string') return a.localeCompare(b as string, undefined, { sensitivity: 'accent' });
  // Excel compares numbers to 15 significant digits, so 0.1+0.2 equals 0.3.
  const x = Number(Number(a).toPrecision(15));
  const y = Number(Number(b).toPrecision(15));
  return x === y ? 0 : x - y;
}

const arithmetic = (f: (a: number, b: number) => number) => (...args: unknown[]) => {
  const bad = args.find(isError);
  if (bad) return bad;
  const ns = args.map(num);
  if (ns.some(Number.isNaN)) return ERR.value;
  const out = ns.reduce((acc, n) => f(acc, n));
  if (!Number.isFinite(out)) return Number.isNaN(out) ? ERR.num : ERR.div0;
  return out;
};

const comparison = (test: (c: number) => boolean) => (a: unknown, b: unknown) => (isError(a) ? a : isError(b) ? b : test(compare(a, b)));

const OPERATORS: Record<string, (...args: unknown[]) => unknown> = {
  '+': arithmetic((a, b) => a + b),
  '-': arithmetic((a, b) => a - b),
  '*': arithmetic((a, b) => a * b),
  '/': arithmetic((a, b) => (b === 0 ? Infinity : a / b)),
  '^': arithmetic((a, b) => a ** b),
  '&': (...args) => args.find(isError) ?? args.map(text).join(''),
  '=': comparison((c) => c === 0),
  '<>': comparison((c) => c !== 0),
  '>': comparison((c) => c > 0),
  '<': comparison((c) => c < 0),
  '>=': comparison((c) => c >= 0),
  '<=': comparison((c) => c <= 0),
};

// ---------- functions the engine lacks or gets wrong ----------

const flat = (v: unknown): unknown[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);

/** Whether `value` meets a criterion like ">5", "<>x", "a*" or 10, as COUNTIF reads it. */
function meets(value: unknown, criterion: unknown): boolean {
  if (typeof criterion !== 'string') return !blank(value) && compare(value, criterion) === 0;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(criterion)!;
  const op = m[1] ?? '=';
  const raw = m[2];
  const target: unknown = raw !== '' && !Number.isNaN(num(raw)) ? num(raw) : raw;
  if ((op === '=' || op === '<>') && typeof target === 'string') {
    const wild = new RegExp(`^${target.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/~\?/g, '\u0002').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0001/g, '\\*').replace(/\u0002/g, '\\?')}$`, 'is');
    const hit = target === '' ? blank(value) || value === '' : typeof value === 'string' && wild.test(value);
    return op === '=' ? hit : !hit;
  }
  if (blank(value)) return op === '<>';
  if (typeof target === 'number' && typeof value !== 'number') return op === '<>';
  const c = compare(value, target);
  return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op]!;
}

/** The positions in criteria ranges that meet every (criteria range, criterion) pair. */
function matching(pairs: unknown[]): number[] {
  const ranges = pairs.filter((_, i) => i % 2 === 0).map(flat);
  const out: number[] = [];
  for (let i = 0; i < (ranges[0]?.length ?? 0); i++) if (ranges.every((r, p) => meets(r[i], pairs[p * 2 + 1]))) out.push(i);
  return out;
}

/** SUMIFS/MAXIFS…: the numbers in `range` at the positions that meet every pair. */
function ifsValues(range: unknown, pairs: unknown[]): number[] {
  const values = flat(range);
  return matching(pairs)
    .map((i) => values[i])
    .filter((v): v is number => typeof v === 'number');
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const average = (ns: number[]) => (ns.length ? sum(ns) / ns.length : ERR.div0);

const toDate = (v: unknown) => (v instanceof Date ? v : typeof v === 'number' ? fromSerial(v) : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

/** VLOOKUP (by rows) and HLOOKUP (by columns, `across`). */
function lookupIn(lookup: unknown, table: unknown, index: unknown, approximate: unknown, across: boolean): unknown {
  if (isError(lookup)) return lookup;
  const rows = (Array.isArray(table) ? table : [[table]]).map((r) => (Array.isArray(r) ? r : [r])) as unknown[][];
  const lines = across ? rows[0].map((_, c) => rows.map((r) => r[c])) : rows;
  const n = Math.trunc(num(index));
  if (Number.isNaN(n) || n < 1) return ERR.value;
  if (n > (lines[0]?.length ?? 0)) return ERR.ref;
  const at = FUNCTIONS.MATCH(lookup, lines.map((l) => l[0]), approximate === false || approximate === 0 ? 0 : 1);
  return typeof at === 'number' ? (lines[at - 1][n - 1] ?? 0) : at;
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  TEXT: (value, format) => {
    if (isError(value)) return value;
    const v = value instanceof Date ? serial(value) : typeof value === 'number' ? value : Number.isNaN(num(value)) ? value : num(value);
    try {
      const out = formatValue(text(format) || 'General', v);
      return out === undefined || out === null ? text(value) : String(out);
    } catch {
      return ERR.value;
    }
  },
  DOLLAR: (value, decimals = 2) => FUNCTIONS.FIXED(value, decimals, false, '$'),
  FIXED: (value, decimals = 2, noCommas = false, prefix = '') => {
    const n = num(value);
    const d = Math.trunc(num(decimals));
    if (Number.isNaN(n) || Number.isNaN(d)) return ERR.value;
    const rounded = d >= 0 ? n : Math.round(n / 10 ** -d) * 10 ** -d;
    const s = Math.abs(rounded).toLocaleString('en-US', { minimumFractionDigits: Math.max(0, d), maximumFractionDigits: Math.max(0, d), useGrouping: !noCommas });
    return `${rounded < 0 ? '-' : ''}${prefix}${s}`;
  },
  TEXTJOIN: (delimiter, ignoreEmpty, ...items) => {
    const all = items.flatMap(flat);
    const bad = all.find(isError);
    if (bad) return bad;
    return all.filter((v) => !(ignoreEmpty && (blank(v) || v === ''))).map(text).join(text(delimiter));
  },
  XLOOKUP: (lookup, lookupArray, returnArray, ifNotFound, matchMode = 0, searchMode = 1) => {
    const keys = flat(lookupArray);
    const rows = Array.isArray(returnArray) ? (returnArray as unknown[]) : [returnArray];
    // A one-column (or one-row) result range: the value at the same position.
    const pick = (i: number) => {
      const r = rows.length === keys.length ? rows[i] : flat(returnArray)[i];
      return Array.isArray(r) ? r[0] : r;
    };
    const order = keys.map((_, i) => i);
    if (Number(searchMode) < 0) order.reverse();
    let best = -1;
    for (const i of order) {
      const k = keys[i];
      if (blank(k)) continue;
      const c = compare(k, lookup);
      if (Number(matchMode) === 2 ? typeof lookup === 'string' && meets(k, lookup) : c === 0) {
        best = i;
        break;
      }
      if (Number(matchMode) === -1 && c < 0 && (best < 0 || compare(k, keys[best]) > 0)) best = i;
      if (Number(matchMode) === 1 && c > 0 && (best < 0 || compare(k, keys[best]) < 0)) best = i;
    }
    if (best >= 0) return pick(best);
    return ifNotFound === undefined ? ERR.na : ifNotFound;
  },
  COUNTIF: (range, criterion) => matching([range, criterion]).length,
  COUNTIFS: (...pairs) => matching(pairs).length,
  SUMIF: (range, criterion, sumRange) => sum(ifsValues(sumRange ?? range, [range, criterion])),
  SUMIFS: (range, ...pairs) => sum(ifsValues(range, pairs)),
  AVERAGEIF: (range, criterion, avgRange) => average(ifsValues(avgRange ?? range, [range, criterion])),
  AVERAGEIFS: (range, ...pairs) => average(ifsValues(range, pairs)),
  MATCH: (lookup, array, type = 1) => {
    if (isError(lookup)) return lookup;
    const keys = flat(array);
    const t = Math.sign(num(type));
    let best = -1;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (blank(k)) continue;
      if (t === 0) {
        if (typeof lookup === 'string' ? meets(k, lookup) : compare(k, lookup) === 0) return i + 1;
        continue;
      }
      // Sorted lookups: the last value not past the one wanted.
      const c = compare(k, lookup);
      if (t > 0 ? c <= 0 : c >= 0) best = i;
      else if (t > 0) break;
    }
    return best >= 0 ? best + 1 : ERR.na;
  },
  // formulajs's lookups match text case-sensitively; Excel's don't.
  VLOOKUP: (lookup, table, column, approximate = true) => lookupIn(lookup, table, column, approximate, false),
  HLOOKUP: (lookup, table, row, approximate = true) => lookupIn(lookup, table, row, approximate, true),
  MAXIFS: (range, ...pairs) => {
    const v = ifsValues(range, pairs);
    return v.length ? Math.max(...v) : 0;
  },
  MINIFS: (range, ...pairs) => {
    const v = ifsValues(range, pairs);
    return v.length ? Math.min(...v) : 0;
  },
  // formulajs moves Jan 31 + 1 month to Mar 2; Excel stops at the month's last day (Feb 29).
  EDATE: (start, months) => {
    const d = toDate(start);
    const m = Math.trunc(num(months));
    if (!d || Number.isNaN(m)) return ERR.value;
    const last = new Date(d.getFullYear(), d.getMonth() + m + 1, 0).getDate();
    return new Date(d.getFullYear(), d.getMonth() + m, Math.min(d.getDate(), last));
  },
};

// ---------- the patch ----------

type Yy = { evaluateByOperator: (op: string, params: unknown[]) => unknown; invertNumber: (v: unknown) => unknown; __atrium?: boolean };
type ParserProto = {
  parse(expression: string, options?: unknown): { error: string | null; result: unknown };
  _callCellValue(label: string): unknown;
  _callRangeValue(start: string, end: string): unknown;
  _callFunction(name: string, params?: unknown[]): unknown;
  parser: { yy: Yy };
};

/** A date result as text the editor recognises as a date (it then stores the day number and shows it as a date). */
function dateText(d: Date) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() || d.getMinutes() || d.getSeconds() ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : day;
}

/** Bumped when these fixes change results, so saved sheets are worked out again once (SpreadsheetEditor). */
export const FORMULAS_VERSION = '1';

let patched = false;

export function patchFormulaEngine() {
  if (patched) return;
  patched = true;
  const proto = Parser.prototype as unknown as ParserProto;
  const { parse, _callCellValue, _callRangeValue, _callFunction } = proto;

  proto.parse = function (expression, options) {
    const yy = this.parser.yy;
    if (!yy.__atrium) {
      const original = yy.evaluateByOperator;
      yy.evaluateByOperator = (op, params = []) => (OPERATORS[op] ? OPERATORS[op](...params) : original(op, params));
      yy.invertNumber = (v) => (isError(v) ? v : Number.isNaN(num(v)) ? ERR.value : -num(v));
      yy.__atrium = true;
    }
    const out = parse.call(this, expression, options);
    if (out.error === null) {
      const r = out.result;
      if (r instanceof Date) out.result = Number.isNaN(r.getTime()) ? null : dateText(r);
      else if (typeof r === 'string' && ENGINE_ERRORS[r]) out.error = ENGINE_ERRORS[r].message;
      else if (typeof r === 'number' && !Number.isFinite(r)) out.error = Number.isNaN(r) ? '#NUM!' : '#DIV/0!';
      if (out.error) out.result = null;
    }
    return out;
  };

  proto._callCellValue = function (label) {
    if (/^(TRUE|FALSE)$/i.test(label)) return label.toUpperCase() === 'TRUE';
    const v = _callCellValue.call(this, label);
    return v === undefined ? null : (asError(v) ?? v);
  };

  proto._callRangeValue = function (start, end) {
    const rows = _callRangeValue.call(this, start, end);
    return Array.isArray(rows) ? rows.map((row) => (Array.isArray(row) ? row.map((v) => asError(v) ?? v) : row)) : rows;
  };

  proto._callFunction = function (name, params = []) {
    const own = FUNCTIONS[name.toUpperCase()];
    return own ? own(...params) : _callFunction.call(this, name, params);
  };
}
