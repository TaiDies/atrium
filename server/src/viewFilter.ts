import type { FieldDef } from './rowCells.js';

// A view's filters and sorting, applied on the server for GET /pages/:id/rows?view=… (and ad-hoc
// ?filters=…). The same rules as the app (web/src/database/model.ts, viewRows), on stored values.
// Formula and rollup values are worked out in the app only, so filters and sorts on them are skipped.

export type FilterOp = 'contains' | 'not_contains' | 'is' | 'is_not' | 'is_empty' | 'is_not_empty' | 'gt' | 'lt';
export const FILTER_OPS: FilterOp[] = ['contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty', 'gt', 'lt'];
export interface Filter {
  fieldId: string;
  op: FilterOp;
  value?: unknown;
}
export interface Sort {
  fieldId: string;
  dir: 'asc' | 'desc';
}
export interface StoredRow {
  createdAt?: unknown;
  updatedAt?: unknown;
  createdBy?: unknown;
  updatedBy?: unknown;
  cells: Record<string, unknown>;
}

/** Worked out in the app: the server doesn't have their values. */
export const APP_ONLY = new Set(['formula', 'rollup', 'button']);
const DATE_TYPES = new Set(['date', 'created_time', 'last_edited']);
const PERSON_TYPES = new Set(['person', 'created_by', 'edited_by']);

export function cellValue(field: FieldDef, row: StoredRow): unknown {
  if (field.type === 'created_time') return row.createdAt;
  if (field.type === 'last_edited') return row.updatedAt;
  if (field.type === 'created_by') return row.createdBy;
  if (field.type === 'edited_by') return row.updatedBy;
  return row.cells[field.id];
}

export function isEmptyValue(value: unknown) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) || value === false;
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The first and last day a date filter covers: a YYYY-MM-DD day or a relative period like "@this_week". */
export function dateRange(value: unknown, now = new Date()): [string, string] | null {
  const v = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return [v.slice(0, 10), v.slice(0, 10)];
  const day = (offset: number) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  const week = (offset: number): [string, string] => {
    const back = (now.getDay() + 6) % 7; // weeks start on Monday
    const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back + offset * 7);
    return [iso(s), iso(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6))];
  };
  const month = (o: number): [string, string] => [iso(new Date(now.getFullYear(), now.getMonth() + o, 1)), iso(new Date(now.getFullYear(), now.getMonth() + o + 1, 0))];
  const ranges: Record<string, () => [string, string]> = {
    '@today': () => [day(0), day(0)],
    '@tomorrow': () => [day(1), day(1)],
    '@yesterday': () => [day(-1), day(-1)],
    '@this_week': () => week(0),
    '@next_week': () => week(1),
    '@last_week': () => week(-1),
    '@this_month': () => month(0),
    '@next_month': () => month(1),
    '@last_month': () => month(-1),
    '@next_7': () => [day(0), day(7)],
    '@past_7': () => [day(-7), day(0)],
    '@next_30': () => [day(0), day(30)],
    '@past_30': () => [day(-30), day(0)],
  };
  return ranges[v]?.() ?? null;
}

const dayOf = (v: unknown) => (typeof v === 'number' ? iso(new Date(v)) : typeof v === 'string' ? v.slice(0, 10) : '');

function text(field: FieldDef, value: unknown): string {
  if (value === undefined || value === null) return '';
  const name = (id: unknown) => field.options?.find((o) => o.id === id)?.name ?? '';
  if (field.type === 'select' || field.type === 'status') return name(value);
  if (field.type === 'multi_select') return Array.isArray(value) ? value.map(name).join(', ') : '';
  if (field.type === 'checkbox') return value ? 'true' : 'false';
  if (DATE_TYPES.has(field.type)) return dayOf(value);
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? String((v as { text?: unknown; name?: unknown }).text ?? (v as { name?: unknown }).name ?? '') : String(v))).join(', ');
  return String(value);
}

export function matches(field: FieldDef, filter: Filter, value: unknown, me?: string): boolean {
  if (DATE_TYPES.has(field.type) && ['is', 'is_not', 'gt', 'lt'].includes(filter.op)) {
    const d = dayOf(value);
    const range = dateRange(filter.value);
    if (!range) return true;
    if (!d) return filter.op === 'is_not';
    if (filter.op === 'is') return d >= range[0] && d <= range[1];
    if (filter.op === 'is_not') return d < range[0] || d > range[1];
    if (filter.op === 'lt') return d < range[0];
    return d > range[1];
  }
  const t = text(field, value).toLowerCase();
  const needle = String(filter.value ?? '').toLowerCase();
  const person = () => (Array.isArray(value) ? value : value ? [value] : []).includes(filter.value === '@me' ? me : String(filter.value));
  switch (filter.op) {
    case 'is_empty':
      return isEmptyValue(value);
    case 'is_not_empty':
      return !isEmptyValue(value);
    case 'contains':
      if (PERSON_TYPES.has(field.type)) return person();
      if (field.type === 'multi_select' || field.type === 'relation') return Array.isArray(value) && value.includes(filter.value);
      return t.includes(needle);
    case 'not_contains':
      if (PERSON_TYPES.has(field.type)) return !person();
      if (field.type === 'multi_select' || field.type === 'relation') return !(Array.isArray(value) && value.includes(filter.value));
      return !t.includes(needle);
    case 'is':
      if (field.type === 'checkbox') return !!value === !!filter.value;
      if (field.type === 'select' || field.type === 'status') return value === filter.value;
      if (field.type === 'number' || field.type === 'unique_id') return Number(value) === Number(filter.value);
      return t === needle;
    case 'is_not':
      if (field.type === 'checkbox') return !!value !== !!filter.value;
      if (field.type === 'select' || field.type === 'status') return value !== filter.value;
      return t !== needle;
    case 'gt':
      return Number(value) > Number(filter.value);
    case 'lt':
      return Number(value) < Number(filter.value);
  }
}

function compare(field: FieldDef, a: unknown, b: unknown): number {
  const ea = isEmptyValue(a) && field.type !== 'checkbox';
  const eb = isEmptyValue(b) && field.type !== 'checkbox';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  switch (field.type) {
    case 'number':
    case 'created_time':
    case 'last_edited':
    case 'unique_id':
      return Number(a) - Number(b);
    case 'checkbox':
      return Number(!!a) - Number(!!b);
    case 'select':
    case 'status': {
      const order = field.options?.map((o) => o.id) ?? [];
      return order.indexOf(a as string) - order.indexOf(b as string);
    }
    default:
      return text(field, a).localeCompare(text(field, b), undefined, { numeric: true, sensitivity: 'base' });
  }
}

const NO_VALUE: FilterOp[] = ['is_empty', 'is_not_empty'];

/** Rows filtered ("and": all filters; "or": any) and then sorted (stable, so manual order breaks ties). */
export function applyView<R extends StoredRow>(fields: FieldDef[], rows: R[], v: { filters: Filter[]; sorts: Sort[]; filterMode?: 'and' | 'or' }, me?: string): R[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const active = v.filters.flatMap((filter) => {
    const field = byId.get(filter.fieldId);
    if (!field || APP_ONLY.has(field.type)) return [];
    if (!NO_VALUE.includes(filter.op) && (filter.value === undefined || filter.value === '' || filter.value === null)) return [];
    return [{ field, filter }];
  });
  let out = rows;
  if (active.length) {
    const test = (r: R) => (f: (typeof active)[number]) => matches(f.field, f.filter, cellValue(f.field, r), me);
    out = out.filter((r) => (v.filterMode === 'or' ? active.some(test(r)) : active.every(test(r))));
  }
  const sorts = v.sorts.filter((s) => byId.has(s.fieldId) && !APP_ONLY.has(byId.get(s.fieldId)!.type));
  if (sorts.length) {
    out = out
      .map((r, i) => ({ r, i }))
      .sort((x, y) => {
        for (const s of sorts) {
          const f = byId.get(s.fieldId)!;
          const c = compare(f, cellValue(f, x.r), cellValue(f, y.r));
          if (c !== 0) return s.dir === 'asc' ? c : -c;
        }
        return x.i - y.i;
      })
      .map((x) => x.r);
  }
  return out;
}
