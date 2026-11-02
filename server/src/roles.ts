import { one, type Queryable, query } from './db.js';
import type { Limits } from './settings.js';
import { HttpError } from './util.js';

// Roles: the admin gives permissions (and, optionally, limits) to a role and roles to people. Everyone
// has the built-in "Everyone" role; other roles add to it — a person may do whatever any of their roles
// allows, and gets the most generous limit any of their roles sets (a limit set on the person
// themselves still wins; see limits.ts).

export const PERMISSIONS = [
  { key: 'use_ai', label: 'Use AI', help: 'The AI assistant, AI writing and editing, autofill, flashcards, quizzes and transcription.' },
  { key: 'create_workspaces', label: 'Create workspaces', help: 'Make new workspaces of their own.' },
  { key: 'invite_people', label: 'Invite people', help: 'Invite members and guests to workspaces.' },
  { key: 'upload_files', label: 'Upload files', help: 'Upload files, pictures and attachments.' },
  { key: 'start_meetings', label: 'Start meetings', help: 'Schedule and start meetings (they can still join others’).' },
  { key: 'create_chats', label: 'Create groups and teams', help: 'Make chat groups and teams (private chats always work).' },
  { key: 'publish_pages', label: 'Publish pages to the web', help: 'Make public, read-only links to pages.' },
  { key: 'api_tokens', label: 'API tokens and Connect Claude', help: 'Make API tokens for scripts, other apps and AI assistants.' },
] as const;
export type Permission = (typeof PERMISSIONS)[number]['key'];
const KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));
export const isPermission = (k: string): k is Permission => KEYS.has(k);

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  limits: Limits;
  isDefault: boolean;
}

const COLS = `id, name, description, permissions, limits, is_default as "isDefault"`;

export async function listRoles(c?: Queryable): Promise<(Role & { people: number })[]> {
  return query(
    `select ${COLS}, (select count(*)::int from user_roles ur where ur.role_id = r.id) as people from roles r order by is_default desc, position, created_at`,
    [],
    c,
  );
}

/** A person's roles (the default one included). */
export async function rolesOf(userId: string, c?: Queryable): Promise<Role[]> {
  return query<Role>(
    `select ${COLS} from roles r where r.is_default or exists (select 1 from user_roles ur where ur.role_id = r.id and ur.user_id = $1) order by is_default desc, position`,
    [userId],
    c,
  );
}

export async function permissionsFor(userId: string, c?: Queryable): Promise<Set<Permission>> {
  const out = new Set<Permission>();
  for (const r of await rolesOf(userId, c)) for (const p of r.permissions) if (isPermission(p)) out.add(p);
  return out;
}

/** Stops the request unless one of the person's roles allows it. */
export async function requirePermission(userId: string, permission: Permission, c?: Queryable) {
  if ((await permissionsFor(userId, c)).has(permission)) return;
  const label = PERMISSIONS.find((p) => p.key === permission)!.label;
  throw new HttpError(403, `Your account's role doesn't include “${label}”. Ask the server's administrator.`);
}

/** The most generous limit any of the person's roles sets, per key (no key: the roles say nothing). */
export async function roleLimits(userId: string, c?: Queryable): Promise<Limits> {
  const out: Record<string, number | null> = {};
  for (const r of await rolesOf(userId, c)) {
    for (const [k, v] of Object.entries(r.limits ?? {})) {
      if (v === undefined) continue;
      if (v === null || out[k] === null) out[k] = null; // unlimited beats any number
      else out[k] = k in out ? Math.max(out[k] as number, v) : v;
    }
  }
  return out as Limits;
}

export async function getRole(id: string) {
  const r = await one<Role>(`select ${COLS} from roles where id = $1`, [id]);
  if (!r) throw new HttpError(404, 'Role not found');
  return r;
}
