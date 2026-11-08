import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessMap, requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { query } from '../db.js';
import { checkOutboundUrl } from '../netGuard.js';
import { HttpError, idParams, parse } from '../util.js';

// Small helpers for blocks: link previews for bookmarks, and the synced blocks in a workspace.

/** Previews never reach the local network, whatever the server allows elsewhere. */
const safeUrl = (raw: string) => checkOutboundUrl(raw, { private: 'block', what: 'Link preview' });

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();

function meta(html: string, names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
    const tag = re.exec(html)?.[0];
    const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (content) return decode(content);
  }
  return '';
}

const cache = new Map<string, { at: number; value: unknown }>();

export async function extraRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** Title, description, image and icon of a web page, for bookmark blocks. */
  app.get('/link-preview', async (req) => {
    const { url: raw } = parse(z.object({ url: z.string().url().max(2000) }), req.query);
    const hit = cache.get(raw);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;
    let url = await safeUrl(raw);
    let res: Response | null = null;
    // Follow a few redirects by hand, checking each address.
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0 (link preview)', Accept: 'text/html,application/xhtml+xml' },
      }).catch(() => null);
      if (!res) throw new HttpError(502, 'That site didn’t answer');
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!next) break;
      url = await safeUrl(new URL(next, url).toString());
    }
    if (!res || !res.ok) throw new HttpError(502, 'That site didn’t answer');
    const type = res.headers.get('content-type') ?? '';
    let html = '';
    if (type.includes('html')) {
      // Only the start of the page is needed (the <head>).
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < 512 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (Buffer.concat(chunks).toString('utf8').includes('</head>')) break;
      }
      reader.cancel().catch(() => {});
      html = Buffer.concat(chunks).toString('utf8');
    }
    const abs = (v: string) => {
      try {
        return v ? new URL(v, url).toString() : '';
      } catch {
        return '';
      }
    };
    const iconHref = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i.exec(html)?.[0];
    const value = {
      url: url.toString(),
      title: meta(html, ['og:title', 'twitter:title']) || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '') || url.hostname,
      description: meta(html, ['og:description', 'twitter:description', 'description']).slice(0, 300),
      image: abs(meta(html, ['og:image', 'twitter:image'])),
      icon: abs((iconHref && /href=["']([^"']+)["']/i.exec(iconHref)?.[1]) || '/favicon.ico'),
      site: meta(html, ['og:site_name']) || url.hostname.replace(/^www\./, ''),
    };
    cache.set(raw, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return value;
  });

  /** Synced blocks in the workspace (in pages this person can see), to show one in another page. */
  app.get('/workspaces/:id/synced-blocks', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const rows = await query<{ pageId: string; rowId: string; pageTitle: string; preview: string }>(
      `select d.page_id as "pageId", d.row_id as "rowId", p.title as "pageTitle", left(d.text_content, 120) as preview
         from row_documents d join pages p on p.id = d.page_id
        where p.workspace_id = $1 and p.deleted_at is null and d.row_id like 'sync\\_%'
        order by p.updated_at desc limit 200`,
      [id],
    );
    const access = await accessMap(req.user.id, id);
    return { blocks: rows.filter((r) => (access.get(r.pageId) ?? 'none') !== 'none').map((r) => ({ pageId: r.pageId, syncId: r.rowId.slice(5), pageTitle: r.pageTitle, preview: r.preview })) };
  });
}
