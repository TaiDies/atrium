// POST /api/subscribe — "Tell me when Atrium Cloud opens". Each address is kept as one private file in
// the project's Vercel Blob store (signups/<address>), so signing up twice keeps one entry. Nothing is
// sent to the address yet: the list is exported later (GET /api/signups) for an email service.
import { put } from '@vercel/blob';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/;

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

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
  const lang = String(data.lang ?? '').slice(0, 12).replace(/[^A-Za-z-]/g, '');
  await put(`signups/${encodeURIComponent(email)}.json`, JSON.stringify({ email, at: new Date().toISOString(), lang, consent: 'Atrium Cloud announcements' }), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  return reply(200, { ok: true });
}

export function GET() {
  return reply(405, { error: 'Use POST.' });
}
