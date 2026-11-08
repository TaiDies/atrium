import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { setTokenScope } from './scope.js';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { one, query } from './db.js';
import { limiter } from './rateLimit.js';
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

/** Signs someone in on this device. The token carries their session version (see endSessions). */
export async function setSessionCookie(reply: FastifyReply, userId: string) {
  const row = await one<{ session_version: number }>('select session_version from users where id = $1', [userId]);
  const token = jwt.sign({ sub: userId, v: row?.session_version ?? 0 }, config.sessionSecret, { expiresIn: SESSION_SECONDS });
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

/** Ends every session of an account, on every device (sign-ins made before now stop working). */
export async function endSessions(userId: string) {
  await query('update users set session_version = session_version + 1 where id = $1', [userId]);
}

/**
 * A ticket for the live-editing connections only (the desktop and phone apps put it in the websocket
 * address, which can't carry the cookie). It can't be used for anything else, unlike the session.
 */
export async function liveTicket(userId: string): Promise<string> {
  const row = await one<{ session_version: number }>('select session_version from users where id = $1', [userId]);
  return jwt.sign({ sub: userId, v: row?.session_version ?? 0, use: 'live' }, config.sessionSecret, { expiresIn: '7d' });
}

/** The person a session cookie (or, with kind "live", a live-editing ticket) belongs to. */
export async function userFromToken(token: string | undefined, kind: 'session' | 'live' = 'session'): Promise<SessionUser | null> {
  if (!token) return null;
  let userId: string;
  let version: number;
  try {
    const payload = jwt.verify(token, config.sessionSecret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null;
    // Each kind only works for its own purpose.
    if ((payload.use === 'live') !== (kind === 'live')) return null;
    userId = payload.sub;
    version = typeof payload.v === 'number' ? payload.v : 0;
  } catch {
    return null;
  }
  // Accounts switched off in the admin panel are signed out everywhere, and so are sessions ended with endSessions.
  const user = await one<SessionUser>('select id, email, name, color from users where id = $1 and disabled_at is null and session_version = $2', [userId, version]);
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

/** Guessing API tokens: invalid ones per address. */
const badTokensByIp = limiter(50, 15 * 60_000);

export async function requireUser(req: FastifyRequest) {
  const bearer = req.headers.authorization;
  if (bearer) {
    if (badTokensByIp.blocked(req.ip)) throw new HttpError(429, 'Too many invalid API tokens. Wait a few minutes and try again.');
    const fromToken = await userFromApiToken(bearer);
    if (!fromToken) {
      badTokensByIp.hit(req.ip);
      throw new HttpError(401, 'That API token is not valid (it may have been deleted or have expired)');
    }
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
