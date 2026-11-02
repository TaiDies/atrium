import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { type FValue, runFormula } from './formula';
import { type DatabaseState, type Field, primaryField, type RollupFn, type Row, valueToText } from './model';

// Values worked out from other values: the cards a relation links to (and the "linked from" side of a
// two-way relation), rollups over them, and formulas. They're added to each card as it's read, so
// every view, sort and filter treats them like any other value.

/** Another database, as relations see it (from the server). */
export interface RelatedDb {
  id: string;
  title: string;
  icon: string;
  fields: Field[];
  rows: { id: string; cells: Record<string, unknown> }[];
}

export const relatedKey = (pageId: string) => ['related-db', pageId] as const;

export const fetchRelated = (pageId: string) => api<RelatedDb>(`/api/pages/${pageId}/database`);

const DONE = /\b(done|complete|completed|finished|closed|resolved)\b/i;

function rollup(fn: RollupFn, field: Field | undefined, values: unknown[]): FValue {
  const present = values.filter((v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
  const nums = present.map(Number).filter((n) => Number.isFinite(n));
  const dates = present.map((v) => String(v).slice(0, 10)).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)).sort();
  switch (fn) {
    case 'count':
      return values.length;
    case 'count_values':
      return present.length;
    case 'count_unique':
      return new Set(present.map((v) => (field ? valueToText(field, v) : String(v)))).size;
    case 'sum':
      return nums.reduce((s, n) => s + n, 0);
    case 'average':
      return nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100 : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'percent_checked':
      return values.length ? Math.round((values.filter((v) => v === true).length / values.length) * 100) : 0;
    case 'percent_done':
      return values.length ? Math.round((values.filter((v) => field && (field.status ? field.options?.find((o) => o.id === v)?.group === 'done' : DONE.test(valueToText(field, v)))).length / values.length) * 100) : 0;
    case 'earliest':
      return dates[0] ?? null;
    case 'latest':
      return dates[dates.length - 1] ?? null;
    case 'show':
      return field ? present.map((v) => valueToText(field, v)).filter(Boolean) : present.map(String);
  }
}

/** Values of a card as formulas see them, by property name. */
function formulaValue(field: Field, row: Row): FValue {
  const v = field.type === 'created_time' ? row.createdAt : field.type === 'last_edited' ? row.updatedAt : row.cells[field.id];
  if (v === undefined || v === null) return field.type === 'checkbox' ? false : null;
  switch (field.type) {
    case 'number':
      return typeof v === 'number' ? v : Number(v);
    case 'checkbox':
      return v === true;
    case 'select':
      return field.options?.find((o) => o.id === v)?.name ?? null;
    case 'multi_select':
      return Array.isArray(v) ? v.map((id) => field.options?.find((o) => o.id === id)?.name ?? '').filter(Boolean) : [];
    case 'date':
      return String(v).slice(0, 10);
    case 'created_time':
    case 'last_edited':
      return new Date(Number(v)).toISOString().slice(0, 10);
    case 'relation':
      return Array.isArray(v) ? v.map((id) => field.titles?.get(String(id)) ?? '').filter(Boolean) : [];
    case 'rollup':
    case 'formula':
      return v && typeof v === 'object' && !Array.isArray(v) ? null : (v as FValue);
    default:
      return valueToText(field, v);
  }
}

/** The database with relation titles, rollups and formulas filled in. */
export function computeDatabase(db: DatabaseState, related: Map<string, RelatedDb>): DatabaseState {
  const hasComputed = db.fields.some((f) => f.type === 'relation' || f.type === 'rollup' || f.type === 'formula');
  if (!hasComputed) return db;

  // Relations: titles of linked cards, and the "linked from" side worked out from the other database.
  const fields: Field[] = db.fields.map((f) => {
    if (f.type !== 'relation' || !f.relation) return f;
    const other = related.get(f.relation.pageId);
    if (!other) return { ...f, titles: new Map() };
    const title = primaryField(other.fields);
    return { ...f, titles: new Map(other.rows.map((r) => [r.id, typeof r.cells[title?.id ?? ''] === 'string' ? (r.cells[title!.id] as string) || 'Untitled' : 'Untitled'])) };
  });
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));

  const rows: Row[] = db.rows.map((row) => {
    const cells = { ...row.cells };
    for (const f of fields) {
      if (f.type !== 'relation' || !f.relation) continue;
      const other = related.get(f.relation.pageId);
      if (f.relation.reverse) {
        const paired = f.relation.pairedFieldId;
        cells[f.id] = other && paired ? other.rows.filter((r) => Array.isArray(r.cells[paired]) && (r.cells[paired] as unknown[]).includes(row.id)).map((r) => r.id) : [];
      } else if (Array.isArray(cells[f.id]) && other) {
        // Cards deleted over there drop out.
        const ids = new Set(other.rows.map((r) => r.id));
        cells[f.id] = (cells[f.id] as unknown[]).filter((id) => ids.has(String(id)));
      }
    }
    return { ...row, cells };
  });

  // Rollups over the linked cards.
  for (const f of fields) {
    if (f.type !== 'rollup') continue;
    const relField = f.rollup?.relationField ? byId.get(f.rollup.relationField) : undefined;
    const other = relField?.relation ? related.get(relField.relation.pageId) : undefined;
    for (const row of rows) {
      if (!relField || !other) {
        row.cells[f.id] = { error: relField ? 'Loading…' : 'Choose a relation' };
        continue;
      }
      const ids = Array.isArray(row.cells[relField.id]) ? (row.cells[relField.id] as string[]) : [];
      const linked = other.rows.filter((r) => ids.includes(r.id));
      const target = other.fields.find((x) => x.id === f.rollup!.targetField) ?? primaryField(other.fields);
      row.cells[f.id] = rollup(f.rollup!.fn, target, linked.map((r) => (target ? r.cells[target.id] : undefined)));
    }
  }

  // Formulas (they can use each other; a loop is reported instead of hanging).
  const formulas = fields.filter((f) => f.type === 'formula');
  if (formulas.length) {
    for (const row of rows) {
      const done = new Map<string, FValue>();
      const working = new Set<string>();
      const compute = (f: Field): FValue => {
        if (done.has(f.id)) return done.get(f.id)!;
        if (working.has(f.id)) throw new Error(`“${f.name}” uses itself`);
        working.add(f.id);
        const result = runFormula(f.formula ?? '', {
          prop: (name) => {
            const p = byName.get(name.trim().toLowerCase());
            if (!p) throw new Error(`There's no property called “${name}”`);
            if (p.type === 'formula') return compute(p);
            return formulaValue(p, row);
          },
        });
        working.delete(f.id);
        if ('error' in result) {
          row.cells[f.id] = { error: result.error };
          throw new Error(result.error);
        }
        done.set(f.id, result.value);
        row.cells[f.id] = result.value;
        return result.value;
      };
      for (const f of formulas) {
        try {
          compute(f);
        } catch (err) {
          if (!(row.cells[f.id] && typeof row.cells[f.id] === 'object' && 'error' in (row.cells[f.id] as object))) {
            row.cells[f.id] = { error: err instanceof Error ? err.message : 'Invalid formula' };
          }
        }
      }
    }
  }
  return { ...db, fields, rows };
}

/** The other databases this one's relations point at, kept fresh. (Relations within the database itself use its live rows.) */
export function useRelated(db: DatabaseState, selfId?: string) {
  const pageIds = useMemo(
    () => [...new Set(db.fields.filter((f) => f.type === 'relation' && f.relation?.pageId && f.relation.pageId !== selfId).map((f) => f.relation!.pageId))].sort(),
    [db.fields, selfId],
  );
  const results = useQueries({
    queries: pageIds.map((id) => ({ queryKey: relatedKey(id), queryFn: () => fetchRelated(id), refetchInterval: 15_000, staleTime: 5_000 })),
  });
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  return useMemo(() => {
    const map = new Map<string, RelatedDb>();
    results.forEach((r, i) => r.data && map.set(pageIds[i], r.data));
    return map;
  }, [stamp, pageIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}
