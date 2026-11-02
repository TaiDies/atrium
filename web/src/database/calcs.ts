import { cellValue, type ChecklistItem, checklistProgress, type Field, fieldKind, formatDate, isEmptyValue, type Row, valueToText } from './model';

// Column totals at the bottom of a grid: one calculation per property, chosen per view.

export type CalcFn =
  | 'count_all'
  | 'count_values'
  | 'count_empty'
  | 'count_unique'
  | 'percent_empty'
  | 'percent_filled'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'checked'
  | 'unchecked'
  | 'percent_checked'
  | 'percent_done'
  | 'earliest'
  | 'latest'
  | 'date_range';

const COUNTS: { fn: CalcFn; label: string }[] = [
  { fn: 'count_all', label: 'Count all' },
  { fn: 'count_values', label: 'Count values' },
  { fn: 'count_empty', label: 'Count empty' },
  { fn: 'count_unique', label: 'Count unique' },
  { fn: 'percent_empty', label: 'Percent empty' },
  { fn: 'percent_filled', label: 'Percent not empty' },
];
const NUMBERS: { fn: CalcFn; label: string }[] = [
  { fn: 'sum', label: 'Sum' },
  { fn: 'average', label: 'Average' },
  { fn: 'median', label: 'Median' },
  { fn: 'min', label: 'Min' },
  { fn: 'max', label: 'Max' },
  { fn: 'range', label: 'Range' },
];
const DATES: { fn: CalcFn; label: string }[] = [
  { fn: 'earliest', label: 'Earliest date' },
  { fn: 'latest', label: 'Latest date' },
  { fn: 'date_range', label: 'Date range' },
];

/** The calculations that make sense for a property. */
export function calcsFor(field: Field): { fn: CalcFn; label: string }[] {
  const kind = fieldKind(field);
  if (kind === 'button') return [];
  if (kind === 'checkbox') return [{ fn: 'count_all', label: 'Count all' }, { fn: 'checked', label: 'Checked' }, { fn: 'unchecked', label: 'Unchecked' }, { fn: 'percent_checked', label: 'Percent checked' }];
  if (kind === 'number' || kind === 'unique_id') return [...COUNTS, ...NUMBERS];
  if (kind === 'date' || kind === 'created_time' || kind === 'last_edited') return [...COUNTS, ...DATES];
  if (kind === 'status') return [...COUNTS, { fn: 'percent_done', label: 'Percent complete' }];
  if (kind === 'checklist') return [...COUNTS, { fn: 'average', label: 'Average progress' }];
  if (kind === 'rollup' || kind === 'formula') return [...COUNTS, ...NUMBERS];
  return COUNTS;
}

export const calcLabel = (fn: CalcFn) => [...COUNTS, ...NUMBERS, ...DATES, { fn: 'checked', label: 'Checked' }, { fn: 'unchecked', label: 'Unchecked' }, { fn: 'percent_checked', label: 'Checked' }, { fn: 'percent_done', label: 'Complete' }].find((c) => c.fn === fn)?.label ?? '';

const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

function numbers(field: Field, rows: Row[]): number[] {
  return rows
    .map((r) => {
      const v = cellValue(field, r);
      if (field.type === 'checklist') return Array.isArray(v) && v.length ? checklistProgress(v as ChecklistItem[]) * 100 : NaN;
      return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    })
    .filter((n) => Number.isFinite(n));
}

function days(field: Field, rows: Row[]): number[] {
  return rows
    .map((r) => {
      const v = cellValue(field, r);
      if (typeof v === 'number') return v;
      return typeof v === 'string' && v ? new Date(`${v.slice(0, 10)}T00:00:00`).getTime() : NaN;
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/** The text shown for a calculation over the rows a view shows. */
export function calculate(fn: CalcFn, field: Field, rows: Row[]): string {
  const values = rows.map((r) => cellValue(field, r));
  const filled = values.filter((v) => !isEmptyValue(v)).length;
  switch (fn) {
    case 'count_all':
      return String(rows.length);
    case 'count_values':
      return String(filled);
    case 'count_empty':
      return String(rows.length - filled);
    case 'count_unique':
      return String(new Set(values.filter((v) => !isEmptyValue(v)).map((v) => valueToText(field, v))).size);
    case 'percent_empty':
      return pct(rows.length - filled, rows.length);
    case 'percent_filled':
      return pct(filled, rows.length);
    case 'checked':
      return String(values.filter(Boolean).length);
    case 'unchecked':
      return String(values.filter((v) => !v).length);
    case 'percent_checked':
      return pct(values.filter(Boolean).length, rows.length);
    case 'percent_done': {
      const done = values.filter((v) => field.options?.find((o) => o.id === v)?.group === 'done').length;
      return pct(done, rows.length);
    }
    case 'sum':
    case 'average':
    case 'median':
    case 'min':
    case 'max':
    case 'range': {
      const ns = numbers(field, rows).sort((a, b) => a - b);
      if (!ns.length) return '—';
      const sum = ns.reduce((a, b) => a + b, 0);
      const suffix = field.type === 'checklist' ? '%' : '';
      if (fn === 'sum') return round(sum) + suffix;
      if (fn === 'average') return round(sum / ns.length) + suffix;
      if (fn === 'median') return round(ns.length % 2 ? ns[(ns.length - 1) / 2] : (ns[ns.length / 2 - 1] + ns[ns.length / 2]) / 2) + suffix;
      if (fn === 'min') return round(ns[0]) + suffix;
      if (fn === 'max') return round(ns[ns.length - 1]) + suffix;
      return round(ns[ns.length - 1] - ns[0]) + suffix;
    }
    case 'earliest':
    case 'latest':
    case 'date_range': {
      const ds = days(field, rows);
      if (!ds.length) return '—';
      if (fn === 'earliest') return formatDate(ds[0]);
      if (fn === 'latest') return formatDate(ds[ds.length - 1]);
      const span = Math.round((ds[ds.length - 1] - ds[0]) / 86_400_000);
      return `${span} day${span === 1 ? '' : 's'}`;
    }
  }
}
