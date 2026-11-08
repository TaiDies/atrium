import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSessionCookie, endSessions, liveTicket, requireUser, sessionToken, setSessionCookie, type SessionUser, userFromToken } from '../auth.js';
import { closeUserSessions } from '../collab.js';
import { config } from '../config.js';
import { one, query, type Queryable, tx } from '../db.js';
import { codeEmail, mailEnabled, sendMail, verificationRequired } from '../mail.js';
import { getSettings } from '../settings.js';
import { limitsFor, usageFor } from '../limits.js';
import { colorFor, email, HttpError, parse } from '../util.js';
import { permissionsFor } from '../roles.js';
import { limiter } from '../rateLimit.js';

const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const name = z.string().trim().min(1, 'Name is required').max(80);
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;

/** Codes are stored hashed (with the server's secret), never as sent. */
const hashCode = (address: string, value: string) => createHmac('sha256', config.sessionSecret).update(`${address}:${value}`).digest('hex');

// Rate limits for sending codes: per address (stored) and per IP (in memory).
const sentByIp = new Map<string, number[]>();
function allowIp(ip: string) {
  const now = Date.now();
  const recent = (sentByIp.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  if (recent.length >= 20) return false;
  recent.push(now);
  sentByIp.set(ip, recent);
  return true;
}

/** A new account with its own workspace. Invitations sent before it existed wait under the bell. */
export async function createAccount(c: Queryable, address: string, displayName: string, passwordHash: string | null, verified: boolean) {
  const user = (await one<SessionUser>(
    `insert into users (email, name, password_hash, color, email_verified_at) values ($1, $2, $3, $4, ${verified ? 'now()' : 'null'})
     returning id, email, name, color`,
    [address, displayName, passwordHash, colorFor(address)],
    c,
  ))!;
  const ws = (await one<{ id: string }>(
    `insert into workspaces (name, icon, created_by) values ($1, '🏠', $2) returning id`,
    [`${displayName.split(' ')[0]}'s Workspace`, user.id],
    c,
  ))!;
  await query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws.id, user.id], c);
  await query(`insert into pages (workspace_id, title, icon, created_by, updated_by) values ($1, 'Getting started', '👋', $2, $2)`, [ws.id, user.id], c);
  return user;
}

/** Emails a new code (and retires older unused ones for the same address). */
async function sendCode(address: string, purpose: 'login' | 'signup' | 'verify', ip: string, displayName?: string) {
  if (!(await mailEnabled())) throw new HttpError(400, 'Email codes are not set up on this server');
  const recent = await one<{ n: string }>(`select count(*) as n from email_codes where email = $1 and created_at > now() - interval '15 minutes'`, [address]);
  if (Number(recent?.n ?? 0) >= 5 || !allowIp(ip)) throw new HttpError(429, 'Too many codes requested. Try again in a few minutes.');
  const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await query('update email_codes set used_at = now() where email = $1 and used_at is null', [address]);
  await query(`insert into email_codes (email, code_hash, purpose, name, expires_at) values ($1, $2, $3, $4, now() + interval '${CODE_MINUTES} minutes')`, [
    address,
    hashCode(address, value),
    purpose,
    displayName ?? null,
  ]);
  const mail = codeEmail(value, purpose);
  try {
    await sendMail(address, mail.subject, mail.text, mail.html);
  } catch (err) {
    console.error('Could not send email', err);
    throw new HttpError(502, 'The email could not be sent. Check the server’s email settings.');
  }
}

const mustVerify = verificationRequired;

// Guessing passwords and codes: failed tries per address and per account, and new accounts per address.
const failedByIp = limiter(30, 15 * 60_000);
const failedByAccount = limiter(10, 15 * 60_000);
const signupsByIp = limiter(10, 60 * 60_000);
const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';

const DISABLED = 'This account has been switched off. Ask the administrator.';

/** When the admin has closed sign-ups, only people with an invitation can make an account. */
async function checkSignupAllowed(address: string) {
  if ((await getSettings()).allowSignups) return;
  if (await one('select 1 from workspace_invites where email = $1', [address])) return;
  throw new HttpError(403, 'New accounts can only be made with an invitation on this server');
}

export async function authRoutes(app: FastifyInstance) {
  // What the sign-in screen can offer on this server.
  app.get('/auth/options', async () => ({
    emailCodes: await mailEnabled(),
    requireEmailVerification: await mustVerify(),
    appName: config.appName,
    signups: (await getSettings()).allowSignups,
  }));

  app.post('/auth/signup', async (req, reply) => {
    const body = parse(z.object({ email, name, password }), req.body);
    if (!signupsByIp.take(req.ip)) throw new HttpError(429, TOO_MANY);
    const existing = await one('select 1 from users where email = $1', [body.email]);
    if (existing) throw new HttpError(409, 'An account with this email already exists');
    await checkSignupAllowed(body.email);

    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await tx((c) => createAccount(c, body.email, body.name, passwordHash, false));
    if ((await mustVerify())) {
      // The account exists, but can only be used once the email is confirmed.
      await sendCode(body.email, 'verify', req.ip);
      return reply.code(202).send({ verify: true, email: body.email });
    }
    await setSessionCookie(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = parse(z.object({ email, password: z.string().min(1, 'Password is required') }), req.body);
    if (failedByIp.blocked(req.ip) || failedByAccount.blocked(body.email)) throw new HttpError(429, TOO_MANY);
    const row = await one<SessionUser & { password_hash: string | null; email_verified_at: Date | null; disabled_at: Date | null }>(
      'select id, email, name, color, password_hash, email_verified_at, disabled_at from users where email = $1',
      [body.email],
    );
    const ok = row?.password_hash ? await bcrypt.compare(body.password, row.password_hash) : false;
    if (!row || !ok) {
      failedByIp.hit(req.ip);
      failedByAccount.hit(body.email);
    }
    if (!row || !ok) throw new HttpError(401, row && !row.password_hash ? 'This account signs in with an email code' : 'Incorrect email or password');
    if (row.disabled_at) throw new HttpError(403, DISABLED);
    if ((await mustVerify()) && !row.email_verified_at) {
      await sendCode(body.email, 'verify', req.ip);
      return reply.code(403).send({ error: 'Confirm your email to continue — we’ve sent you a code', verify: true, email: body.email });
    }
    failedByAccount.clear(body.email);
    await setSessionCookie(reply, row.id);
    const { password_hash: _, email_verified_at: __, disabled_at: ___, ...user } = row;
    return { user };
  });

  /**
   * Starts signing in (or up) with an emailed code. For an address with no account yet, the reply says
   * so, and the screen asks for a name and starts again with purpose "signup".
   */
  app.post('/auth/email/start', async (req) => {
    const body = parse(z.object({ email, purpose: z.enum(['login', 'signup', 'verify']).default('login'), name: name.optional() }), req.body);
    const user = await one<{ id: string; disabled_at: Date | null }>('select id, disabled_at from users where email = $1', [body.email]);
    if (user?.disabled_at) throw new HttpError(403, DISABLED);
    if (!user && body.purpose !== 'signup') return { sent: false, newAccount: true };
    if (!user && !body.name) throw new HttpError(400, 'Name is required');
    if (!user) await checkSignupAllowed(body.email);
    await sendCode(body.email, user ? (body.purpose === 'verify' ? 'verify' : 'login') : 'signup', req.ip, body.name);
    return { sent: true, newAccount: !user };
  });

  // Finishes it: a correct code signs in (confirming the email) or creates the account.
  app.post('/auth/email/verify', async (req, reply) => {
    const body = parse(z.object({ email, code }), req.body);
    if (failedByIp.blocked(req.ip)) throw new HttpError(429, TOO_MANY);
    const row = await one<{ id: string; code_hash: string; purpose: string; name: string | null; attempts: number }>(
      `select id, code_hash, purpose, name, attempts from email_codes
        where email = $1 and used_at is null and expires_at > now() order by created_at desc limit 1`,
      [body.email],
    );
    if (!row) throw new HttpError(400, 'That code has expired. Ask for a new one.');
    if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many tries. Ask for a new code.');
    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(hashCode(body.email, body.code), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      await query('update email_codes set attempts = attempts + 1 where id = $1', [row.id]);
      failedByIp.hit(req.ip);
      throw new HttpError(400, 'That code isn’t right');
    }
    await query('update email_codes set used_at = now() where id = $1', [row.id]);

    const disabled = await one('select 1 from users where email = $1 and disabled_at is not null', [body.email]);
    if (disabled) throw new HttpError(403, DISABLED);
    let user = await one<SessionUser>('select id, email, name, color from users where email = $1', [body.email]);
    let created = false;
    if (user) {
      const before = await one<{ email_verified_at: Date | null; password_hash: string | null }>('select email_verified_at, password_hash from users where id = $1', [user.id]);
      const signedInHere = (await userFromToken(sessionToken(req.cookies)))?.id === user.id;
      if (!before?.email_verified_at && before?.password_hash && !signedInHere) {
        // The first proof that this person owns the address, on an account made with a password: the
        // password may have been set by someone else who signed up with this email first. Drop it and
        // end their sessions; the owner can set a new password in their settings. (Someone already
        // signed in with that password who now proves the address too is the owner: nothing changes.)
        await query('update users set password_hash = null where id = $1', [user.id]);
        await endSessions(user.id);
        closeUserSessions(user.id);
      }
      await query('update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1', [user.id]);
    } else {
      if (row.purpose !== 'signup' || !row.name) throw new HttpError(400, 'Ask for a new code to create your account');
      user = await tx((c) => createAccount(c, body.email, row.name!, null, true));
      created = true;
    }
    await setSessionCookie(reply, user.id);
    return reply.code(created ? 201 : 200).send({ user });
  });

  app.post('/auth/logout', async (req, reply) => {
    // "Sign out everywhere" ends this person's sessions on all devices.
    const { everywhere } = parse(z.object({ everywhere: z.boolean().optional() }), req.body ?? {});
    if (everywhere) {
      const user = await userFromToken(sessionToken(req.cookies));
      if (user) {
        await endSessions(user.id);
        closeUserSessions(user.id);
      }
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireUser }, async (req) => ({ user: req.user }));

  // For the desktop and phone apps: a ticket that only opens the live-editing connections.
  app.get('/auth/live-ticket', { preHandler: requireUser }, async (req) => ({ ticket: await liveTicket(req.user.id) }));

  // What this person may do (from their roles), so the app can hide what isn't allowed.
  app.get('/auth/me/permissions', { preHandler: requireUser }, async (req) => ({ permissions: [...(await permissionsFor(req.user.id))] }));

  // Appearance and language (theme, colours, font, sizes, language…), the same on every device. Each
  // device sends what it has; the stored copy is merged and returned.
  app.get('/auth/me/prefs', { preHandler: requireUser }, async (req) => {
    const row = await one<{ prefs: Record<string, string> }>('select prefs from users where id = $1', [req.user.id]);
    return { prefs: row?.prefs ?? {} };
  });
  app.put('/auth/me/prefs', { preHandler: requireUser }, async (req) => {
    const body = parse(z.object({ prefs: z.record(z.string().max(64), z.string().max(4000).nullable()) }), req.body);
    const set = Object.fromEntries(Object.entries(body.prefs).filter(([, v]) => v !== null));
    const removed = Object.entries(body.prefs).filter(([, v]) => v === null).map(([k]) => k);
    const row = await one<{ prefs: Record<string, string> }>(
      `update users set prefs = (prefs || $2::jsonb) - $3::text[] where id = $1 returning prefs`,
      [req.user.id, JSON.stringify(set), removed],
    );
    return { prefs: row?.prefs ?? {} };
  });

  // This person's limits (set by the admin) and how much of each they use.
  app.get('/auth/me/usage', { preHandler: requireUser }, async (req) => {
    // People in each workspace this person owns (members and pending invitations, as the limit counts them).
    const owned = await query<{ id: string; name: string; people: number }>(
      `select w.id, w.name,
              (select count(*)::int from workspace_members m where m.workspace_id = w.id)
            + (select count(*)::int from workspace_invites i where i.workspace_id = w.id) as people
         from workspaces w join workspace_members o on o.workspace_id = w.id and o.user_id = $1 and o.role = 'owner'
        order by w.created_at`,
      [req.user.id],
    );
    return { limits: await limitsFor(req.user.id), usage: { ...(await usageFor(req.user.id)), owned } };
  });

  app.patch('/auth/me', { preHandler: requireUser }, async (req) => {
    const body = parse(z.object({ name }), req.body);
    const user = await one<SessionUser>('update users set name = $2 where id = $1 returning id, email, name, color', [req.user.id, body.name]);
    return { user };
  });

  app.post('/auth/password', { preHandler: requireUser }, async (req, reply) => {
    const body = parse(z.object({ currentPassword: z.string().optional(), newPassword: password }), req.body);
    const row = (await one<{ password_hash: string | null }>('select password_hash from users where id = $1', [req.user.id]))!;
    // Accounts made with an email code can set a first password without a current one.
    if (row.password_hash && !(await bcrypt.compare(body.currentPassword ?? '', row.password_hash))) {
      throw new HttpError(400, 'Current password is incorrect');
    }
    await query('update users set password_hash = $2 where id = $1', [req.user.id, await bcrypt.hash(body.newPassword, 10)]);
    // A new password signs out every other device; this one gets a fresh session.
    await endSessions(req.user.id);
    closeUserSessions(req.user.id);
    await setSessionCookie(reply, req.user.id);
    return { ok: true };
  });
}
