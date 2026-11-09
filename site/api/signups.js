// GET /api/signups — the newsletter list as CSV (email, signed_up_at), for importing into an email
// service. Needs "Authorization: Bearer <SIGNUP_EXPORT_TOKEN>" (a project environment variable); without
// the variable set, the export is switched off.
import { timingSafeEqual } from 'node:crypto';
import { list } from '@vercel/blob';

const same = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function GET(request) {
  const secret = process.env.SIGNUP_EXPORT_TOKEN;
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secret || secret.length < 24 || !same(given, secret)) {
    return new Response('Not allowed\n', { status: 401, headers: { 'cache-control': 'no-store' } });
  }
  const rows = [];
  let cursor;
  do {
    const page = await list({ prefix: 'signups/', cursor, limit: 1000 });
    for (const b of page.blobs) {
      const email = decodeURIComponent(b.pathname.slice('signups/'.length).replace(/\.json$/, ''));
      rows.push([email, new Date(b.uploadedAt).toISOString()]);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  rows.sort((a, b) => a[1].localeCompare(b[1]));
  const csv = ['email,signed_up_at', ...rows.map(([e, t]) => `"${e.replace(/"/g, '""')}",${t}`)].join('\n') + '\n';
  return new Response(csv, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="atrium-signups.csv"', 'cache-control': 'no-store' },
  });
}
