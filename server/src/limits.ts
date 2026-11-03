import { config } from './config.js';
import { one, type Queryable, query } from './db.js';
import { getSettings, type Limits } from './settings.js';
import { HttpError } from './util.js';
import { requirePermission, roleLimits } from './roles.js';

// Limits the admin sets per person (or for everyone): how many workspaces they can own, how much they can
// upload in total and per file, how many people a workspace of theirs can have, and how many AI requests
// and AI tokens (what the models charge for) they can use a day and a month on the server's AI connection.

export const LIMIT_KEYS = ['workspaces', 'storageMb', 'uploadMb', 'members', 'aiRequestsPerDay', 'aiRequestsPerMonth', 'aiTokensPerDay', 'aiTokensPerMonth'] as const;
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
  // The person's own limits win; then the most generous of their roles'; then the server's defaults.
  const fromRoles = await roleLimits(userId, c);
  return resolve(row?.limits ?? {}, { ...(await getSettings()).defaultLimits, ...fromRoles });
}

export interface Usage {
  workspaces: number;
  storageBytes: number;
  /** AI requests and tokens used today and this calendar month. */
  aiRequestsToday: number;
  aiRequestsMonth: number;
  aiTokensToday: number;
  aiTokensMonth: number;
}

export async function usageFor(userId: string): Promise<Usage> {
  const row = await one<{ workspaces: number; storage: string; today: string; month: string; rtoday: number; rmonth: number }>(
    `select (select count(*)::int from workspace_members where user_id = $1 and role = 'owner') as workspaces,
            (select coalesce(sum(size), 0)::text from files where uploaded_by = $1) as storage,
            (select coalesce(sum(tokens), 0)::text from ai_usage where user_id = $1 and day = current_date) as today,
            (select coalesce(sum(tokens), 0)::text from ai_usage where user_id = $1 and day >= date_trunc('month', current_date)) as month,
            (select coalesce(sum(requests), 0)::int from ai_usage where user_id = $1 and day = current_date) as rtoday,
            (select coalesce(sum(requests), 0)::int from ai_usage where user_id = $1 and day >= date_trunc('month', current_date)) as rmonth`,
    [userId],
  );
  return {
    workspaces: row?.workspaces ?? 0,
    storageBytes: Number(row?.storage ?? 0),
    aiRequestsToday: row?.rtoday ?? 0,
    aiRequestsMonth: row?.rmonth ?? 0,
    aiTokensToday: Number(row?.today ?? 0),
    aiTokensMonth: Number(row?.month ?? 0),
  };
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

const tokenText = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * Before an AI request: whether the person still has requests and tokens left today and this month (on
 * the server's AI connection — with their own key it's their own bill). A request that starts under the
 * token limit may finish over it; the next one is refused. Then counts the request.
 */
export async function useAi(userId: string) {
  await requirePermission(userId, 'use_ai');
  const { aiRequestsPerDay, aiRequestsPerMonth, aiTokensPerDay, aiTokensPerMonth } = await limitsFor(userId);
  const { aiAccess } = await import('./ai.js');
  const shared = (await aiAccess(userId)).active?.source !== 'own';
  if (shared && [aiRequestsPerDay, aiRequestsPerMonth, aiTokensPerDay, aiTokensPerMonth].some((v) => v !== null)) {
    const { aiRequestsToday, aiRequestsMonth, aiTokensToday, aiTokensMonth } = await usageFor(userId);
    if (aiRequestsPerDay !== null && aiRequestsToday >= aiRequestsPerDay) {
      throw new HttpError(429, `You've used today's ${aiRequestsPerDay} AI request${aiRequestsPerDay === 1 ? '' : 's'}. They reset tomorrow.`);
    }
    if (aiRequestsPerMonth !== null && aiRequestsMonth >= aiRequestsPerMonth) {
      throw new HttpError(429, `You've used this month's ${aiRequestsPerMonth} AI request${aiRequestsPerMonth === 1 ? '' : 's'}. They reset on the 1st.`);
    }
    if (aiTokensPerDay !== null && aiTokensToday >= aiTokensPerDay) {
      throw new HttpError(429, `You've used today's ${tokenText(aiTokensPerDay)} AI tokens. They reset tomorrow.`);
    }
    if (aiTokensPerMonth !== null && aiTokensMonth >= aiTokensPerMonth) {
      throw new HttpError(429, `You've used this month's ${tokenText(aiTokensPerMonth)} AI tokens. They reset on the 1st.`);
    }
  }
  await query(
    `insert into ai_usage (user_id, day, requests) values ($1, current_date, 1)
     on conflict (user_id, day) do update set requests = ai_usage.requests + 1`,
    [userId],
  );
}

/** Adds the tokens an AI answer took to the person's count for today. */
export async function addAiTokens(userId: string, tokens: number) {
  await query(
    `insert into ai_usage (user_id, day, requests, tokens) values ($1, current_date, 0, $2)
     on conflict (user_id, day) do update set tokens = ai_usage.tokens + $2`,
    [userId, Math.round(tokens)],
  );
}
