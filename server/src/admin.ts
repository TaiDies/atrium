import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import bcrypt from 'bcryptjs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { aiAccess, complete, decryptKey, encryptKey, listModels, maskKey, PROVIDERS, type Provider } from './ai.js';
import { closeUserSessions } from './collab.js';
import { config } from './config.js';
import { one, query, tx } from './db.js';
import { createAccount } from './routes/auth.js';
import { getSettings, type Limits, setSetting } from './settings.js';
import { LIMIT_KEYS, limitsFor, resolve, usageFor } from './limits.js';
import { mailEnabled, sendMail, verifyMail } from './mail.js';
import { checkForUpdate, requestUpdate, updateStatus } from './updates.js';
import { email, escapeLike, handleError, HttpError, idParams, parse } from './util.js';
import { getRole, isPermission, listRoles, PERMISSIONS } from './roles.js';

// The admin panel: a separate server on its own port (ADMIN_PORT) for managing accounts and the AI
// connection offered to everyone. Nothing here is reachable from the main app's port.

const COOKIE = 'af_admin';
const SESSION_SECONDS = 12 * 60 * 60;
const adminSecret = () => `${config.sessionSecret}:admin`;

/** The panel's password: ADMIN_PASSWORD, or the one saved in settings (made on first start). */
async function checkPassword(given: string): Promise<boolean> {
  if (config.admin.password) {
    const a = Buffer.from(given);
    const b = Buffer.from(config.admin.password);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const hash = (await getSettings()).adminPasswordHash;
  return !!hash && bcrypt.compare(given, hash);
}

/** On first start without ADMIN_PASSWORD: makes a password and prints it once. */
/** Where a generated password is kept until it's changed in the panel (survives rebuilds; logs don't). */
const passwordFile = () => path.join(config.dataDir, 'admin-password.txt');

/** On first start without ADMIN_PASSWORD: makes a password, prints it and keeps it in the data folder. */
async function ensurePassword(log: (msg: string) => void) {
  if (config.admin.password) return;
  if ((await getSettings()).adminPasswordHash) {
    if (existsSync(passwordFile())) log(`Admin panel password: see ${passwordFile()} (it's removed once you change the password in the panel)`);
    return;
  }
  const password = randomBytes(9).toString('base64url');
  await setSetting('adminPasswordHash', await bcrypt.hash(password, 10));
  await writeFile(passwordFile(), `${password}\n`, { mode: 0o600 });
  log(`Admin panel password (change it in the panel): ${password} — also saved in ${passwordFile()}`);
}

const attempts = new Map<string, number[]>();
function allowAttempt(ip: string) {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length <= 10;
}

async function requireAdmin(req: FastifyRequest) {
  const token = req.cookies[COOKIE];
  try {
    if (token && typeof jwt.verify(token, adminSecret()) !== 'string') return;
  } catch {
    // fall through
  }
  throw new HttpError(401, 'Please sign in');
}

function setAdminCookie(reply: FastifyReply) {
  reply.setCookie(COOKIE, jwt.sign({ admin: true }, adminSecret(), { expiresIn: SESSION_SECONDS }), {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secureCookies,
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}

/** Deletes a workspace and its uploaded files. */
async function deleteWorkspace(workspaceId: string) {
  const files = await query<{ id: string }>('select id from files where workspace_id = $1', [workspaceId]);
  await query('delete from workspaces where id = $1', [workspaceId]);
  await Promise.allSettled(files.map((f) => unlink(path.join(config.uploadDir, f.id))));
}

const aiBody = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1, 'Choose a model').max(200),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Use a full address starting with http:// or https://')
    .nullable()
    .optional(),
  key: z.string().trim().max(500).optional(),
  allowOwn: z.boolean().default(true),
});

/** A limit: a whole number, or null for unlimited. */
const limitValue = z.number().int().min(0).max(100_000_000_000).nullable();
const limitsBody = z.object({
  workspaces: limitValue.optional(),
  storageMb: limitValue.optional(),
  uploadMb: limitValue.optional(),
  members: limitValue.optional(),
  aiTokensPerDay: limitValue.optional(),
  aiTokensPerMonth: limitValue.optional(),
});
/** For one person: also "default" (use the server's default). */
const userLimit = z.union([limitValue, z.literal('default')]);

const mailBody = z.object({
  host: z.string().trim().min(1, 'Enter the mail server').max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(255),
  /** Omit to keep the saved password; '' removes it. */
  password: z.string().max(500).optional(),
  from: z.string().trim().max(255),
});

export async function startAdminServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  app.setErrorHandler(handleError);
  await ensurePassword((msg) => app.log.warn(msg));

  await app.register(
    async (api) => {
      api.post('/login', async (req, reply) => {
        if (!allowAttempt(req.ip)) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
        const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
        if (!(await checkPassword(password))) throw new HttpError(401, 'Wrong password');
        setAdminCookie(reply);
        return { ok: true };
      });

      api.post('/logout', async (_req, reply) => {
        reply.clearCookie(COOKIE, { path: '/' });
        return { ok: true };
      });

      await api.register(async (secured) => {
        secured.addHook('preHandler', requireAdmin);

        secured.get('/overview', async () => {
          const counts = await one<{ users: number; active: number; disabled: number; workspaces: number; pages: number; files: number; storage: string }>(
            `select (select count(*)::int from users) as users,
                    (select count(*)::int from users where last_seen_at > now() - interval '7 days') as active,
                    (select count(*)::int from users where disabled_at is not null) as disabled,
                    (select count(*)::int from workspaces) as workspaces,
                    (select count(*)::int from pages where deleted_at is null) as pages,
                    (select count(*)::int from files) as files,
                    (select coalesce(sum(size), 0)::text from files) as storage`,
          );
          return { ...counts!, storage: Number(counts!.storage), appName: config.appName };
        });

        // ----- accounts -----

        secured.get('/users', async (req) => {
          const { q, offset } = parse(z.object({ q: z.string().max(200).default(''), offset: z.coerce.number().int().min(0).default(0) }), req.query);
          const like = `%${escapeLike(q.trim())}%`;
          const users = await query(
            `select u.id, u.name, u.email, u.color, u.created_at as "createdAt", u.last_seen_at as "lastSeenAt",
                    u.email_verified_at is not null as verified, u.disabled_at is not null as disabled, u.password_hash is not null as "hasPassword",
                    (select count(*)::int from workspace_members m where m.user_id = u.id) as workspaces,
                    (select coalesce(sum(size), 0)::bigint from files f where f.uploaded_by = u.id) as storage,
                    exists (select 1 from ai_connections a where a.user_id = u.id) as "ownAi",
                    (select coalesce(array_agg(ur.role_id), '{}') from user_roles ur where ur.user_id = u.id) as "roleIds",
                    (select count(*)::int from workspace_members m where m.user_id = u.id and m.role = 'owner') as "ownedWorkspaces",
                    u.limits
               from users u
              where u.name ilike $1 or u.email ilike $1
              order by u.created_at desc
              limit 51 offset $2`,
            [like, offset],
          );
          const defaults = (await getSettings()).defaultLimits;
          return {
            users: users.slice(0, 50).map((u) => ({ ...u, storage: Number(u.storage), limits: resolve(u.limits ?? {}, defaults), ownLimits: u.limits ?? {} })),
            more: users.length > 50,
          };
        });

        secured.get('/users/:id', async (req) => {
          const { id } = parse(idParams, req.params);
          const user = await one(
            `select id, name, email, created_at as "createdAt", last_seen_at as "lastSeenAt", email_verified_at is not null as verified,
                    disabled_at is not null as disabled, password_hash is not null as "hasPassword" from users where id = $1`,
            [id],
          );
          if (!user) throw new HttpError(404, 'Account not found');
          const workspaces = await query(
            `select w.id, w.name, w.icon, m.role, (select count(*)::int from workspace_members x where x.workspace_id = w.id) as members,
                    (select count(*)::int from pages p where p.workspace_id = w.id and p.deleted_at is null) as pages
               from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = $1 order by w.created_at`,
            [id],
          );
          const ai = await aiAccess(id);
          const own = (await one<{ limits: Limits }>('select limits from users where id = $1', [id]))?.limits ?? {};
          return { user, workspaces, ai: { own: ai.own, source: ai.active?.source ?? null }, limits: await limitsFor(id), ownLimits: own, usage: await usageFor(id),
            roleIds: (await query<{ role_id: string }>('select role_id from user_roles where user_id = $1', [id])).map((r) => r.role_id) };
        });

        secured.post('/users', async (req, reply) => {
          const body = parse(
            z.object({
              email,
              name: z.string().trim().min(1, 'Name is required').max(80),
              password: z.string().min(8, 'Password must be at least 8 characters').max(200).nullable().optional(),
            }),
            req.body,
          );
          if (await one('select 1 from users where email = $1', [body.email])) throw new HttpError(409, 'An account with this email already exists');
          const hash = body.password ? await bcrypt.hash(body.password, 10) : null;
          const user = await tx((c) => createAccount(c, body.email, body.name, hash, true));
          return reply.code(201).send({ user });
        });

        secured.patch('/users/:id', async (req) => {
          const { id } = parse(idParams, req.params);
          const body = parse(
            z.object({
              name: z.string().trim().min(1).max(80).optional(),
              email: email.optional(),
              disabled: z.boolean().optional(),
              verified: z.boolean().optional(),
              password: z.string().min(8, 'Password must be at least 8 characters').max(200).optional(),
            }),
            req.body,
          );
          const user = await one('select 1 from users where id = $1', [id]);
          if (!user) throw new HttpError(404, 'Account not found');
          if (body.email && (await one('select 1 from users where email = $1 and id <> $2', [body.email, id]))) throw new HttpError(409, 'Another account uses that email');
          if (body.name !== undefined) await query('update users set name = $2 where id = $1', [id, body.name]);
          if (body.email !== undefined) await query('update users set email = $2 where id = $1', [id, body.email]);
          if (body.verified !== undefined) await query(`update users set email_verified_at = ${body.verified ? 'coalesce(email_verified_at, now())' : 'null'} where id = $1`, [id]);
          if (body.password !== undefined) await query('update users set password_hash = $2 where id = $1', [id, await bcrypt.hash(body.password, 10)]);
          if (body.disabled !== undefined) {
            await query(`update users set disabled_at = ${body.disabled ? 'coalesce(disabled_at, now())' : 'null'} where id = $1`, [id]);
            if (body.disabled) closeUserSessions(id);
          }
          return { ok: true };
        });

        /**
         * Deletes an account. Workspaces only they belong to go too; where others remain but nobody else
         * owns it, the longest-standing member becomes an owner.
         */
        secured.delete('/users/:id', async (req) => {
          const { id } = parse(idParams, req.params);
          const memberships = await query<{ workspace_id: string; others: number; other_owners: number }>(
            `select m.workspace_id,
                    (select count(*)::int from workspace_members x where x.workspace_id = m.workspace_id and x.user_id <> $1) as others,
                    (select count(*)::int from workspace_members x where x.workspace_id = m.workspace_id and x.user_id <> $1 and x.role = 'owner') as other_owners
               from workspace_members m where m.user_id = $1`,
            [id],
          );
          closeUserSessions(id);
          for (const m of memberships) {
            if (m.others === 0) await deleteWorkspace(m.workspace_id);
            else if (m.other_owners === 0) {
              await query(
                `update workspace_members set role = 'owner'
                  where workspace_id = $1 and user_id = (select user_id from workspace_members where workspace_id = $1 and user_id <> $2 order by joined_at limit 1)`,
                [m.workspace_id, id],
              );
            }
          }
          await query('delete from users where id = $1', [id]);
          return { ok: true };
        });

        // ----- workspaces -----

        secured.get('/workspaces', async () => {
          const workspaces = await query(
            `select w.id, w.name, w.icon, w.created_at as "createdAt",
                    (select count(*)::int from workspace_members m where m.workspace_id = w.id) as members,
                    (select count(*)::int from pages p where p.workspace_id = w.id and p.deleted_at is null) as pages,
                    (select coalesce(sum(size), 0)::bigint from files f where f.workspace_id = w.id) as storage,
                    (select string_agg(u.name, ', ') from workspace_members m join users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner') as owners
               from workspaces w order by w.created_at desc limit 500`,
          );
          return { workspaces: workspaces.map((w) => ({ ...w, storage: Number(w.storage) })) };
        });

        secured.delete('/workspaces/:id', async (req) => {
          const { id } = parse(idParams, req.params);
          await deleteWorkspace(id);
          return { ok: true };
        });

        // ----- settings -----

        // ----- roles -----

        secured.get('/roles', async () => ({ roles: await listRoles(), permissions: PERMISSIONS }));
        const roleBody = z.object({
          name: z.string().trim().min(1).max(60),
          description: z.string().max(300).default(''),
          permissions: z.array(z.string()).max(50).default([]),
          limits: limitsBody.default({}),
        });
        secured.post('/roles', async (req) => {
          const b = parse(roleBody, req.body);
          const r = await one<{ id: string }>(
            `insert into roles (name, description, permissions, limits, position) values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from roles)) returning id`,
            [b.name, b.description, b.permissions.filter(isPermission), JSON.stringify(b.limits)],
          );
          return { id: r!.id };
        });
        secured.put('/roles/:id', async (req) => {
          const { id } = parse(idParams, req.params);
          const role = await getRole(id);
          const b = parse(roleBody, req.body);
          await query('update roles set name = $2, description = $3, permissions = $4, limits = $5 where id = $1', [
            id,
            role.isDefault ? 'Everyone' : b.name,
            b.description,
            b.permissions.filter(isPermission),
            JSON.stringify(b.limits),
          ]);
          return { ok: true };
        });
        secured.delete('/roles/:id', async (req) => {
          const { id } = parse(idParams, req.params);
          if ((await getRole(id)).isDefault) throw new HttpError(400, 'The Everyone role can’t be deleted');
          await query('delete from roles where id = $1', [id]);
          return { ok: true };
        });
        // Giving roles to people (or taking them away), one or many at once.
        secured.put('/users/roles', async (req) => {
          const b = parse(z.object({ userIds: z.array(z.uuid()).min(1).max(1000), add: z.array(z.uuid()).default([]), remove: z.array(z.uuid()).default([]) }), req.body);
          for (const roleId of b.add) {
            await query(`insert into user_roles (user_id, role_id) select u, $2 from unnest($1::uuid[]) u on conflict do nothing`, [b.userIds, roleId]);
          }
          if (b.remove.length) await query('delete from user_roles where user_id = any($1::uuid[]) and role_id = any($2::uuid[])', [b.userIds, b.remove]);
          return { ok: true };
        });

        // ----- updates -----

        secured.get('/updates', async () => updateStatus());
        secured.post('/updates/check', async () => {
          await checkForUpdate();
          return updateStatus();
        });
        secured.put('/settings/updates', async (req) => {
          const body = parse(z.object({ email: z.union([z.literal(''), z.string().trim().email().max(200)]), auto: z.boolean() }), req.body);
          await setSetting('updates', { ...(await getSettings()).updates, email: body.email, auto: body.auto });
          return updateStatus();
        });
        secured.post('/updates/run', async () => {
          const s = await updateStatus();
          if (!s.updater.canUpdate) throw new HttpError(400, s.updater.reason ?? 'The updater isn’t available');
          await requestUpdate(s.latest?.version ?? null);
          return updateStatus();
        });

        secured.get('/settings', async () => {
          const s = await getSettings();
          return {
            allowSignups: s.allowSignups,
            passwordFromEnv: !!config.admin.password,
            ai: s.ai ? { provider: s.ai.provider, model: s.ai.model, baseUrl: s.ai.baseUrl, keyHint: maskKey(decryptKey(s.ai.keyEnc)), allowOwn: s.ai.allowOwn } : null,
          };
        });

        secured.put('/settings/signups', async (req) => {
          const { allowSignups } = parse(z.object({ allowSignups: z.boolean() }), req.body);
          await setSetting('allowSignups', allowSignups);
          return { ok: true };
        });

        secured.put('/settings/ai', async (req) => {
          const body = parse(aiBody, req.body);
          const current = (await getSettings()).ai;
          const keyEnc = body.key === undefined ? (current?.keyEnc ?? null) : body.key ? encryptKey(body.key) : null;
          if (!keyEnc && body.provider !== 'openai') throw new HttpError(400, 'Enter the API key');
          await setSetting('ai', { provider: body.provider, model: body.model, baseUrl: body.baseUrl || null, keyEnc, allowOwn: body.allowOwn });
          return { ok: true };
        });

        secured.delete('/settings/ai', async () => {
          await setSetting('ai', null);
          return { ok: true };
        });

        secured.post('/ai/models', async (req) => {
          const body = parse(aiBody.pick({ provider: true, baseUrl: true, key: true }), req.body);
          const saved = (await getSettings()).ai;
          const key = body.key || (saved?.provider === body.provider ? decryptKey(saved.keyEnc) : null);
          return { models: await listModels({ provider: body.provider, model: '', baseUrl: body.baseUrl || null, key }) };
        });

        /** Sends a tiny request through the saved connection to check it works. */
        secured.post('/ai/test', async () => {
          const s = (await getSettings()).ai;
          if (!s) throw new HttpError(400, 'No AI connection is set up');
          const answer = await complete(
            { provider: s.provider as Provider, model: s.model, baseUrl: s.baseUrl, key: decryptKey(s.keyEnc), source: 'shared' },
            'Reply with the single word OK.',
            [{ role: 'user', content: 'Are you there?' }],
          );
          return { ok: true, answer: answer.slice(0, 200) };
        });

        // ----- limits -----

        /** The limits everyone gets unless they have their own. */
        secured.get('/settings/limits', async () => ({ defaults: (await getSettings()).defaultLimits, keys: LIMIT_KEYS }));

        secured.put('/settings/limits', async (req) => {
          const { defaults } = parse(z.object({ defaults: limitsBody }), req.body);
          await setSetting('defaultLimits', defaults);
          return { ok: true };
        });

        /**
         * Sets limits for several people at once. Each key: a number, null (unlimited) or "default" (use the
         * server's default); keys left out are kept as they are.
         */
        secured.put('/users/limits', async (req) => {
          const body = parse(
            z.object({
              userIds: z.array(z.uuid()).min(1).max(1000),
              limits: z.object({
                workspaces: userLimit.optional(),
                storageMb: userLimit.optional(),
                uploadMb: userLimit.optional(),
                members: userLimit.optional(),
                aiTokensPerDay: userLimit.optional(),
                aiTokensPerMonth: userLimit.optional(),
              }),
            }),
            req.body,
          );
          const rows = await query<{ id: string; limits: Limits }>('select id, limits from users where id = any($1::uuid[])', [body.userIds]);
          for (const r of rows) {
            const next: Limits = { ...r.limits };
            for (const k of LIMIT_KEYS) {
              const v = body.limits[k];
              if (v === undefined) continue;
              if (v === 'default') delete next[k];
              else next[k] = v;
            }
            await query('update users set limits = $2 where id = $1', [r.id, JSON.stringify(next)]);
          }
          return { ok: true, updated: rows.length };
        });

        // ----- email -----

        secured.get('/settings/mail', async () => {
          const s = await getSettings();
          const m = s.mail;
          return {
            mail: m ? { host: m.host, port: m.port, secure: m.secure, user: m.user, from: m.from, hasPassword: !!m.passwordEnc } : null,
            fromEnvironment: !m && !!config.mail.transport,
            requireEmailVerification: s.requireEmailVerification ?? config.requireEmailVerification,
          };
        });

        secured.put('/settings/mail', async (req) => {
          const body = parse(mailBody, req.body);
          const current = (await getSettings()).mail;
          const passwordEnc = body.password === undefined ? (current?.passwordEnc ?? null) : body.password ? encryptKey(body.password) : null;
          const next = { host: body.host, port: body.port, secure: body.secure, user: body.user, from: body.from, passwordEnc };
          // Check it works before saving (signing in to the mail server; nothing is sent).
          try {
            await verifyMail({ transport: 'smtp', host: next.host, port: next.port, secure: next.secure, user: next.user, password: decryptKey(passwordEnc) ?? '', from: next.from });
          } catch (err) {
            throw new HttpError(400, `Couldn't connect to the mail server: ${err instanceof Error ? err.message : String(err)}`);
          }
          await setSetting('mail', next);
          return { ok: true };
        });

        secured.delete('/settings/mail', async () => {
          await setSetting('mail', null);
          return { ok: true };
        });

        secured.put('/settings/verification', async (req) => {
          const { required } = parse(z.object({ required: z.boolean() }), req.body);
          await setSetting('requireEmailVerification', required);
          return { ok: true };
        });

        secured.post('/mail/test', async (req) => {
          const { to } = parse(z.object({ to: email }), req.body);
          if (!(await mailEnabled())) throw new HttpError(400, 'Set up email first');
          try {
            await sendMail(
              to,
              `Test email from ${config.appName}`,
              `Email from ${config.appName} is working. Sign-in codes and invitations will be sent from this address.`,
              `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;color:#222"><p>Email from <b>${config.appName.replace(/[<>&"]/g, '')}</b> is working.</p><p>Sign-in codes and invitations will be sent from this address.</p></div>`,
            );
          } catch (err) {
            throw new HttpError(400, `Sending failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return { ok: true };
        });

        secured.put('/password', async (req) => {
          if (config.admin.password) throw new HttpError(400, 'The password is set with ADMIN_PASSWORD on the server; change it there');
          const body = parse(z.object({ current: z.string().max(200), next: z.string().min(10, 'Use at least 10 characters').max(200) }), req.body);
          if (!(await checkPassword(body.current))) throw new HttpError(401, 'The current password is wrong');
          await setSetting('adminPasswordHash', await bcrypt.hash(body.next, 10));
          await unlink(passwordFile()).catch(() => {});
          return { ok: true };
        });
      });
    },
    { prefix: '/admin-api' },
  );

  // The panel's page (built with the web app as admin.html).
  if (existsSync(path.join(config.webDir, 'admin.html'))) {
    await app.register(fastifyStatic, { root: config.webDir, index: false, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/admin-api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.header('Cache-Control', 'no-cache').sendFile('admin.html');
    });
  }

  await app.listen({ port: config.admin.port, host: config.admin.host });
  return app;
}
