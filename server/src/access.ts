import { tokenWorkspace } from './scope.js';
import { one, query, type Queryable } from './db.js';
import { HttpError } from './util.js';

export type Role = 'owner' | 'member' | 'guest';

/** What a user may do with a page: manage = also change who has access. */
export type Access = 'none' | 'view' | 'edit' | 'manage';

const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2, manage: 3 };

export function atLeast(access: Access, need: Access) {
  return RANK[access] >= RANK[need];
}

export interface PageRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  icon: string;
  deleted_at: Date | null;
}

/**
 * The person's role in a workspace. Guests only see the pages shared with them, so everything else
 * (calendar, files, members, Today…) refuses them unless `allowGuests` is set.
 */
export async function requireMember(userId: string, workspaceId: string, client?: Queryable, allowGuests = false): Promise<Role> {
  // A token limited to another workspace can't reach this one.
  const scope = tokenWorkspace();
  if (scope && scope !== workspaceId) throw new HttpError(404, 'Workspace not found');
  const row = await one<{ role: Role }>(
    'select role from workspace_members where workspace_id = $1 and user_id = $2',
    [workspaceId, userId],
    client,
  );
  if (!row) throw new HttpError(404, 'Workspace not found');
  if (row.role === 'guest' && !allowGuests) throw new HttpError(403, 'Guests can only open the pages shared with them');
  return row.role;
}

export async function requireOwner(userId: string, workspaceId: string, client?: Queryable) {
  const role = await requireMember(userId, workspaceId, client);
  if (role !== 'owner') throw new HttpError(403, 'Only workspace owners can do that');
}

/**
 * Effective access of a user to every page in a workspace. Explicit per-member entries win, then the
 * page's default for members, then whatever the parent page resolves to; top-level pages default to edit.
 * Workspace owners and a page's creator can always manage it.
 */
export async function accessMap(userId: string, workspaceId: string, client?: Queryable): Promise<Map<string, Access>> {
  const role = await requireMember(userId, workspaceId, client, true);
  const pages = await query<{ id: string; parent_id: string | null; default_access: Access | null; created_by: string | null; teamspace_id: string | null }>(
    'select id, parent_id, default_access, created_by, teamspace_id from pages where workspace_id = $1',
    [workspaceId],
    client,
  );
  const result = new Map<string, Access>();
  if (role === 'owner') {
    for (const p of pages) result.set(p.id, 'manage');
    return result;
  }
  const explicit = new Map(
    (
      await query<{ page_id: string; level: Access }>(
        `select pp.page_id, pp.level from page_permissions pp join pages p on p.id = pp.page_id
          where p.workspace_id = $1 and pp.user_id = $2`,
        [workspaceId, userId],
        client,
      )
    ).map((r) => [r.page_id, r.level]),
  );
  const byId = new Map(pages.map((p) => [p.id, p]));
  const teams = new Set(
    (await query<{ teamspace_id: string }>('select teamspace_id from teamspace_members where user_id = $1', [userId], client)).map((r) => r.teamspace_id),
  );
  const topDefault = (p: { teamspace_id: string | null }): Access => (p.teamspace_id && !teams.has(p.teamspace_id) ? 'none' : 'edit');

  const inherited = (id: string, depth = 0): Access => {
    const cached = result.get(id);
    if (cached) return cached;
    const p = byId.get(id);
    if (!p) return 'edit';
    if (depth > 100) return 'none'; // a chain this deep is broken: show nothing rather than everything
    const outsider = !p.parent_id && p.teamspace_id && !teams.has(p.teamspace_id);
    // Guests: only what was shared with them, and the pages inside it.
    const value: Access =
      role === 'guest'
        ? (explicit.get(id) ?? (p.parent_id ? inherited(p.parent_id, depth + 1) : 'none'))
        : (explicit.get(id) ?? (outsider ? 'none' : (p.default_access ?? (p.parent_id ? inherited(p.parent_id, depth + 1) : topDefault(p)))));
    result.set(id, value);
    return value;
  };
  for (const p of pages) inherited(p.id);
  for (const p of pages) if (p.created_by === userId && !explicit.has(p.id)) result.set(p.id, 'manage');
  return result;
}

/** Loads a page the user can access at the given level (404 when they can't see it at all). */
export async function requirePage(userId: string, pageId: string, need: Access = 'view', client?: Queryable): Promise<PageRow & { access: Access }> {
  const page = await one<PageRow>(
    `select p.id, p.workspace_id, p.parent_id, p.type, p.title, p.icon, p.deleted_at
       from pages p
       join workspace_members m on m.workspace_id = p.workspace_id and m.user_id = $2
      where p.id = $1`,
    [pageId, userId],
    client,
  );
  if (!page) throw new HttpError(404, 'Page not found');
  const access = (await accessMap(userId, page.workspace_id, client)).get(page.id) ?? 'none';
  if (access === 'none') throw new HttpError(404, 'Page not found');
  if (!atLeast(access, need)) {
    throw new HttpError(403, need === 'manage' ? 'Only the page owner or a workspace owner can change sharing' : 'You can only view this page');
  }
  return { ...page, access };
}

/**
 * Opening a file or whiteboard: members may; a guest only when it's used on a page shared with them
 * (so pictures and boards on those pages show).
 */
export async function requireRefAccess(userId: string, workspaceId: string, kind: 'file' | 'board', id: string) {
  const role = await requireMember(userId, workspaceId, undefined, true);
  if (role !== 'guest') return;
  const refs = await query<{ page_id: string }>(kind === 'file' ? 'select page_id from file_refs where file_id = $1' : 'select page_id from board_refs where board_id = $1', [id]);
  const access = await accessMap(userId, workspaceId);
  if (!refs.some((r) => (access.get(r.page_id) ?? 'none') !== 'none')) throw new HttpError(404, kind === 'file' ? 'File not found' : 'Whiteboard not found');
}

/** Stops a write to a page that's locked against accidental edits (423, like the app's read-only view). */
export async function requireUnlocked(pageId: string, client?: Queryable) {
  const row = await one<{ locked: boolean }>('select locked from pages where id = $1', [pageId], client);
  if (row?.locked) throw new HttpError(423, 'This page is locked. Unlock it first (••• → Unlock page).');
}

/**
 * Which of these files a person may see (and so read the text of): their own uploads, files not used
 * on any page, and files on at least one page they can open. The same rule as the Files list.
 */
export async function visibleFiles(userId: string, workspaceId: string, fileIds: string[]): Promise<Set<string>> {
  if (!fileIds.length) return new Set();
  const rows = await query<{ id: string; uploaded_by: string | null; pages: string[] }>(
    `select f.id, f.uploaded_by, coalesce(array_agg(r.page_id) filter (where r.page_id is not null), '{}') as pages
       from files f left join file_refs r on r.file_id = f.id
      where f.workspace_id = $1 and f.id = any($2::uuid[])
      group by f.id`,
    [workspaceId, fileIds],
  );
  const access = await accessMap(userId, workspaceId);
  return new Set(rows.filter((f) => f.uploaded_by === userId || !f.pages.length || f.pages.some((p) => (access.get(p) ?? 'none') !== 'none')).map((f) => f.id));
}

/**
 * Events placed only on pages a person can't open (and not made by them) stay hidden from them in the
 * calendar, its feeds, Today and reminders. Events not placed on any page are for the whole workspace.
 */
export async function hiddenEvents(userId: string, workspaceId: string, eventIds: string[], access?: Map<string, Access>): Promise<Set<string>> {
  if (!eventIds.length) return new Set();
  const rows = await query<{ id: string; created_by: string | null; pages: string[] }>(
    `select e.id, e.created_by, array_agg(r.page_id) as pages
       from events e join event_refs r on r.event_id = e.id
      where e.workspace_id = $1 and e.id = any($2::uuid[])
      group by e.id`,
    [workspaceId, eventIds],
  );
  const map = access ?? (await accessMap(userId, workspaceId));
  return new Set(rows.filter((e) => e.created_by !== userId && !e.pages.some((p) => (map.get(p) ?? 'none') !== 'none')).map((e) => e.id));
}

/**
 * Whether a person may replace a file's contents: the person who uploaded it, a workspace owner, or
 * someone who can edit a page it's on (a file on no page is open to every member, like the Files list).
 */
export async function requireFileEditor(userId: string, fileId: string): Promise<void> {
  const file = await one<{ workspace_id: string; uploaded_by: string | null }>('select workspace_id, uploaded_by from files where id = $1', [fileId]);
  if (!file) throw new HttpError(404, 'File not found');
  const role = await requireMember(userId, file.workspace_id);
  if (role === 'owner' || file.uploaded_by === userId) return;
  const refs = await query<{ page_id: string }>('select page_id from file_refs where file_id = $1', [fileId]);
  if (!refs.length) return;
  const access = await accessMap(userId, file.workspace_id);
  if (!refs.some((r) => atLeast(access.get(r.page_id) ?? 'none', 'edit'))) throw new HttpError(403, "You can't change this file: it's on pages you can only view");
}
