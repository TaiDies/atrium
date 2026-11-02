import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { setTokenScope } from './scope.js';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { one, query } from './db.js';
import { HttpError } from './util.js';

export const SESSION_COOKIE = 'af_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  color: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser;
  }
}

export function setSessionCookie(reply: FastifyReply, userId: string) {
  const token = jwt.sign({ sub: userId }, config.sessionSecret, { expiresIn: SESSION_SECONDS });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  let userId: string;
  try {
    const payload = jwt.verify(token, config.sessionSecret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null;
    userId = payload.sub;
  } catch {
    return null;
  }
  // Accounts switched off in the admin panel are signed out everywhere.
  const user = await one<SessionUser>('select id, email, name, color from users where id = $1 and disabled_at is null', [userId]);
  if (user) touch(user.id);
  return user ?? null;
}

const lastTouched = new Map<string, number>();

/** Notes when someone was last active (at most every few minutes), for the admin panel. */
function touch(userId: string) {
  const now = Date.now();
  if (now - (lastTouched.get(userId) ?? 0) < 5 * 60_000) return;
  lastTouched.set(userId, now);
  query('update users set last_seen_at = now() where id = $1', [userId]).catch(() => {});
}

/** A personal API token ("Authorization: Bearer af_…"): acts as the person who made it. */
async function userFromApiToken(header: string | undefined): Promise<SessionUser | null> {
  const token = /^Bearer\s+(af_[A-Za-z0-9_-]{20,80})$/.exec(header ?? '')?.[1];
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  const user = await one<SessionUser & { tokenId: string; workspaceId: string | null }>(
    `select u.id, u.email, u.name, u.color, t.id as "tokenId", t.workspace_id as "workspaceId" from api_tokens t join users u on u.id = t.user_id
      where t.token_hash = $1 and u.disabled_at is null and (t.expires_at is null or t.expires_at > now())`,
    [hash],
  );
  if (!user) return null;
  query("update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')", [user.tokenId]).catch(() => {});
  touch(user.id);
  // A token limited to one workspace keeps the whole request inside it.
  setTokenScope(user.workspaceId);
  return { id: user.id, email: user.email, name: user.name, color: user.color };
}

export async function requireUser(req: FastifyRequest) {
  const bearer = req.headers.authorization;
  if (bearer) {
    const fromToken = await userFromApiToken(bearer);
    if (!fromToken) throw new HttpError(401, 'That API token is not valid (it may have been deleted or have expired)');
    req.user = fromToken;
    return;
  }
  const user = await userFromToken(req.cookies[SESSION_COOKIE]);
  if (!user) throw new HttpError(401, 'Please sign in');
  req.user = user;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}
