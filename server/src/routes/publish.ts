import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as Y from 'yjs';
import { requirePage } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { HttpError, idParams, parse } from '../util.js';
import { INLINE_TYPES } from './files.js';
import { requirePermission } from '../roles.js';

// Publishing a page to the web: a secret link (/share/<token>) that shows the page — and, if chosen,
// the pages inside it — read-only to anyone, without an account.

interface PublishedPage {
  id: string;
  parentId: string | null;
  type: string;
  title: string;
  icon: string;
  cover: string | null;
}

/** The pages a link shows (the page, plus everything under it when sub-pages are included). */
async function publishedTree(token: string) {
  const root = await one<{ id: string; publish_subpages: boolean; publish_index: boolean }>(
    'select id, publish_subpages, publish_index from pages where publish_token = $1 and deleted_at is null',
    [token],
  );
  if (!root) throw new HttpError(404, 'This page isn’t published');
  const pages = await query<PublishedPage>(
    root.publish_subpages
      ? `with recursive tree as (
           select id from pages where id = $1
           union all
           select p.id from pages p join tree t on p.parent_id = t.id where p.deleted_at is null
         )
         select p.id, p.parent_id as "parentId", p.type, p.title, p.icon, p.cover from pages p join tree using (id)`
      : `select id, parent_id as "parentId", type, title, icon, cover from pages where id = $1`,
    [root.id],
  );
  return { root: root.id, allowIndex: root.publish_index, pages };
}

/** A document's saved state without its comment threads (those stay private). */
function publicState(state: Buffer): Buffer {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(state));
  const threads = doc.getMap('threads');
  doc.transact(() => [...threads.keys()].forEach((k) => threads.delete(k)));
  const out = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return out;
}

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

/** Publish settings, for people who can share the page. */
export async function publishRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/pages/:id/publish', async (req) => {
    const { id } = parse(idParams, req.params);
    await requirePage(req.user.id, id, 'view');
    const p = await one<{ publish_token: string | null; publish_subpages: boolean; publish_index: boolean; published_at: Date | null }>(
      'select publish_token, publish_subpages, publish_index, published_at from pages where id = $1',
      [id],
    );
    // A page inside a published page (with sub-pages) is public through that link.
    const via = await one<{ id: string; title: string; publish_token: string }>(
      `with recursive up as (
         select parent_id from pages where id = $1
         union all
         select p.parent_id from pages p join up on p.id = up.parent_id where up.parent_id is not null
       )
       select id, title, publish_token from pages where id in (select parent_id from up) and publish_token is not null and publish_subpages limit 1`,
      [id],
    );
    return {
      published: !!p?.publish_token,
      token: p?.publish_token ?? null,
      subpages: p?.publish_subpages ?? false,
      allowIndex: p?.publish_index ?? false,
      publishedAt: p?.published_at ?? null,
      via: via ? { id: via.id, title: via.title, token: via.publish_token } : null,
    };
  });

  app.put('/pages/:id/publish', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ published: z.boolean(), subpages: z.boolean().default(false), allowIndex: z.boolean().default(false) }), req.body);
    await requirePage(req.user.id, id, 'manage');
    // Publishing needs the role permission; taking a page off the web never does.
    if (body.published) await requirePermission(req.user.id, 'publish_pages');
    if (!body.published) {
      await query('update pages set publish_token = null, published_at = null where id = $1', [id]);
      return { published: false, token: null };
    }
    const row = await one<{ publish_token: string }>(
      `update pages set publish_token = coalesce(publish_token, $2), publish_subpages = $3, publish_index = $4, published_at = coalesce(published_at, now())
        where id = $1 returning publish_token`,
      [id, randomBytes(18).toString('base64url'), body.subpages, body.allowIndex],
    );
    return { published: true, token: row!.publish_token };
  });
}

/** What a published link shows, without an account. */
export async function publicPageRoutes(app: FastifyInstance) {
  app.get('/public/pages/:token', async (req) => {
    const { token } = parse(tokenParams, req.params);
    return publishedTree(token);
  });

  // A published page's (or one of its cards') content, as a Yjs update.
  app.get('/public/pages/:token/docs/:pageId', async (req, reply) => {
    const { token, pageId } = parse(tokenParams.extend({ pageId: z.uuid() }), req.params);
    const { rowId } = parse(z.object({ rowId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }), req.query);
    const tree = await publishedTree(token);
    if (!tree.pages.some((p) => p.id === pageId)) throw new HttpError(404, 'Page not found');
    const row = rowId
      ? await one<{ state: Buffer }>('select state from row_documents where page_id = $1 and row_id = $2', [pageId, rowId])
      : await one<{ state: Buffer }>('select state from page_content where page_id = $1', [pageId]);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Cache-Control', 'no-cache')
      .send(row ? publicState(row.state) : Buffer.alloc(0));
  });

  // Images and files used in a published page.
  app.get('/public/pages/:token/files/:fileId', async (req, reply) => {
    const { token, fileId } = parse(tokenParams.extend({ fileId: z.uuid() }), req.params);
    const tree = await publishedTree(token);
    const file = await one<{ filename: string; mime_type: string; size: string }>(
      `select f.filename, f.mime_type, f.size from files f
        where f.id = $1 and (exists (select 1 from file_refs r where r.file_id = f.id and r.page_id = any($2::uuid[]))
               or exists (select 1 from pages pg where pg.id = any($2::uuid[]) and pg.cover like '/api/files/' || f.id || '%'))`,
      [fileId, tree.pages.map((p) => p.id)],
    );
    if (!file) throw new HttpError(404, 'File not found');
    const inline = INLINE_TYPES.has(file.mime_type);
    return reply
      .header('Content-Type', inline ? file.mime_type : 'application/octet-stream')
      .header('Content-Length', file.size)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=300')
      .send(createReadStream(path.join(config.uploadDir, fileId)));
  });
}

/** Whether search engines may list a published link (for the X-Robots-Tag header on /share/ pages). */
export async function shareIndexable(url: string): Promise<boolean> {
  const token = /^\/share\/([A-Za-z0-9_-]{16,64})/.exec(url)?.[1];
  if (!token) return false;
  return !!(await one('select 1 from pages where publish_token = $1 and publish_index and deleted_at is null', [token]));
}
