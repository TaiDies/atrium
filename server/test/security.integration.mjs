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

// --- AI service trouble: never a gateway status (a proxy would replace it and the app would show offline)
{
  // Run the server with AI_TIMEOUT_MS=3000 so the slow case doesn't take 90 seconds.
  const { createServer } = await import('node:http');
  let mode = 'error';
  const stub = createServer((rq, rs) => {
    if (mode === 'error') {
      rs.writeHead(500, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ error: { message: 'stub failure' } }));
    }
    // 'slow': never answers
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const ai = await signup('aiuser');
  const aiWs = (await req('/api/workspaces', { cookie: ai.cookie })).data.workspaces[0].id;
  const conn = (p) => req('/api/ai/connection', { method: 'PUT', cookie: ai.cookie, body: { provider: 'openai', model: 'stub', baseUrl: `http://127.0.0.1:${p}/v1`, key: 'stub-key', useOwn: true } });
  const transform = (headers) =>
    fetch(`${B}/api/workspaces/${aiWs}/ai/transform`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ai.cookie, 'x-forwarded-for': freshIp(), ...headers },
      body: JSON.stringify({ text: 'hello', instruction: 'shorter' }),
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const healthy = async () => (await fetch(`${B}/api/health`)).ok;
  const fine = (r) => r.status === 424 && typeof r.data?.error === 'string' && r.data.error.length > 10;

  const set = await conn(port);
  check('AI: a test connection can be saved', set.status === 200, `got ${set.status} ${JSON.stringify(set.data)}`);
  mode = 'error';
  const failed = await transform();
  check('AI: a provider answering 500 gives 424 and a readable message', fine(failed), `got ${failed.status} ${failed.data?.error}`);
  check('AI: health stays OK after a provider error', await healthy());

  mode = 'slow';
  const t0 = Date.now();
  const slow = await transform();
  check('AI: a provider that never answers gives 424 "took too long"', fine(slow) && /too long/i.test(slow.data.error), `got ${slow.status} ${slow.data?.error} after ${Date.now() - t0} ms`);
  check('AI: health stays OK after a timeout', await healthy());

  stub.closeAllConnections?.();
  await new Promise((r) => stub.close(r));
  const refused = await transform();
  check('AI: a provider refusing connections gives 424 and a readable message', fine(refused) && /reach/i.test(refused.data.error), `got ${refused.status} ${refused.data?.error}`);
  check('AI: health stays OK after a refused connection', await healthy());

  // In the background ("Prefer: respond-async"): 202 and a job, whose error comes back with the same status.
  const started = await transform({ prefer: 'respond-async' });
  let polled = null;
  for (let i = 0; i < 20 && started.status === 202; i++) {
    await sleep(500);
    polled = await req(`/api/ai/jobs/${started.data.job}`, { cookie: ai.cookie });
    if (polled.status !== 200 || polled.data?.done) break;
  }
  check('AI: background requests answer 202 with a job', started.status === 202 && typeof started.data?.job === 'string', `got ${started.status}`);
  check('AI: a failed background request reports 424 and the message', polled?.status === 424 && /reach/i.test(polled.data?.error ?? ''), `got ${polled?.status} ${polled?.data?.error}`);
  const other = await req(`/api/ai/jobs/${started.data?.job}`, { cookie: owner.cookie });
  check("AI: someone else can't read a background request", other.status === 404, `got ${other.status}`);
}

// --- crashes from outside: bad request targets and bad live messages must not stop the server
{
  const net = await import('node:net');
  const u = new URL(B);
  await new Promise((resolve) => {
    const sock = net.connect(Number(u.port || 80), u.hostname, () => {
      sock.write('GET //% HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    sock.on('data', () => {});
    sock.on('error', resolve);
    sock.on('close', resolve);
    setTimeout(() => (sock.destroy(), resolve()), 2000);
  });
  await sleep(300);
  check('an upgrade to "//%" does not stop the server', (await fetch(`${B}/api/health`).catch(() => ({ ok: false }))).ok);
  const own = new URL(B).origin;
  const sent = await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/live`, { headers: { cookie: owner.cookie, origin: own } });
    ws.onopen = () => {
      for (const m of ['null', '1', '[]', 'x', '"str"', '{"t":"join","code":null}']) ws.send(m);
      setTimeout(() => (ws.close(), resolve(true)), 500);
    };
    ws.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 4000);
  });
  await sleep(300);
  check('odd /live messages ("null", "1", "[]", "x") do not stop the server', sent && (await fetch(`${B}/api/health`).catch(() => ({ ok: false }))).ok);
}

// --- API tokens: session-only routes, workspace limits that hold for every method, locked pages
{
  const today = new Date().toISOString().slice(0, 10);
  const wsA = (await req('/api/workspaces', { cookie: owner.cookie })).data.workspaces.find((w) => w.role === 'owner').id;
  const wsB = (await req('/api/workspaces', { method: 'POST', cookie: owner.cookie, body: { name: 'Second' } })).data.workspace?.id;
  check('a second workspace can be made', !!wsB, String(wsB));
  const mk = async (ws, title) => (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', cookie: owner.cookie, body: { title, type: 'document' } })).data?.page?.id;
  const pageB = await mk(wsB, 'B page');
  const pageA = await mk(wsA, 'A page');
  const form = new FormData();
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'b.txt');
  const up = await fetch(`${B}/api/workspaces/${wsB}/files`, { method: 'POST', headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() }, body: form }).then((r) => r.json());
  const fileB = up.url?.split('/').pop()?.split('?')[0];
  const eventB = (await req(`/api/workspaces/${wsB}/events`, { method: 'POST', cookie: owner.cookie, body: { startDate: today, title: 'B event' } })).data?.event?.id;
  const hookB = (await req(`/api/workspaces/${wsB}/webhooks`, { method: 'POST', cookie: owner.cookie, body: { url: 'https://example.com/hook', events: ['page.created'] } })).data?.id;
  await req('/api/ai/connection', { method: 'PUT', cookie: owner.cookie, body: { provider: 'openai', model: 'stub', baseUrl: 'http://127.0.0.1:9/v1', useOwn: true } });
  const chatB = (await req(`/api/workspaces/${wsB}/ai/ask`, { method: 'POST', cookie: owner.cookie, body: { message: 'hi', today } })).data?.chat?.id;
  check('workspace B has a page, file, event, webhook and chat to aim at', !!(pageB && fileB && eventB && hookB && chatB), JSON.stringify({ pageB, fileB, eventB, hookB, chatB }));

  const made = await req('/api/auth/tokens', { method: 'POST', cookie: owner.cookie, body: { name: 'scoped', workspaceId: wsA } });
  const tok = made.data?.token;
  check('a token limited to workspace A can be made', typeof tok === 'string', `${made.status} ${JSON.stringify(made.data)}`);
  const T = async (path, method = 'GET', body, extra = {}) => {
    const r = await fetch(B + path, { method, headers: { authorization: `Bearer ${tok}`, 'x-forwarded-for': freshIp(), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  check('the token works in its own workspace (with a JSON body)', (await T(`/api/pages/${pageA}/markdown`, 'POST', { markdown: 'hello' })).status === 200);
  const lowercase = await fetch(`${B}/api/pages/${pageA}`, { headers: { authorization: `bearer ${tok}`, 'x-forwarded-for': freshIp() } });
  check('"bearer" in lower case works too', lowercase.status === 200, `got ${lowercase.status}`);
  const outside = [
    [`/api/pages/${pageB}`, 'GET'],
    [`/api/pages/${pageB}`, 'PATCH', { title: 'x' }],
    [`/api/pages/${pageB}/markdown`, 'GET'],
    [`/api/pages/${pageB}/markdown`, 'POST', { markdown: 'x' }],
    [`/api/pages/${pageB}`, 'DELETE'],
    [`/api/files/${fileB}`, 'GET'],
    [`/api/workspaces/${wsB}/files`, 'GET'],
    [`/api/events/${eventB}`, 'PATCH', { title: 'x' }],
    [`/api/events/${eventB}`, 'DELETE'],
    [`/api/workspaces/${wsB}/events`, 'POST', { startDate: today, title: 'x' }],
    [`/api/workspaces/${wsB}/webhooks`, 'GET'],
    [`/api/webhooks/${hookB}`, 'PATCH', { active: false }],
    [`/api/webhooks/${hookB}`, 'DELETE'],
    [`/api/ai/chats/${chatB}`, 'GET'],
    [`/api/ai/chats/${chatB}`, 'DELETE'],
    [`/api/ai/chats/${chatB}/applied`, 'POST', { index: 0, pages: [], tasks: 0 }],
    [`/api/workspaces/${wsB}/pages`, 'POST', { title: 'x', type: 'document' }],
  ];
  const leaks = [];
  for (const [path, method, body] of outside) {
    const r = await T(path, method, body);
    if (r.status !== 404) leaks.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} → ${r.status}`);
  }
  check('a token limited to workspace A gets 404 for everything in workspace B', leaks.length === 0, leaks.join('; '));
  const mcp = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'B page' } } };
  const viaQuery = await T(`/api/mcp?workspace=${wsB}`, 'POST', mcp);
  const viaHeader = await T('/api/mcp', 'POST', mcp, { 'x-workspace': wsB });
  check('MCP with ?workspace=B or X-Workspace: B stays in workspace A', !JSON.stringify(viaQuery.data).includes('B page') && !JSON.stringify(viaHeader.data).includes('B page'), JSON.stringify(viaQuery.data).slice(0, 200));
  check('the page in B was not changed or deleted', (await req(`/api/pages/${pageB}`, { cookie: owner.cookie })).data?.page?.title === 'B page');

  const sessionOnly = [
    ['/api/auth/password', 'POST', { current: 'x', password: 'y' }],
    ['/api/auth/me', 'PATCH', { name: 'x' }],
    ['/api/auth/me/prefs', 'PUT', {}],
    ['/api/auth/me/digest', 'PUT', { digest: false }],
    ['/api/auth/logout', 'POST', {}],
    ['/api/auth/live-ticket', 'GET'],
    ['/api/ai/connection', 'PUT', { provider: 'openai', model: 'x' }],
    ['/api/ai/connection', 'DELETE'],
    ['/api/ai/models', 'POST', { provider: 'openai' }],
    ['/api/notifications?now=2026-01-01T10:00', 'GET'],
    ['/api/invitations', 'GET'],
    [`/api/workspaces/${wsA}`, 'DELETE'],
    [`/api/workspaces/${wsA}/members/${owner.id}`, 'PATCH', { role: 'member' }],
    [`/api/workspaces/${wsA}/members/${owner.id}`, 'DELETE'],
  ];
  const open = [];
  for (const [path, method, body] of sessionOnly) {
    const r = await T(path, method, body);
    if (r.status !== 403) open.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} → ${r.status}`);
  }
  check('session-only routes refuse API tokens with 403', open.length === 0, open.join('; '));

  // A proxy's Basic login is not a token guess: many of them don't block the address.
  const ip = freshIp();
  let blocked = false;
  for (let i = 0; i < 55; i++) {
    const b = await fetch(`${B}/api/auth/me`, { headers: { authorization: 'Basic dXNlcjpwYXNz', cookie: owner.cookie, 'x-forwarded-for': ip } });
    if (b.status === 429) blocked = true;
  }
  check('Basic auth headers from a proxy never lock anyone out', !blocked);

  // Locked pages refuse writes through the API.
  await req(`/api/pages/${pageA}`, { method: 'PATCH', cookie: owner.cookie, body: { locked: true } });
  const lockedWrite = await T(`/api/pages/${pageA}/markdown`, 'POST', { markdown: 'more' });
  check('a locked page refuses Markdown writes (423)', lockedWrite.status === 423, `got ${lockedWrite.status}`);
  await req(`/api/pages/${pageA}`, { method: 'PATCH', cookie: owner.cookie, body: { locked: false } });

  // Tokens stop when their owner signs out everywhere.
  await req('/api/auth/logout', { method: 'POST', cookie: owner.cookie, body: { everywhere: true } });
  check('a token stops working after "sign out everywhere"', (await T(`/api/pages/${pageA}`)).status === 401);
  const back = await req('/api/auth/login', { method: 'POST', body: { email: owner.email, password: owner.password } });
  if (back.cookie) owner.cookie = back.cookie;
}

// --- big bodies from someone not signed in are refused before they're read
{
  const big = async (path, method) => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream({
      pull(c) {
        if (sent >= 100) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const t0 = Date.now();
    const r = await fetch(B + path, { method, headers: { 'content-type': 'application/octet-stream', 'x-forwarded-for': freshIp() }, body, duplex: 'half' }).catch((e) => ({ status: `error ${e.message}` }));
    return { status: r.status, ms: Date.now() - t0, sent };
  };
  const id = '00000000-0000-4000-8000-000000000001';
  for (const [path, method] of [[`/api/files/${id}/content`, 'PUT'], [`/api/pages/${id}/content`, 'PUT'], [`/api/workspaces/${id}/convert`, 'POST']]) {
    const r = await big(path, method);
    check(`an anonymous 100 MB ${method} ${path.replace(id, ':id')} gets 401 without being read`, r.status === 401 && r.sent < 100, `got ${r.status} after ${r.ms} ms, ${r.sent} MB sent`);
  }
  check('the server is fine after them', (await fetch(`${B}/api/health`)).ok);
}

// --- access ends for open connections too: password change, leaving a workspace
{
  const own = new URL(B).origin;
  const openLive = (cookie) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/live`, { headers: { cookie, origin: own } });
      const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
      ws.onopen = () => resolve({ ws, closed });
      ws.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 4000);
    });
  const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'still open')]);

  const rev = await signup('revoked');
  const s1 = await openLive(rev.cookie);
  await req('/api/auth/password', { method: 'POST', cookie: rev.cookie, body: { currentPassword: rev.password, newPassword: 'a-new-password-9' } });
  check('changing the password closes open live sockets', s1 && (await within(s1.closed, 3000)) === 4401, s1 ? String(await within(s1.closed, 10)) : 'never opened');

  const leaver = await signup('leaver');
  await verify(leaver);
  await req(`/api/workspaces/${ws}/members`, { method: 'POST', body: { email: leaver.email, role: 'member' }, cookie: owner.cookie });
  const inviteId = (await req('/api/invitations', { cookie: leaver.cookie })).data?.invitations?.[0]?.id;
  await req(`/api/invitations/${inviteId}/accept`, { method: 'POST', cookie: leaver.cookie });
  const s2 = await openLive(leaver.cookie);
  const removed = await req(`/api/workspaces/${ws}/members/${leaver.id}`, { method: 'DELETE', cookie: owner.cookie });
  check('removing a member closes their live socket', removed.status === 200 && s2 && (await within(s2.closed, 3000)) === 4403, `${removed.status}`);
  check('…and they can no longer open the workspace', (await req(`/api/workspaces/${ws}/members`, { cookie: leaver.cookie })).status === 404);
}

// --- guests see boards on pages shared with them; hidden events can't be changed; editors can't re-share by moving
{
  const shared = (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', body: { title: `Guest view ${stamp}`, type: 'document' }, cookie: owner.cookie })).data.page;
  const g = await signup('guest2');
  await verify(g);
  await req(`/api/pages/${shared.id}/guests`, { method: 'POST', body: { email: g.email, level: 'view' }, cookie: owner.cookie });
  const inviteId = (await req('/api/invitations', { cookie: g.cookie })).data?.invitations?.[0]?.id;
  await req(`/api/invitations/${inviteId}/accept`, { method: 'POST', cookie: g.cookie });
  const onPage = (await req(`/api/workspaces/${ws}/whiteboards`, { method: 'POST', body: { title: 'Shown', place: { pageId: shared.id } }, cookie: owner.cookie })).data.whiteboard;
  const elsewhere = (await req(`/api/workspaces/${ws}/whiteboards`, { method: 'POST', body: { title: 'Hidden' }, cookie: owner.cookie })).data.whiteboard;
  await sleep(500);
  const seen = await req(`/api/whiteboards/${onPage.id}/preview`, { cookie: g.cookie });
  const unseen = await req(`/api/whiteboards/${elsewhere.id}/preview`, { cookie: g.cookie });
  check('a guest can preview a board on a page shared with them', seen.status === 200, `got ${seen.status}`);
  check('…but not a board elsewhere', unseen.status === 404, `got ${unseen.status}`);

  const secret = (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', body: { title: 'Secret plans 2', type: 'document' }, cookie: owner.cookie })).data.page;
  await req(`/api/pages/${secret.id}/permissions`, { method: 'PUT', body: { defaultAccess: 'none', members: [] }, cookie: owner.cookie });
  const day = new Date().toISOString().slice(0, 10);
  const hidden = (await req(`/api/workspaces/${ws}/events`, { method: 'POST', body: { title: 'Hidden event', startDate: day }, cookie: owner.cookie })).data.event;
  await req(`/api/events/${hidden.id}/place`, { method: 'POST', body: { target: { pageId: secret.id, position: 'end' } }, cookie: owner.cookie });
  const changes = [
    [`/api/events/${hidden.id}`, 'PATCH', { title: 'peek' }],
    [`/api/events/${hidden.id}/paths/choose`, 'POST', { index: 0 }],
    [`/api/events/${hidden.id}/paths/undo`, 'POST', {}],
    [`/api/events/${hidden.id}/place`, 'POST', { target: { pageId: shared.id, position: 'end' } }],
  ];
  const reached = [];
  for (const [path, method, body] of changes) {
    const r = await req(path, { method, body, cookie: member.cookie });
    if (r.status !== 404) reached.push(`${method} ${path.split('/').slice(-1)[0]} → ${r.status}`);
  }
  check('a member cannot change an event on a page hidden from them', reached.length === 0, reached.join('; '));

  const a = (await req(`/api/workspaces/${ws}/pages`, { method: 'POST', body: { title: 'Move me', type: 'document' }, cookie: owner.cookie })).data.page;
  const moved = await req(`/api/pages/${a.id}`, { method: 'PATCH', body: { parentId: secret.id }, cookie: member.cookie });
  check('an editor cannot move a page under another one (it changes who sees it)', moved.status === 403 || moved.status === 404, `got ${moved.status}`);
  const renamed = await req(`/api/pages/${a.id}`, { method: 'PATCH', body: { title: 'Renamed by an editor' }, cookie: member.cookie });
  check('…but can still rename it', renamed.status === 200, `got ${renamed.status}`);
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
