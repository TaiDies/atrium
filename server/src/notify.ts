import { type Queryable, query } from './db.js';
import { pushTo } from './live.js';

/** Leaves a message in someone's notifications (shown under the bell). */
export async function notify(
  userId: string,
  n: { kind: string; title: string; body?: string; link?: string | null },
  c?: Queryable,
) {
  await query(
    'insert into notifications (user_id, kind, title, body, link) values ($1, $2, $3, $4, $5)',
    [userId, n.kind, n.title.slice(0, 300), (n.body ?? '').slice(0, 2000), n.link ?? null],
    c,
  );
  // And straight away to their open apps, which can show it as a system notification.
  pushTo([userId], { t: 'notify', kind: n.kind, title: n.title, body: n.body ?? '', link: n.link ?? null });
}
