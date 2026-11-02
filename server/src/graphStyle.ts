import { randomUUID } from 'node:crypto';
import { requireMember, requirePage } from './access.js';
import { one, query } from './db.js';
import { HttpError } from './util.js';

// The graph's colours mean something: pages belong to named groups (say "People", "Projects",
// "Lessons"), each with a colour and a description, shown in a legend on the graph. A page is put in
// a group by hand, or a group can take in pages by rule — titles containing some text, or (written
// "under:Title") the pages inside a page. Each kind of line can have its colour too.

/** Names that can be used instead of #rrggbb. */
export const GRAPH_COLORS: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  teal: '#14b8a6',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#9ca3af',
};

export type LineKind = 'link' | 'child' | 'relation';
export interface GraphGroup {
  id: string;
  name: string;
  color: string;
  /** What being in this group means. */
  description: string;
  /** Pages taken in automatically: title contains this, or "under:Title". */
  match: string;
}
export interface GraphStyle {
  links: Partial<Record<LineKind, string>>;
  groups: GraphGroup[];
}

/** A colour name or #rrggbb as #rrggbb; null for none ("", "none", null). */
export function toColor(value: unknown): string | null {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (!v || v === 'none' || v === 'default') return null;
  if (GRAPH_COLORS[v]) return GRAPH_COLORS[v];
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  throw new HttpError(400, `"${value}" isn't a colour: use #rrggbb or one of ${Object.keys(GRAPH_COLORS).join(', ')}`);
}

/**
 * A tidy style. Groups keep their id (so pages stay in them); a group given without an id takes the
 * id of an existing group with the same name, else a new one.
 */
export function cleanStyle(input: unknown, existing?: GraphStyle): GraphStyle {
  const raw = (input && typeof input === 'object' ? input : {}) as { links?: Record<string, unknown>; groups?: unknown };
  const links: GraphStyle['links'] = {};
  for (const kind of ['link', 'child', 'relation'] as const) {
    const c = toColor(raw.links?.[kind]);
    if (c) links[kind] = c;
  }
  const groups: GraphGroup[] = [];
  const names = new Set<string>();
  for (const g of (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 30) as Record<string, unknown>[]) {
    const name = String(g?.name ?? '').trim().slice(0, 60);
    const color = toColor(g?.color);
    if (!name || !color || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    const id =
      (typeof g.id === 'string' && /^[\w-]{1,40}$/.test(g.id) ? g.id : null) ??
      existing?.groups.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ??
      randomUUID().slice(0, 8);
    groups.push({ id, name, color, description: String(g.description ?? '').trim().slice(0, 300), match: String(g.match ?? '').trim().slice(0, 200) });
  }
  return { links, groups };
}

export async function graphStyle(workspaceId: string): Promise<GraphStyle> {
  const row = await one<{ style: unknown }>('select graph_style as style from workspaces where id = $1', [workspaceId]);
  return cleanStyle(row?.style);
}

/** Changes the workspace's groups and line colours (members, not guests). Pages in a removed group leave it. */
export async function setGraphStyle(userId: string, workspaceId: string, style: unknown): Promise<GraphStyle> {
  const role = await requireMember(userId, workspaceId);
  if (role === 'guest') throw new HttpError(403, "Guests can't change the graph's groups");
  const clean = cleanStyle(style, await graphStyle(workspaceId));
  await query('update workspaces set graph_style = $2 where id = $1', [workspaceId, JSON.stringify(clean)]);
  await query('update pages set graph_group = null where workspace_id = $1 and graph_group is not null and not (graph_group = any($2))', [
    workspaceId,
    clean.groups.map((g) => g.id),
  ]);
  return clean;
}

/** Puts a page in a group (by id or name), or with null takes it out; needs edit access to the page. */
export async function setPageGroup(userId: string, pageId: string, group: unknown): Promise<GraphGroup | null> {
  const page = await requirePage(userId, pageId, 'edit');
  const wanted = group == null ? '' : String(group).trim().toLowerCase();
  let found: GraphGroup | null = null;
  if (wanted && wanted !== 'none') {
    const style = await graphStyle(page.workspace_id);
    found = style.groups.find((g) => g.id.toLowerCase() === wanted || g.name.toLowerCase() === wanted) ?? null;
    if (!found) throw new HttpError(400, `No group called "${group}"${style.groups.length ? ` (there's ${style.groups.map((g) => g.name).join(', ')})` : ''}`);
  }
  await query('update pages set graph_group = $2 where id = $1', [pageId, found?.id ?? null]);
  return found;
}
