// Repeating events and cards. Kept identical to server/src/repeat.ts (the server resets items on the
// same dates the calendar shows).

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';

export interface RepeatRule {
  unit: RepeatUnit;
  /** Repeat every N units (1 = every day/week/month/year). */
  every: number;
  /** First date (YYYY-MM-DD) the pattern counts from. */
  start: string;
  /** Last date it may repeat on, or null to repeat forever. */
  end: string | null;
  /**
   * 'date': resets on each new date (e.g. every Monday the card comes back).
   * 'done': resets as soon as it's marked done, moving to the next date.
   */
  when: 'date' | 'done';
  // Cards
  dateField?: string;
  endField?: string | null;
  statusField?: string | null;
  /** Status the card goes back to (a select option id, or false for a checkbox). */
  resetTo?: unknown;
  /** The status that counts as done (for when = 'done'). */
  doneValue?: unknown;
  /** Also untick every checklist on the card. */
  untick?: boolean;
  // Events
  resetStatus?: 'todo' | 'doing' | 'done';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

function parse(d: string): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function format(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  const x = parse(d);
  x.setUTCDate(x.getUTCDate() + n);
  return format(x);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/** Today's date where the server runs (set TZ to change it). */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function validRule(v: unknown): v is RepeatRule {
  if (!v || typeof v !== 'object') return false;
  const r = v as RepeatRule;
  return ['day', 'week', 'month', 'year'].includes(r.unit) && Number.isInteger(r.every) && r.every >= 1 && r.every <= 999 && isDate(r.start) && (r.end === null || isDate(r.end)) && (r.when === 'date' || r.when === 'done');
}

/** The k-th date of the pattern (k = 0 is the start). Months keep the start's day, clamped to short months. */
export function occurrence(rule: RepeatRule, k: number): string {
  const s = parse(rule.start);
  if (rule.unit === 'day' || rule.unit === 'week') {
    s.setUTCDate(s.getUTCDate() + k * rule.every * (rule.unit === 'week' ? 7 : 1));
    return format(s);
  }
  const months = k * rule.every * (rule.unit === 'year' ? 12 : 1);
  const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + months) / 12);
  const m = (((s.getUTCMonth() + months) % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(y, m, Math.min(s.getUTCDate(), last))));
}

function estimate(rule: RepeatRule, d: string): number {
  const days = daysBetween(rule.start, d);
  const per = rule.unit === 'day' ? 1 : rule.unit === 'week' ? 7 : rule.unit === 'month' ? 30.44 : 365.25;
  return Math.max(0, Math.floor(days / (per * rule.every)) - 1);
}

const withinEnd = (rule: RepeatRule, d: string) => rule.end === null || d <= rule.end;

/** The first date of the pattern strictly after `d`, or null once it has ended. */
export function nextAfter(rule: RepeatRule, d: string): string | null {
  const k0 = estimate(rule, d);
  for (let k = k0; k < k0 + 400; k++) {
    const o = occurrence(rule, k);
    if (o > d) return withinEnd(rule, o) ? o : null;
  }
  return null;
}

/** The last date of the pattern on or before `d`, or null if it hasn't started. */
export function latestOnOrBefore(rule: RepeatRule, d: string): string | null {
  if (d < rule.start) return null;
  let best: string | null = null;
  const k0 = estimate(rule, d);
  for (let k = k0; k < k0 + 400; k++) {
    const o = occurrence(rule, k);
    if (o > d || !withinEnd(rule, o)) break;
    best = o;
  }
  return best;
}

/** Every date of the pattern between `from` and `to` (inclusive), for showing upcoming repeats. */
export function occurrencesBetween(rule: RepeatRule, from: string, to: string, limit = 500): string[] {
  const out: string[] = [];
  for (let k = estimate(rule, from); out.length < limit; k++) {
    const o = occurrence(rule, k);
    if (o > to || !withinEnd(rule, o)) break;
    if (o >= from) out.push(o);
  }
  return out;
}
