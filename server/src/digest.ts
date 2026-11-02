import { config } from './config.js';
import { one, query } from './db.js';
import { mailEnabled, sendMail } from './mail.js';
import { today } from './repeat.js';
import { tasksFor } from './routes/tasks.js';

// The daily email: what's due today, what's overdue, and unread mentions, comments and assignments.
// Sent once a day at the hour each person chose (server time), to those who switched it on.

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function digestFor(userId: string, name: string, day: string) {
  const workspaces = await query<{ id: string; name: string }>(
    `select w.id, w.name from workspaces w join workspace_members m on m.workspace_id = w.id and m.user_id = $1 order by w.created_at`,
    [userId],
  );
  const sections: { title: string; lines: string[] }[] = [];
  for (const w of workspaces) {
    const open = (await tasksFor(userId, w.id, day).catch(() => [])).filter((t) => !t.done);
    if (!open.length) continue;
    const overdue = open.filter((t) => t.overdue);
    const dueToday = open.filter((t) => !t.overdue);
    const lines = [...dueToday.slice(0, 10).map((t) => `☐ ${t.title || 'Untitled'}`), ...overdue.slice(0, 10).map((t) => `⚠ ${t.title || 'Untitled'} (overdue)`)];
    sections.push({ title: `${w.name}: ${dueToday.length} due today${overdue.length ? `, ${overdue.length} overdue` : ''}`, lines });
  }
  const unread = await query<{ title: string; body: string }>(
    `select title, body from notifications where user_id = $1 and read_at is null and kind in ('mention', 'comment', 'assigned', 'page-shared', 'automation')
      order by created_at desc limit 8`,
    [userId],
  );
  if (unread.length) sections.push({ title: 'Waiting for you', lines: unread.map((n) => `• ${n.title}`) });
  if (!sections.length) return null;
  const subject = `Your day in ${config.appName}: ${sections.length && sections[0].title.includes('due') ? sections[0].title.split(': ')[1] : 'updates'}`;
  const text = `Good morning, ${name}.\n\n${sections.map((s) => `${s.title}\n${s.lines.join('\n')}`).join('\n\n')}\n\nYou can turn this email off in Settings → Account.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;color:#222">
  <p>Good morning, ${escape(name)}.</p>
  ${sections
    .map((s) => `<h3 style="font-size:15px;margin:18px 0 6px">${escape(s.title)}</h3><ul style="margin:0;padding-left:18px">${s.lines.map((l) => `<li>${escape(l.replace(/^[☐⚠•] /, ''))}</li>`).join('')}</ul>`)
    .join('')}
  <p style="color:#888;font-size:12px;margin-top:24px">You can turn this email off in Settings → Account.</p>
</div>`;
  return { subject, text, html };
}

let running = false;

/** Sends the day's emails that are due (run every few minutes by the scheduler). */
export async function runDigests() {
  if (running || !(await mailEnabled())) return;
  running = true;
  try {
    const day = today();
    const hour = new Date().getHours();
    const due = await query<{ id: string; email: string; name: string }>(
      `select id, email, name from users where digest and digest_hour <= $1 and (digest_sent_on is null or digest_sent_on < $2) and disabled_at is null`,
      [hour, day],
    );
    for (const u of due) {
      // Claim it first so a restart never sends it twice.
      const claimed = await one('update users set digest_sent_on = $2 where id = $1 and (digest_sent_on is null or digest_sent_on < $2) returning id', [u.id, day]);
      if (!claimed) continue;
      try {
        const mail = await digestFor(u.id, u.name, day);
        if (mail) await sendMail(u.email, mail.subject, mail.text, mail.html);
      } catch (err) {
        console.error('Could not send the daily email', u.id, err);
      }
    }
  } finally {
    running = false;
  }
}
