// POST /api/subscribe — "Tell me when Atrium Cloud opens". Each address is kept as one private file in
// the project's Vercel Blob store (signups/<address>), so signing up twice keeps one entry. Nothing is
// sent to the address yet: the list is exported later (GET /api/signups) for an email service.
//
// Limits, so a script can't fill the store: each IP address may sign up 5 times a day, and at most 300
// new signups are taken a day in all. IP addresses are only kept as salted hashes in short-lived counter
// files (ratelimit/…), never next to an email address, and counters older than two days are deleted.
import { createHash } from 'node:crypto';
import { del, get, list, put } from '@vercel/blob';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/;
const PER_IP_PER_DAY = 5;
const PER_DAY = 300;

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const day = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, '');

/** The client's address as Vercel reports it, hashed with a secret so the counter files don't reveal it. */
function ipKey(request) {
  const ip = (request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const salt = process.env.SIGNUP_EXPORT_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || 'atrium';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 24);
}

async function readCount(pathname) {
  try {
    const r = await get(pathname, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return 0;
    return Number(JSON.parse(await new Response(r.stream).text()).count) || 0;
  } catch {
    return 0;
  }
}

const writeCount = (pathname, count) =>
  put(pathname, JSON.stringify({ count }), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });

/** Now and then, delete counter files from before yesterday. */
async function sweep() {
  if (Math.random() > 0.05) return;
  const keep = new Set([day(), day(new Date(Date.now() - 86_400_000))]);
  const old = [];
  let cursor;
  do {
    const page = await list({ prefix: 'ratelimit/', cursor, limit: 1000 });
    for (const b of page.blobs) if (!keep.has(b.pathname.split('/')[1])) old.push(b.url);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (old.length) await del(old);
}

export async function POST(request) {
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) return reply(415, { error: 'Send JSON.' });
  const text = await request.text();
  if (text.length > 2000) return reply(413, { error: 'Too long.' });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return reply(400, { error: 'Send JSON.' });
  }
  // A field people never see: bots fill it in. Pretend it worked.
  if (data.company) return reply(200, { ok: true });
  const email = String(data.email ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return reply(400, { error: 'That doesn’t look like an email address.' });
  if (data.consent !== true) return reply(400, { error: 'Tick the box to agree to be emailed about Atrium Cloud.' });

  const today = day();
  const ipFile = `ratelimit/${today}/ip-${ipKey(request)}.json`;
  const dayFile = `ratelimit/${today}/all.json`;
  const [mine, all] = await Promise.all([readCount(ipFile), readCount(dayFile)]);
  if (mine >= PER_IP_PER_DAY || all >= PER_DAY) return reply(429, { error: 'Too many signups right now. Please try again tomorrow.' });
  await Promise.all([writeCount(ipFile, mine + 1), writeCount(dayFile, all + 1)]);

  const lang = String(data.lang ?? '').slice(0, 12).replace(/[^A-Za-z-]/g, '');
  await put(`signups/${encodeURIComponent(email)}.json`, JSON.stringify({ email, at: new Date().toISOString(), lang, consent: 'Atrium Cloud announcements' }), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  await sweep().catch(() => {});
  return reply(200, { ok: true });
}

export function GET() {
  return reply(405, { error: 'Use POST.' });
}
