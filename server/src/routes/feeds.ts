import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { one, query, tx } from '../db.js';
import { calendarFeed, parseIcs } from '../ics.js';
import { HttpError, idParams, parse } from '../util.js';

// Calendar subscription links (.ics) that Google, Outlook or Apple Calendar can follow, and importing
// .ics files into a workspace's calendar.

const newToken = () => randomBytes(24).toString('base64url');
const feedPath = (token: string) => `/api/calendar/feed/${token}.ics`;
const MAX_IMPORT = 2000;

export async function feedRoutes(app: FastifyInstance) {
  // This person's link for a workspace (made the first time it's asked for).
  app.get('/workspaces/:id/calendar/feed', { preHandler: requireUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const existing = await one<{ token: string }>('select token from calendar_feeds where user_id = $1 and workspace_id = $2', [req.user.id, id]);
    const token =
      existing?.token ??
      (await one<{ token: string }>(
        `insert into calendar_feeds (token, user_id, workspace_id) values ($1, $2, $3)
         on conflict (user_id, workspace_id) do update set token = calendar_feeds.token returning token`,
        [newToken(), req.user.id, id],
      ))!.token;
    return { path: feedPath(token) };
  });

  // A new link; the old one stops working (for when it was shared by mistake).
  app.post('/workspaces/:id/calendar/feed/reset', { preHandler: requireUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const token = newToken();
    await query(
      `insert into calendar_feeds (token, user_id, workspace_id) values ($1, $2, $3)
       on conflict (user_id, workspace_id) do update set token = excluded.token, created_at = now()`,
      [token, req.user.id, id],
    );
    return { path: feedPath(token) };
  });

  // The feed itself. No sign-in (calendar apps can't sign in): the secret link is the key, and it shows
  // only what its owner can see, for as long as they're a member.
  app.get('/calendar/feed/:file', async (req, reply) => {
    const { file } = parse(z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{20,64}\.ics$/) }), req.params);
    const feed = await one<{ user_id: string; workspace_id: string; name: string; role: string | null }>(
      `select f.user_id, f.workspace_id, w.name,
              (select role from workspace_members m where m.workspace_id = f.workspace_id and m.user_id = f.user_id) as role
         from calendar_feeds f join workspaces w on w.id = f.workspace_id where f.token = $1`,
      [file.slice(0, -4)],
    );
    if (!feed || !feed.role || feed.role === 'guest') throw new HttpError(404, 'Calendar not found');
    const body = await calendarFeed(feed.user_id, feed.workspace_id, feed.name);
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', `inline; filename="${feed.name.replace(/[^\w .-]/g, '') || 'calendar'}.ics"`)
      .header('cache-control', 'private, max-age=300')
      .send(body);
  });

  // Events from a calendar file. Ones already there (same title, day and time) are skipped.
  app.post('/workspaces/:id/events/import', { preHandler: requireUser, bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        ics: z.string().min(1).max(10 * 1024 * 1024),
        color: z.enum(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red', 'aqua']).default('blue'),
      }),
      req.body,
    );
    await requireMember(req.user.id, id);
    const events = parseIcs(body.ics);
    if (!events.length) throw new HttpError(400, 'No events found in that file');
    if (events.length > MAX_IMPORT) throw new HttpError(400, `That file has ${events.length} events; up to ${MAX_IMPORT} can be imported at once`);
    let added = 0;
    let skipped = 0;
    await tx(async (c) => {
      for (const e of events) {
        const same = await one(
          `select 1 from events where workspace_id = $1 and title = $2 and start_date = $3 and start_time is not distinct from $4 limit 1`,
          [id, e.title, e.startDate, e.startTime],
          c,
        );
        if (same) {
          skipped++;
          continue;
        }
        await query(
          `insert into events (workspace_id, title, description, start_date, start_time, end_date, end_time, color, status, repeat, reminder, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, null, $9, $10, $11)`,
          [id, e.title, e.description, e.startDate, e.startTime, e.endDate, e.endTime, body.color, e.repeat ? JSON.stringify(e.repeat) : null, e.reminder, req.user.id],
          c,
        );
        added++;
      }
    });
    return { added, skipped };
  });
}
