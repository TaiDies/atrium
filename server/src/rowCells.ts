import { randomUUID } from 'node:crypto';
import { HttpError } from './util.js';

// Card values sent through the API, checked against the database's properties and stored the way the
// app stores them. Properties can be named by id or by name; select and status options by id or name.

export interface FieldDef {
  id: string;
  name: string;
  type: string;
  primary?: boolean;
  options?: { id: string; name: string; color?: string; group?: string }[];
}

/** Worked out from other values: never written through the API. */
export const COMPUTED = new Set(['rollup', 'formula', 'created_time', 'last_edited', 'created_by', 'edited_by', 'unique_id', 'button', 'tasks']);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function findField(fields: FieldDef[], key: string): FieldDef | undefined {
  return fields.find((f) => f.id === key) ?? fields.find((f) => f.name.trim().toLowerCase() === key.trim().toLowerCase());
}

function option(field: FieldDef, value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, `“${field.name}”: give an option's name or id`);
  const o = field.options?.find((x) => x.id === value) ?? field.options?.find((x) => x.name.trim().toLowerCase() === value.trim().toLowerCase());
  if (!o) throw new HttpError(400, `“${field.name}”: there's no option “${value}” (options: ${(field.options ?? []).map((x) => x.name).join(', ') || 'none'})`);
  return o.id;
}

/**
 * Turns `{ "Status": "Done", "Due": "2026-12-01" }` into stored cells (`{ fieldId: value }`; null clears
 * one). Unknown properties, computed ones and wrong values are refused with a message naming the property.
 */
export function normaliseCells(
  fields: FieldDef[],
  input: Record<string, unknown>,
  ctx: { members?: Set<string>; today?: string } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = findField(fields, key);
    if (!field) throw new HttpError(400, `There's no property “${key}” in this database`);
    if (COMPUTED.has(field.type)) throw new HttpError(400, `“${field.name}” is worked out by the app and can't be set`);
    if (value === null) {
      out[field.id] = null;
      continue;
    }
    const bad = (what: string): never => {
      throw new HttpError(400, `“${field.name}” (${field.type}) needs ${what}`);
    };
    switch (field.type) {
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
      case 'ai':
        if (typeof value !== 'string' && typeof value !== 'number') bad('text');
        out[field.id] = String(value).slice(0, 100_000);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) bad('a number');
        out[field.id] = value;
        break;
      case 'checkbox':
        if (typeof value !== 'boolean') bad('true or false');
        out[field.id] = value;
        break;
      case 'date': {
        const v = value === 'today' ? ctx.today : value === 'tomorrow' && ctx.today ? nextDay(ctx.today) : value;
        if (typeof v !== 'string' || !DATE.test(v)) bad('a date as YYYY-MM-DD (or "today", "tomorrow")');
        out[field.id] = v;
        break;
      }
      case 'select':
      case 'status':
        out[field.id] = option(field, value);
        break;
      case 'multi_select':
        if (!Array.isArray(value)) bad('a list of options');
        out[field.id] = (value as unknown[]).map((v) => option(field, v));
        break;
      case 'person': {
        const ids = Array.isArray(value) ? value : [value];
        if (!ids.every((id) => typeof id === 'string')) bad('a list of user ids');
        const missing = (ids as string[]).filter((id) => ctx.members && !ctx.members.has(id));
        if (missing.length) throw new HttpError(400, `“${field.name}”: not members of this workspace: ${missing.join(', ')}`);
        out[field.id] = ids;
        break;
      }
      case 'relation':
        if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && ROW_ID.test(id))) bad('a list of card ids');
        out[field.id] = value;
        break;
      case 'checklist':
        if (!Array.isArray(value)) bad('a list of items');
        out[field.id] = (value as unknown[]).map((item) => {
          if (typeof item === 'string') return { id: randomUUID().slice(0, 12), text: item, done: false };
          const i = item as { text?: unknown; done?: unknown };
          if (!i || typeof i.text !== 'string') bad('items like {"text": "…", "done": false}');
          return { id: randomUUID().slice(0, 12), text: String(i.text).slice(0, 2000), done: !!i.done };
        });
        break;
      case 'media':
        if (!Array.isArray(value)) bad('a list of files');
        out[field.id] = (value as unknown[]).map((item) => {
          const m = item as { url?: unknown; name?: unknown; type?: unknown };
          if (!m || typeof m.url !== 'string' || !(/^\/api\/files\/[0-9a-f-]{36}/.test(m.url) || /^https?:\/\//.test(m.url))) bad('files like {"url": "/api/files/…", "name": "…"}');
          return { url: m.url, name: typeof m.name === 'string' ? m.name : 'file', type: typeof m.type === 'string' ? m.type : '' };
        });
        break;
      default:
        throw new HttpError(400, `“${field.name}” (${field.type}) can't be set through the API yet`);
    }
  }
  return out;
}

function nextDay(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Stored cells as `{ "Property name": value }`, with option ids turned into names (format=named). */
export function namedCells(fields: FieldDef[], cells: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = cells[f.id];
    if (v === undefined) continue;
    const name = (id: unknown) => f.options?.find((o) => o.id === id)?.name ?? id;
    out[f.name] = f.type === 'select' || f.type === 'status' ? name(v) : f.type === 'multi_select' && Array.isArray(v) ? v.map(name) : v;
  }
  return out;
}
