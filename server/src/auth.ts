import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { runWithScope } from './scope.js';
import { permissionsFor } from './roles.js';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { one, query } from './db.js';
import { limiter } from './rateLimit.js';
import { HttpError } from './util.js';

export const SESSION_COOKIE = 'atrium_session';
/**
 * The cookie's name before 1.9.0. Still read, and still set next to the new one, so older Windows and
 * Android apps (which look for this name) and browsers signed in before the rename stay signed in.
 */
const LEGACY_SESSION_COOKIE = 'af_session';

/** The session token from a request's cookies, under the current name or the old one. */
export function sessionToken(cookies: Record<string, string | undefined>): string | undefined {
  return cookies[SESSION_COOKIE] ?? cookies[LEGACY_SESSION_COOKIE];
}
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
    /** Signed in with an API token (not the app's own session). */
    viaToken?: boolean;
    /** The one workspace the API token may touch, if it's limited to one. */
    tokenScope?: string | null;
  }
}

/** Signs someone in on this device. The token carries their session version (see endSessions). */
export async function setSessionCookie(reply: FastifyReply, userId: string) {
  const row = await one<{ session_version: number }>('select session_version from users where id = $1', [userId]);
  const token = jwt.sign({ sub: userId, v: row?.session_version ?? 0 }, config.sessionSecret, { expiresIn: SESSION_SECONDS });
  const options = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: SESSION_SECONDS } as const;
  reply.setCookie(SESSION_COOKIE, token, options);
  reply.setCookie(LEGACY_SESSION_COOKIE, token, options);
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
}

/** Ends every session of an account, on every device (sign-ins made before now stop working). */
export async function endSessions(userId: string) {
  await query('update users set session_version = session_version + 1 where id = $1', [userId]);
}

/**
 * A ticket for the live-editing connections only (the desktop and phone apps put it in the websocket
 * address, which can't carry the cookie). It can't be used for anything else, unlike the session, and
 * lasts a few hours (the apps get a fresh one every hour).
 */
export async function liveTicket(userId: string): Promise<string> {
  const row = await one<{ session_version: number }>('select session_version from users where id = $1', [userId]);
  return jwt.sign({ sub: userId, v: row?.session_version ?? 0, use: 'live' }, config.sessionSecret, { expiresIn: '4h' });
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

/** A personal API token ("Authorization: Bearer atr_…", or "af_…" from before 1.9.0): acts as the person who made it. */
/** An Authorization header that carries one of this app's API tokens (any capitalisation of "Bearer"). */
export const looksLikeApiToken = (header: string | undefined) => /^bearer\s+(?:atr|af)_/i.test(header ?? '');

async function userFromApiToken(header: string | undefined): Promise<(SessionUser & { workspaceId: string | null }) | null> {
  const token = /^bearer\s+((?:atr|af)_[A-Za-z0-9_-]{20,80})\s*$/i.exec(header ?? '')?.[1];
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  // A token stops working when its owner is switched off, signs out everywhere or changes their
  // password (session_version), or loses the "API tokens" permission.
  const user = await one<SessionUser & { tokenId: string; workspaceId: string | null }>(
    `select u.id, u.email, u.name, u.color, t.id as "tokenId", t.workspace_id as "workspaceId" from api_tokens t join users u on u.id = t.user_id
      where t.token_hash = $1 and u.disabled_at is null and (t.expires_at is null or t.expires_at > now())
        and (t.session_version is null or t.session_version = u.session_version)`,
    [hash],
  );
  if (!user) return null;
  if (!(await permissionsFor(user.id)).has('api_tokens')) return null;
  query("update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')", [user.tokenId]).catch(() => {});
  touch(user.id);
  return { id: user.id, email: user.email, name: user.name, color: user.color, workspaceId: user.workspaceId };
}

/** Guessing API tokens: invalid ones per address. */
const badTokensByIp = limiter(50, 15 * 60_000);

/**
 * Signs the request in: with an API token ("Authorization: Bearer atr_…") or the app's session cookie.
 * Other Authorization headers (such as a proxy's Basic login) are ignored and don't count as guesses.
 */
export async function authenticate(req: FastifyRequest) {
  const bearer = req.headers.authorization;
  if (looksLikeApiToken(bearer)) {
    if (badTokensByIp.blocked(req.ip)) throw new HttpError(429, 'Too many invalid API tokens. Wait a few minutes and try again.');
    const fromToken = await userFromApiToken(bearer);
    if (!fromToken) {
      badTokensByIp.hit(req.ip);
      throw new HttpError(401, 'That API token is not valid (it may have been deleted, have expired, or its owner can no longer use API tokens)');
    }
    const { workspaceId, ...user } = fromToken;
    req.user = user;
    req.viaToken = true;
    req.tokenScope = workspaceId;
    return;
  }
  const user = await userFromToken(sessionToken(req.cookies));
  if (!user) throw new HttpError(401, 'Please sign in');
  req.user = user;
  req.viaToken = false;
  req.tokenScope = null;
}

/** preHandler: signs the request in, then runs the rest of it with an API token's workspace limit in force. */
export function requireUser(req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) {
  authenticate(req).then(
    () => runWithScope(req.tokenScope ?? null, done),
    (err) => done(err),
  );
}

/** preHandler (after requireUser): for things only the person in the app may do, never an API token. */
export async function requireSession(req: FastifyRequest) {
  if (req.viaToken || looksLikeApiToken(req.headers.authorization)) throw new HttpError(403, 'This can only be done in the app, not with an API token');
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

/** Hosts the desktop and phone apps load their pages from (Tauri's custom protocol). */
const APP_HOSTS = new Set(['app.localhost', 'tauri.localhost']);
const APP_PROTOCOLS = new Set(['app:', 'tauri:']);

/**
 * Whether a websocket may connect from where it says it comes from. A browser always sends Origin, so a
 * cookie connection must come from this server's own address (PUBLIC_URL or the Host it was reached at):
 * another site can't use a visitor's cookie for live editing. A ticket connection (the apps) may also
 * come from the apps' own origins. No Origin at all is a client outside a browser, which has no cookie
 * to borrow.
 */
export function websocketOriginOk(headers: { origin?: string; host?: string }, viaTicket: boolean): boolean {
  const origin = headers.origin;
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const own = new Set([headers.host?.toLowerCase()]);
  if (config.publicUrl) own.add(new URL(config.publicUrl).host.toLowerCase());
  if (own.has(url.host.toLowerCase())) return true;
  // Development: the web app on another local port (Vite) talking to a server on this machine.
  const local = (h?: string) => !!h && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h);
  if (local(url.host) && local(headers.host)) return true;
  return viaTicket && (APP_HOSTS.has(url.hostname.toLowerCase()) || APP_PROTOCOLS.has(url.protocol));
}
