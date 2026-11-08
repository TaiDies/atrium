// End-to-end security checks against a running server with a fresh database (CI starts one; locally,
// point it at a dev server). Creates its own throwaway accounts — never run it against a real server.
//   BASE_URL=http://localhost:3100 SERVER_LOG=server.log node test/security.integration.mjs
// SERVER_LOG is the server's output with MAIL_TRANSPORT=log, where the emailed codes appear.
import { readFileSync } from 'node:fs';

const B = process.env.BASE_URL ?? 'http://localhost:3100';
const LOG = process.env.SERVER_LOG;
const WS_BASE = B.replace(/^http/, 'ws');
const results = [];
const check = (name, ok, extra = '') => results.push({ ok, line: `${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
let ipCounter = 1;
const freshIp = () => `10.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}.9`;

async function req(path, { method = 'GET', body, cookie, ip = freshIp() } = {}) {
  const headers = { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) };
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data, cookie: sc ? sc.split(';')[0] : null, headers: r.headers };
}
const codeFor = async (email) => {
  if (!LOG) throw new Error('Set SERVER_LOG to the server output (MAIL_TRANSPORT=log) to read emailed codes');
  await sleep(700);
  const text = readFileSync(LOG, 'utf8');
  const lines = text.split('\n').filter((l) => l.includes(email));
  return (lines.join('\n').match(/\b\d{6}\b/g) ?? []).at(-1);
};
const signup = async (name) => {
  const email = `${name}-${stamp}@example.test`;
  const r = await req('/api/auth/signup', { method: 'POST', body: { email, name, password: `${name}-password-1` } });
  if (!r.cookie) throw new Error(`signup failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return { email, cookie: r.cookie, password: `${name}-password-1`, id: (await req('/api/auth/me', { cookie: r.cookie })).data.user.id };
};
const verify = async (u) => {
  await req('/api/auth/email/start', { method: 'POST', body: { email: u.email, purpose: 'verify' }, cookie: u.cookie });
  const v = await req('/api/auth/email/verify', { method: 'POST', body: { email: u.email, code: await codeFor(u.email) }, cookie: u.cookie });
  if (v.cookie) u.cookie = v.cookie;
  return v.status;
};
const opens = (url, headers) =>
  new Promise((resolve) => {
    const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
    ws.onopen = () => {
      ws.close();
      resolve(true);
    };
    ws.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 4000);
  });

// --- headers
{
  const r = await req('/api/auth/options');
  check('security headers', r.headers.get('x-frame-options') === 'SAMEORIGIN' && r.headers.get('x-content-type-options') === 'nosniff');
}

// --- password guessing from one address
{
  let last;
  const ip = freshIp();
  for (let i = 0; i < 31; i++) last = await req('/api/auth/login', { method: 'POST', body: { email: `nobody-${stamp}@example.test`, password: 'wrong-pass' }, ip });
  check('31st wrong password from one address is refused', last.status === 429, `got ${last.status}`);
}

const owner = await signup('owner');
await verify(owner);

// --- someone guessing an account's password can't lock its owner out
{
  const attacker = freshIp();
  for (let i = 0; i < 10; i++) await req('/api/auth/login', { method: 'POST', body: { email: owner.email, password: 'wrong-pass' }, ip: attacker });
  const real = await req('/api/auth/login', { method: 'POST', body: { email: owner.email, password: owner.password } });
  check('10 bad guesses from one address do not block the owner elsewhere', real.status === 200, `got ${real.status}`);
  if (real.cookie) owner.cookie = real.cookie;
}
const ws = (await req('/api/workspaces', { cookie: owner.cookie })).data.workspaces[0].id;

// --- sessions
{
  const second = await req('/api/auth/login', { method: 'POST', body: { email: owner.email, password: owner.password } });
  await req('/api/auth/logout', { method: 'POST', body: { everywhere: true }, cookie: second.cookie });
  const after = await req('/api/auth/me', { cookie: owner.cookie });
  check('sign out everywhere ends other sessions', after.status === 401, `got ${after.status}`);
  owner.cookie = (await req('/api/auth/login', { method: 'POST', body: { email: owner.email, password: owner.password } })).cookie;
}

// --- live tickets
{
  const ticket = (await req('/api/auth/live-ticket', { cookie: owner.cookie })).data?.ticket;
  const asSession = await req('/api/auth/me', { cookie: `atrium_session=${ticket}` });
  const session = owner.cookie.split('=')[1];
  check('a live ticket is not a session', !!ticket && asSession.status === 401);
  check('live socket opens with a ticket', await opens(`${WS_BASE}/live?ticket=${encodeURIComponent(ticket)}`));
  check('live socket refuses a session token in the address', !(await opens(`${WS_BASE}/live?ticket=${encodeURIComponent(session)}`)));
  const own = new URL(B).origin;
  check('a cookie websocket from this server opens', await opens(`${WS_BASE}/live`, { cookie: owner.cookie, origin: own }));
  check('a cookie websocket from another site is refused', !(await opens(`${WS_BASE}/live`, { cookie: owner.cookie, origin: 'https://evil.example' })));
  check('…on /collab too', !(await opens(`${WS_BASE}/collab`, { cookie: owner.cookie, origin: 'https://evil.example' })));
  check('a ticket websocket from the app opens', await opens(`${WS_BASE}/live?ticket=${encodeURIComponent(ticket)}`, { origin: 'http://app.localhost' }));
  check('a ticket websocket from another site is refused', !(await opens(`${WS_BASE}/live?ticket=${encodeURIComponent(ticket)}`, { origin: 'https://evil.example' })));
  const exp = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString()).exp;
  check('live tickets last a few hours', exp - Date.now() / 1000 <= 4 * 3600 + 60, `${Math.round((exp - Date.now() / 1000) / 3600)} h`);
}

// --- invitations and accounts made early by someone else
let member;
{
  const email = `member-${stamp}@example.test`;
  await req(`/api/workspaces/${ws}/members`, { method: 'POST', body: { email, role: 'member' }, cookie: owner.cookie });
  const early = await req('/api/auth/signup', { method: 'POST', body: { email, name: 'Early', password: 'someone-else-1' } });
  const inviteId = (await req('/api/invitations', { cookie: early.cookie })).data?.invitations?.[0]?.id;
  const refused = await req(`/api/invitations/${inviteId}/accept`, { method: 'POST', cookie: early.cookie });
  check('an unconfirmed account cannot accept an invitation', refused.status === 403 && refused.data?.verify === true, `got ${refused.status}`);
  await req('/api/auth/email/start', { method: 'POST', body: { email, purpose: 'login' } });
  const real = await req('/api/auth/email/verify', { method: 'POST', body: { email, code: await codeFor(email) } });
  check('the address owner signing in with a code ends the early session', (await req('/api/auth/me', { cookie: early.cookie })).status === 401);
  check('…and the early password stops working', (await req('/api/auth/login', { method: 'POST', body: { email, password: 'someone-else-1' } })).status === 401);
  const accepted = await req(`/api/invitations/${inviteId}/accept`, { method: 'POST', cookie: real.cookie });
  check('the confirmed owner can accept', accepted.status === 200, `got ${accepted.status}`);
  member = { email, cookie: real.cookie };
}

// --- events on restricted pages stay hidden
{
  const page = (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', body: { title: 'Private plans', type: 'document' }, cookie: owner.cookie })).data.page;
  await req(`/api/pages/${page.id}/permissions`, { method: 'PUT', body: { defaultAccess: 'none', members: [] }, cookie: owner.cookie });
  const day = new Date().toISOString().slice(0, 10);
  const hidden = (await req(`/api/workspaces/${ws}/events`, { method: 'POST', body: { title: `Secret ${stamp}`, startDate: day }, cookie: owner.cookie })).data.event;
  const open = (await req(`/api/workspaces/${ws}/events`, { method: 'POST', body: { title: `Open ${stamp}`, startDate: day }, cookie: owner.cookie })).data.event;
  await req(`/api/events/${hidden.id}/place`, { method: 'POST', body: { target: { pageId: page.id, position: 'end' } }, cookie: owner.cookie });
  const titles = ((await req(`/api/workspaces/${ws}/calendar?from=${day}&to=${day}`, { cookie: member.cookie })).data?.events ?? []).map((e) => e.title);
  check('an event on a restricted page is hidden from other members', !titles.includes(`Secret ${stamp}`) && titles.includes(`Open ${stamp}`), JSON.stringify(titles));
  check('…and its own address says not found', (await req(`/api/events/${hidden.id}`, { cookie: member.cookie })).status === 404);
  void open;
}

// --- outbound addresses
{
  const r = await req('/api/link-preview?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/'), { cookie: owner.cookie });
  check('link previews never reach cloud metadata', r.status === 400, `got ${r.status}`);
}

// --- public form flooding
{
  let last;
  const ip = '10.250.250.250';
  for (let i = 0; i < 31; i++) last = await req('/api/public/forms/00000000-0000-0000-0000-000000000000/x', { method: 'POST', body: { values: {} }, ip });
  check('31st public form answer from one address is refused', last.status === 429, `got ${last.status}`);
}

for (const r of results) console.log(r.line);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
