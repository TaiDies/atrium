// End-to-end security checks against a running server with a fresh database (CI starts one; locally,
// point it at a dev server). Creates its own throwaway accounts — never run it against a real server.
//   BASE_URL=http://localhost:3100 SERVER_LOG=server.log node test/security.integration.mjs
// SERVER_LOG is the server's output with MAIL_TRANSPORT=log, where the emailed codes appear.
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

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

/**
 * Asks the live-editing server for a document the way the app does and says what it answered:
 * 'read-write', 'readonly', or 'denied'.
 */
const liveAccess = (cookie, documentName) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/collab`, { headers: { cookie } });
    ws.binaryType = 'arraybuffer';
    const done = (v) => {
      resolve(v);
      try {
        ws.close();
      } catch {}
    };
    ws.onopen = () => {
      const e = encoding.createEncoder();
      encoding.writeVarString(e, documentName);
      encoding.writeVarUint(e, 2); // auth
      encoding.writeVarUint(e, 0); // token
      encoding.writeVarString(e, 'session-cookie');
      ws.send(encoding.toUint8Array(e));
    };
    ws.onmessage = (m) => {
      const d = decoding.createDecoder(new Uint8Array(m.data));
      decoding.readVarString(d);
      if (decoding.readVarUint(d) !== 2) return;
      const kind = decoding.readVarUint(d);
      done(kind === 1 ? 'denied' : decoding.readVarString(d));
    };
    ws.onerror = () => done('error');
    ws.onclose = () => done('denied');
    setTimeout(() => done('timeout'), 5000);
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

// --- guesses sent all at once are slowed down as a group
{
  const target = await signup('burst');
  const timed = async () => {
    const t = Date.now();
    await req('/api/auth/login', { method: 'POST', body: { email: target.email, password: 'wrong-pass' } });
    return Date.now() - t;
  };
  const times = (await Promise.all(Array.from({ length: 20 }, timed))).sort((x, y) => x - y);
  check('20 parallel wrong guesses are slowed down as a group', times[0] < 1500 && times[19] >= 4000, `${times[0]}…${times[19]} ms`);
  const real = await req('/api/auth/login', { method: 'POST', body: { email: target.email, password: target.password } });
  check('…and the owner can still sign in afterwards', real.status === 200, `got ${real.status}`);
}

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

// --- guests: names only, and only what's shared with them; files: only editors rename them
{
  const shared = (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', body: { title: `Shared ${stamp}`, type: 'document' }, cookie: owner.cookie })).data.page;
  const guest = await signup('guest');
  await verify(guest);
  await req(`/api/pages/${shared.id}/guests`, { method: 'POST', body: { email: guest.email, level: 'view' }, cookie: owner.cookie });
  const inviteId = (await req('/api/invitations', { cookie: guest.cookie })).data?.invitations?.[0]?.id;
  const joined = await req(`/api/invitations/${inviteId}/accept`, { method: 'POST', cookie: guest.cookie });
  const list = await req(`/api/workspaces/${ws}/members`, { cookie: guest.cookie });
  check('a guest sees member names but no emails', joined.status === 200 && list.status === 200 && list.data.members.length > 0 && list.data.members.every((m) => !('email' in m) && m.name), `got ${list.status}`);
  const ownerList = await req(`/api/workspaces/${ws}/members`, { cookie: owner.cookie });
  check('…while members still see emails', ownerList.data.members.some((m) => m.email === owner.email));

  const onPage = (await req(`/api/workspaces/${ws}/whiteboards`, { method: 'POST', body: { title: 'On the page', place: { pageId: shared.id } }, cookie: owner.cookie })).data.whiteboard;
  const elsewhere = (await req(`/api/workspaces/${ws}/whiteboards`, { method: 'POST', body: { title: 'Not shared' }, cookie: owner.cookie })).data.whiteboard;
  await sleep(500);
  check('a guest can open a whiteboard on a page shared with them, read-only', (await liveAccess(guest.cookie, `board:${onPage.id}`)) === 'readonly');
  check('a guest cannot open a whiteboard that is not on a shared page', (await liveAccess(guest.cookie, `board:${elsewhere.id}`)) === 'denied');
  check('a member can open that whiteboard', (await liveAccess(member.cookie, `board:${elsewhere.id}`)) === 'read-write');

  const form = new FormData();
  form.append('file', new Blob(['hello']), 'notes.txt');
  const up = await (await fetch(`${B}/api/workspaces/${ws}/files`, { method: 'POST', headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() }, body: form })).json();
  check('a guest cannot open the pen layer of a file that is not on a shared page', (await liveAccess(guest.cookie, `file:${up.id}`)) === 'denied');

  // A file on a page the member can only view: they can't rename it; its uploader can.
  const viewOnly = (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', body: { title: `View only ${stamp}`, type: 'document' }, cookie: owner.cookie })).data.page;
  await req(`/api/pages/${viewOnly.id}/permissions`, { method: 'PUT', body: { defaultAccess: 'view', members: [] }, cookie: owner.cookie });
  await req(`/api/files/${up.id}/move`, { method: 'POST', body: { target: { pageId: viewOnly.id } }, cookie: owner.cookie });
  await sleep(500);
  const byMember = await req(`/api/files/${up.id}`, { method: 'PATCH', body: { name: 'renamed.txt' }, cookie: member.cookie });
  const byOwner = await req(`/api/files/${up.id}`, { method: 'PATCH', body: { name: 'renamed.txt' }, cookie: owner.cookie });
  check('a member who can only view the page cannot rename its file', byMember.status === 403, `got ${byMember.status}`);
  check('…the uploader can', byOwner.status === 200, `got ${byOwner.status}`);
}

// --- zip import
{
  const upload = async (bytes) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'export.zip');
    const r = await fetch(`${B}/api/workspaces/${ws}/import-export`, { method: 'POST', headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() }, body: form });
    return r.status;
  };
  const page = (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', body: { title: `Round trip ${stamp}`, type: 'document' }, cookie: owner.cookie })).data.page;
  const exported = new Uint8Array(await (await fetch(`${B}/api/pages/${page.id}/export`, { headers: { cookie: owner.cookie } })).arrayBuffer());
  check('an exported page imports again', (await upload(exported)) === 201);
  check('a .zip that is not an export is refused', (await upload(zipSync({ 'hello.txt': strToU8('hi') }))) === 400);
  const bad = zipSync({ 'atrium-export.json': strToU8(JSON.stringify({ format: 'atrium-export', version: 1, pages: [{ id: '../../etc' }] })) });
  check('an export with a malformed manifest is refused', (await upload(bad)) === 400);
  const lots = {};
  for (let i = 0; i <= 50_000; i++) lots[`f${i}`] = new Uint8Array(0);
  const many = await upload(zipSync(lots));
  check('a .zip with too many entries is refused', many === 413, `got ${many}`);
}

// --- imports: one per person and a few on the whole server
{
  // An upload that trickles in, so its import holds a place for a while.
  const slowImport = (user, workspace, ms) => {
    const boundary = `----atrium${Math.random().toString(16).slice(2)}`;
    const CRLF = '\r\n';
    const head = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="slow.zip"', 'Content-Type: application/zip', '', ''].join(CRLF);
    const tail = `${CRLF}--${boundary}--${CRLF}`;
    const body = new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode(head));
        await sleep(ms);
        c.enqueue(zipSync({ 'hello.txt': strToU8('hi') }));
        c.enqueue(new TextEncoder().encode(tail));
        c.close();
      },
    });
    return fetch(`${B}/api/workspaces/${workspace}/import-export`, {
      method: 'POST',
      duplex: 'half',
      headers: { cookie: user.cookie, 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-forwarded-for': freshIp() },
      body,
    }).then((r) => r.status);
  };
  const wsOf = async (u) => (await req('/api/workspaces', { cookie: u.cookie })).data.workspaces.find((w) => w.role === 'owner').id;
  const second = await signup('importer2');
  const third = await signup('importer3');
  const a = slowImport(owner, ws, 2500);
  const b = slowImport(second, await wsOf(second), 2500);
  await sleep(600);
  const sameAgain = await slowImport(owner, ws, 0);
  const busy = await slowImport(third, await wsOf(third), 0);
  check('a second import by the same person is refused while the first runs', sameAgain === 429, `got ${sameAgain}`);
  check('an import beyond the server-wide limit is refused', busy === 429, `got ${busy}`);
  const done = await Promise.all([a, b]);
  check('…and the running imports finish normally', done.every((s) => s === 400), done.join(','));
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
