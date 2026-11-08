import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { one, query } from '../db.js';
import { checkStorage } from '../limits.js';
import { isDate, latestOnOrBefore, nextAfter, type RepeatRule, today, validRule } from '../repeat.js';
import { buildExport, importExportBytes } from '../transfer.js';
import { HttpError, idParams, parse } from '../util.js';

// Templates: a page saved (with everything under it) to make new pages from, by hand or on a
// repeating schedule.

const COLUMNS = `t.id, t.name, t.description, t.icon, t.page_type as "pageType", t.created_by as "createdBy",
  u.name as "createdByName", t.repeat, t.repeat_parent as "repeatParent", to_char(t.next_run, 'YYYY-MM-DD') as "nextRun",
  t.created_at as "createdAt", octet_length(t.data) as size`;

const repeatBody = z
  .object({
    unit: z.enum(['day', 'week', 'month', 'year']),
    every: z.number().int().min(1).max(365),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  })
  .nullable();

interface TemplateRow {
  id: string;
  workspace_id: string;
  created_by: string | null;
  name: string;
  data: Buffer;
}

async function loadTemplate(userId: string, id: string) {
  const t = await one<TemplateRow>('select id, workspace_id, created_by, name, data from templates where id = $1', [id]);
  if (!t) throw new HttpError(404, 'Template not found');
  const role = await requireMember(userId, t.workspace_id).catch(() => {
    throw new HttpError(404, 'Template not found');
  });
  return { ...t, role };
}

/** The first date of the pattern that's today or later. */
export function firstRun(rule: RepeatRule, from: string): string | null {
  const d = rule.start >= from ? rule.start : latestOnOrBefore(rule, from) === from ? from : nextAfter(rule, from);
  return d && (!rule.end || d <= rule.end) ? d : null;
}

/** Makes a page from a template; returns the new page's id. */
export async function useTemplate(userId: string, t: TemplateRow, parentId: string | null, title?: string) {
  await checkStorage(userId, t.data.length);
  const result = await importExportBytes(userId, t.workspace_id, new Uint8Array(t.data), parentId);
  const pageId = result.top[0];
  if (pageId && title !== undefined) await query('update pages set title = $2 where id = $1', [pageId, title.slice(0, 300)]);
  return pageId;
}

export async function templateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/workspaces/:id/templates', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const templates = await query(`select ${COLUMNS} from templates t left join users u on u.id = t.created_by where t.workspace_id = $1 order by t.name`, [id]);
    return { templates };
  });

  /** Saves a page (and its sub-pages) as a template. */
  app.post('/pages/:id/template', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(1000).default(''), subpages: z.boolean().default(true) }), req.body);
    const page = await requirePage(req.user.id, id, 'edit');
    if (page.deleted_at) throw new HttpError(404, 'Page not found');
    const { zip } = await buildExport(req.user.id, page.workspace_id, [id], body.subpages);
    const t = await one<{ id: string }>(
      `insert into templates (workspace_id, created_by, name, description, icon, page_type, data) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [page.workspace_id, req.user.id, body.name, body.description, page.icon, page.type, Buffer.from(zip)],
    );
    return reply.code(201).send({ template: { id: t!.id } });
  });

  /** A new page from a template (under parentId, or at the top). */
  app.post('/templates/:id/use', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ parentId: z.uuid().nullable().default(null), title: z.string().max(300).optional() }), req.body ?? {});
    const t = await loadTemplate(req.user.id, id);
    if (t.role !== 'owner') throw new HttpError(403, 'Only workspace owners can add pages');
    if (body.parentId) {
      const parent = await requirePage(req.user.id, body.parentId, 'edit');
      if (parent.workspace_id !== t.workspace_id) throw new HttpError(400, 'That page is in another workspace');
    }
    const pageId = await useTemplate(req.user.id, t, body.parentId, body.title);
    return reply.code(201).send({ page: { id: pageId, workspaceId: t.workspace_id } });
  });

  app.patch('/templates/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(1000).optional(),
        icon: z.string().max(16).nullable().optional(),
        repeat: repeatBody.optional(),
        repeatParent: z.uuid().nullable().optional(),
      }),
      req.body,
    );
    const t = await loadTemplate(req.user.id, id);
    if (t.role !== 'owner' && t.created_by !== req.user.id) throw new HttpError(403, 'Only the person who made this template or a workspace owner can change it');
    if (body.name !== undefined) await query('update templates set name = $2 where id = $1', [id, body.name]);
    if (body.description !== undefined) await query('update templates set description = $2 where id = $1', [id, body.description]);
    if (body.icon !== undefined) await query('update templates set icon = $2 where id = $1', [id, body.icon]);
    if (body.repeatParent !== undefined) {
      if (body.repeatParent) {
        const parent = await requirePage(req.user.id, body.repeatParent, 'edit');
        if (parent.workspace_id !== t.workspace_id) throw new HttpError(400, 'That page is in another workspace');
      }
      await query('update templates set repeat_parent = $2 where id = $1', [id, body.repeatParent]);
    }
    if (body.repeat !== undefined) {
      if (body.repeat && t.role !== 'owner') throw new HttpError(403, 'Only workspace owners can make templates repeat (it adds pages)');
      const rule: RepeatRule | null = body.repeat ? { ...body.repeat, when: 'date' } : null;
      if (rule && !validRule(rule)) throw new HttpError(400, 'That repeat pattern isn’t valid');
      const next = rule ? firstRun(rule, today()) : null;
      await query('update templates set repeat = $2, next_run = $3 where id = $1', [id, rule ? JSON.stringify(rule) : null, next]);
    }
    await query('update templates set updated_at = now() where id = $1', [id]);
    return { template: await one(`select ${COLUMNS} from templates t left join users u on u.id = t.created_by where t.id = $1`, [id]) };
  });

  app.delete('/templates/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const t = await loadTemplate(req.user.id, id);
    if (t.role !== 'owner' && t.created_by !== req.user.id) throw new HttpError(403, 'Only the person who made this template or a workspace owner can delete it');
    await query('delete from templates where id = $1', [id]);
    return { ok: true };
  });
}

const DAY_NAME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Makes the pages repeating templates are due to make (one per template, for the latest date due). */
export async function runRepeatingTemplates(day: string) {
  const due = await query<TemplateRow & { repeat: unknown; repeat_parent: string | null; next_run: string }>(
    `select id, workspace_id, created_by, name, data, repeat, repeat_parent, to_char(next_run, 'YYYY-MM-DD') as next_run
       from templates where next_run is not null and next_run <= $1`,
    [day],
  );
  for (const t of due) {
    try {
      if (!validRule(t.repeat) || !t.created_by) {
        await query('update templates set next_run = null where id = $1', [t.id]);
        continue;
      }
      // Missed dates (the server was off) don't each make a page: only the latest one does.
      let run = t.next_run;
      for (let next = nextAfter(t.repeat, run); next && next <= day; next = nextAfter(t.repeat, run)) run = next;
      const following = nextAfter(t.repeat, run);
      // Claim the run first so two servers (or a slow run) never make it twice.
      const claimed = await query('update templates set next_run = $3 where id = $1 and next_run = $2 returning id', [
        t.id,
        t.next_run,
        following && (!t.repeat.end || following <= t.repeat.end) ? following : null,
      ]);
      if (!claimed.length) continue;
      const role = await requireMember(t.created_by, t.workspace_id).catch(() => null);
      if (role !== 'owner') continue;
      const parent = t.repeat_parent && (await one<{ id: string }>('select id from pages where id = $1 and deleted_at is null', [t.repeat_parent])) ? t.repeat_parent : null;
      const label = isDate(run) ? DAY_NAME.format(new Date(`${run}T00:00:00Z`)) : run;
      await useTemplate(t.created_by, t, parent, `${t.name} — ${label}`);
    } catch (err) {
      console.error('Could not make a page from a repeating template', t.id, err);
    }
  }
}
