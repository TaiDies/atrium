import { config } from './config.js';
import { one, type Queryable, query } from './db.js';
import { getSettings, type Limits } from './settings.js';
import { HttpError } from './util.js';

// Limits the admin sets per person (or for everyone): how many workspaces they can own, how much they can
// upload in total and per file, how many people a workspace of theirs can have, and AI requests a day.

export const LIMIT_KEYS = ['workspaces', 'storageMb', 'uploadMb', 'members', 'aiPerDay'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** Each limit as it applies: a number, or null for unlimited. */
export type Effective = Record<LimitKey, number | null>;

const MB = 1024 * 1024;

/** A person's own limits over the defaults (a key they don't have uses the default). */
export function resolve(own: Limits, defaults: Limits): Effective {
  const out = {} as Effective;
  for (const k of LIMIT_KEYS) {
    const v = k in own ? own[k] : defaults[k];
    out[k] = typeof v === 'number' && v >= 0 ? v : null;
  }
  return out;
}

export async function limitsFor(userId: string, c?: Queryable): Promise<Effective> {
  const row = await one<{ limits: Limits }>('select limits from users where id = $1', [userId], c);
  return resolve(row?.limits ?? {}, (await getSettings()).defaultLimits);
}

export interface Usage {
  workspaces: number;
  storageBytes: number;
  aiToday: number;
}

export async function usageFor(userId: string): Promise<Usage> {
  const row = await one<{ workspaces: number; storage: string; ai: number }>(
    `select (select count(*)::int from workspace_members where user_id = $1 and role = 'owner') as workspaces,
            (select coalesce(sum(size), 0)::text from files where uploaded_by = $1) as storage,
            coalesce((select requests from ai_usage where user_id = $1 and day = current_date), 0) as ai`,
    [userId],
  );
  return { workspaces: row?.workspaces ?? 0, storageBytes: Number(row?.storage ?? 0), aiToday: row?.ai ?? 0 };
}

const sizeText = (bytes: number) => (bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`);

/** Before making a workspace: how many this person may own. */
export async function checkWorkspaces(userId: string, c?: Queryable) {
  const { workspaces } = await limitsFor(userId, c);
  if (workspaces === null) return;
  const row = await one<{ n: number }>(`select count(*)::int as n from workspace_members where user_id = $1 and role = 'owner'`, [userId], c);
  if ((row?.n ?? 0) >= workspaces) throw new HttpError(403, `You can own up to ${workspaces} workspace${workspaces === 1 ? '' : 's'} on this server`);
}

/** The largest file this person may upload (also capped by the server's MAX_UPLOAD_MB). */
export async function uploadLimitBytes(userId: string) {
  const { uploadMb } = await limitsFor(userId);
  return uploadMb === null ? config.maxUploadBytes : Math.min(config.maxUploadBytes, uploadMb * MB);
}

/** Whether `addBytes` more fits in this person's storage (`replacing` bytes of theirs are freed at the same time). */
export async function checkStorage(userId: string, addBytes: number, replacing = 0) {
  const { storageMb } = await limitsFor(userId);
  if (storageMb === null) return;
  const { storageBytes } = await usageFor(userId);
  const after = storageBytes - replacing + addBytes;
  if (addBytes > replacing && after > storageMb * MB) {
    throw new HttpError(413, `Not enough space: you've used ${sizeText(storageBytes)} of your ${sizeText(storageMb * MB)}`);
  }
}

/** Before inviting someone: how many people the workspace's owner may have in a workspace. */
export async function checkMembers(workspaceId: string) {
  const owner = await one<{ user_id: string }>(
    `select user_id from workspace_members where workspace_id = $1 and role = 'owner' order by joined_at limit 1`,
    [workspaceId],
  );
  if (!owner) return;
  const { members } = await limitsFor(owner.user_id);
  if (members === null) return;
  const row = await one<{ n: number }>(
    `select (select count(*)::int from workspace_members where workspace_id = $1) + (select count(*)::int from workspace_invites where workspace_id = $1) as n`,
    [workspaceId],
  );
  if ((row?.n ?? 0) >= members) throw new HttpError(403, `This workspace can have up to ${members} people (including invitations)`);
}

/** Counts one AI request, unless the person is over today's limit. */
export async function useAi(userId: string) {
  const { aiPerDay } = await limitsFor(userId);
  const row = await one<{ requests: number }>(
    `insert into ai_usage (user_id, day, requests) values ($1, current_date, 1)
     on conflict (user_id, day) do update set requests = ai_usage.requests + 1
     returning requests`,
    [userId],
  );
  if (aiPerDay !== null && (row?.requests ?? 0) > aiPerDay) {
    await query('update ai_usage set requests = requests - 1 where user_id = $1 and day = current_date', [userId]);
    throw new HttpError(429, `You've used today's ${aiPerDay} AI request${aiPerDay === 1 ? '' : 's'}. It resets tomorrow.`);
  }
}
