import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessMap, requireMember, requirePage } from '../access.js';
import { aiAccess, complete } from '../ai.js';
import { requireUser } from '../auth.js';
import { databaseRows, readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { useAi } from '../limits.js';
import { cardProperties, databaseToCsv, docToMarkdown } from '../readable.js';
import { addDays, today } from '../repeat.js';
import { HttpError, idParams, parse } from '../util.js';

// Flashcards kept with a page or a card, reviewed with spaced repetition (each person on their own
// schedule), and quizzes the AI makes. The AI works from "material" the person picks: the page or card,
// and — in a page — its sub-pages, cards and linked pages, down to which sections (headings) and which
// files of each are included.

const CARD = z.object({ front: z.string().trim().min(1, 'Write the question').max(2000), back: z.string().max(5000).default('') });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CARD_COLUMNS = `c.id, c.page_id as "pageId", c.front, c.back,
  to_char(r.due, 'YYYY-MM-DD') as due, coalesce(r.interval_days, 0) as interval, coalesce(r.reps, 0) as reps`;

const noLinks = { pageLink: () => ({ title: 'a page', href: null }), fileLink: () => null, eventLabel: () => null, boardLabel: () => null };

interface Section {
  title: string;
  text: string;
}

/** A document's Markdown split at its headings (the part before the first heading comes first). */
function splitSections(markdown: string): Section[] {
  const lines = markdown.split('\n').slice(1); // the first line is the title
  const out: Section[] = [{ title: 'Before the first heading', text: '' }];
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^#{2,7} (.*)$/.exec(line);
    if (h) out.push({ title: h[1].trim() || 'Untitled section', text: line + '\n' });
    else out[out.length - 1].text += line + '\n';
  }
  return out.filter((sec, i) => i > 0 || sec.text.trim());
}

interface Source {
  pageId: string;
  rowId: string | null;
  title: string;
  kind: 'page' | 'database' | 'card';
  sections: Section[];
  /** Files in it: only ones whose text could be read are useful to the AI. */
  files: { id: string; name: string; readable: boolean }[];
}

async function filesIn(pageId: string, rowId: string | null, extra: string[] = []) {
  return query<{ id: string; name: string; readable: boolean }>(
    `select f.id, f.filename as name, coalesce(length(f.text_content), 0) > 0 as readable from files f
      where f.workspace_id = (select workspace_id from pages where id = $1)
        and (f.id in (select file_id from file_refs where page_id = $1 and row_id = $2) or f.id = any($3::uuid[]))
      order by f.filename`,
    [pageId, rowId ?? '', extra],
  );
}

/** A page or card as study material: its text by section, and its files. */
async function sourceOf(pageId: string, rowId: string | null): Promise<Source | null> {
  const page = await one<{ title: string; type: string }>('select title, type from pages where id = $1 and deleted_at is null', [pageId]);
  if (!page) return null;
  const isDb = (DATABASE_TYPES as readonly string[]).includes(page.type);
  if (rowId) {
    if (!isDb) return null;
    const card = await readDoc(pageId, null, (doc) => ({ title: databaseRows(doc).find((r) => r.id === rowId)?.title ?? null, ...cardProperties(doc, rowId) }));
    if (!card.title) return null;
    const title = card.title;
    const body = await readDoc(pageId, rowId, (doc) => docToMarkdown(doc, title, noLinks));
    const sections = splitSections(body);
    if (card.text) sections.unshift({ title: 'Properties', text: card.text + '\n' });
    return { pageId, rowId, title, kind: 'card', sections, files: await filesIn(pageId, rowId, card.files) };
  }
  if (isDb) {
    const csv = await readDoc(pageId, null, (doc) => databaseToCsv(doc));
    return { pageId, rowId: null, title: page.title || 'Untitled', kind: 'database', sections: [{ title: 'All cards (as a table)', text: csv }], files: [] };
  }
  const md = await readDoc(pageId, null, (doc) => docToMarkdown(doc, page.title, noLinks));
  return { pageId, rowId: null, title: page.title || 'Untitled', kind: 'page', sections: splitSections(md), files: await filesIn(pageId, null) };
}

const MAX_SOURCES = 150;

/** What can be used from a page: itself, the pages inside it, cards of databases in or under it, and pages it links to. */
async function sourcesFor(userId: string, pageId: string, workspaceId: string): Promise<Source[]> {
  const access = await accessMap(userId, workspaceId);
  const may = (id: string) => (access.get(id) ?? 'none') !== 'none';
  const pages = await query<{ id: string; type: string }>(
    `with recursive sub as (
       select id, 0 as depth from pages where id = $1
       union all select p.id, sub.depth + 1 from pages p join sub on p.parent_id = sub.id where p.deleted_at is null and sub.depth < 4
     )
     select p.id, p.type from pages p where p.id in (select id from sub)
     union
     select p.id, p.type from page_links l join pages p on p.id = l.target_page
      where l.source_page = $1 and p.deleted_at is null and p.workspace_id = $2`,
    [pageId, workspaceId],
  );
  const ordered = [...pages.filter((p) => p.id === pageId), ...pages.filter((p) => p.id !== pageId)].filter((p) => may(p.id));
  const out: Source[] = [];
  for (const p of ordered) {
    if (out.length >= MAX_SOURCES) break;
    const src = await sourceOf(p.id, null);
    if (src) out.push(src);
    if ((DATABASE_TYPES as readonly string[]).includes(p.type)) {
      const rows = await readDoc(p.id, null, (doc) => databaseRows(doc));
      for (const r of rows) {
        if (out.length >= MAX_SOURCES) break;
        const card = await sourceOf(p.id, r.id);
        if (card) out.push(card);
      }
    }
  }
  return out;
}

const MATERIAL = z
  .array(
    z.object({
      pageId: z.uuid(),
      rowId: z.string().min(1).max(100).nullable().default(null),
      /** Which sections (by position); left out = all of them. */
      sections: z.array(z.number().int().min(0)).max(1000).optional(),
      files: z.array(z.uuid()).max(100).default([]),
    }),
  )
  .min(1)
  .max(MAX_SOURCES);
type Material = z.infer<typeof MATERIAL>;

const MAX_TEXT = 60_000;

/** The chosen material as one text for the AI (checking the person may see each part). */
async function materialText(userId: string, workspaceId: string, material: Material): Promise<string> {
  const access = await accessMap(userId, workspaceId);
  const parts: string[] = [];
  for (const m of material) {
    if ((access.get(m.pageId) ?? 'none') === 'none') throw new HttpError(404, 'Page not found');
    const src = await sourceOf(m.pageId, m.rowId);
    if (!src) continue;
    const chosen = m.sections ? src.sections.filter((_, i) => m.sections!.includes(i)) : src.sections;
    let text = chosen.map((sec) => sec.text).join('\n').trim();
    const fileIds = m.files.filter((id) => src.files.some((f) => f.id === id));
    if (fileIds.length) {
      const files = await query<{ filename: string; text_content: string | null }>('select filename, text_content from files where id = any($1::uuid[])', [fileIds]);
      for (const f of files) if (f.text_content?.trim()) text += `\n\n[File: ${f.filename}]\n${f.text_content.trim()}`;
    }
    if (text.trim()) parts.push(`<source title="${src.title.replace(/"/g, "'")}" kind="${src.kind}">\n${text.trim()}\n</source>`);
  }
  const all = parts.join('\n\n');
  if (all.split('\n').filter((l) => l.trim()).length < 3) throw new HttpError(400, 'There is too little in what you picked to make cards or questions from');
  return all.slice(0, MAX_TEXT);
}

/** Asks the AI for JSON made from the chosen material. */
async function askAbout(userId: string, workspaceId: string, material: Material, instruction: string): Promise<unknown> {
  const text = await materialText(userId, workspaceId, material);
  const a = await aiAccess(userId);
  if (!a.active) throw new HttpError(400, 'Set up an AI connection first (AI → Settings)');
  await useAi(userId);
  const system = `You make study material in ${config.appName} from what the person gives you (pages, cards and files). Use only what it says. Write in its language. Reply with ONLY JSON as described.`;
  const answer = await complete(a.active, system, [{ role: 'user', content: `<material>\n${text}\n</material>\n\n${instruction}` }], { json: true });
  try {
    return JSON.parse(answer.replace(/^```(?:json)?\n([\s\S]*?)\n```\s*$/, '$1'));
  } catch {
    throw new HttpError(502, 'The AI gave an answer that could not be read. Try again.');
  }
}

/** The request's material, or by default the whole page (or card). */
function materialOf(body: { material?: Material; row?: string | null }, pageId: string): Material {
  return body.material ?? [{ pageId, rowId: body.row ?? null, files: [] }];
}

/**
 * The next review, by how well it was remembered (0 again, 1 hard, 2 good, 3 easy) — a simplified SM-2:
 * a forgotten card starts over; remembered ones come back after longer and longer gaps.
 */
function schedule(prev: { interval: number; ease: number; reps: number; lapses: number }, grade: number, day: string) {
  let { interval, ease, reps, lapses } = prev;
  if (grade === 0) {
    reps = 0;
    lapses += 1;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    if (grade === 1) ease = Math.max(1.3, ease - 0.15);
    if (grade === 3) ease += 0.15;
    if (reps === 0) interval = grade === 3 ? 4 : 1;
    else if (reps === 1) interval = grade === 1 ? 2 : grade === 3 ? 6 : 3;
    else interval = Math.max(interval + 1, interval * (grade === 1 ? 1.2 : grade === 3 ? ease * 1.3 : ease));
    interval = Math.min(3650, Math.round(interval));
    reps += 1;
  }
  return { interval, ease, reps, lapses, due: addDays(day, interval) };
}

export async function flashcardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // A page's cards, with this person's next review of each.
  app.get('/pages/:id/flashcards', async (req) => {
    const { id } = parse(idParams, req.params);
    const page = await requirePage(req.user.id, id, 'view');
    const { row } = parse(z.object({ row: z.string().max(100).default('') }), req.query);
    const cards = await query(
      `select ${CARD_COLUMNS} from flashcards c left join flashcard_reviews r on r.card_id = c.id and r.user_id = $2
        where c.page_id = $1 and c.row_id = $3 order by c.position, c.created_at`,
      [id, req.user.id, row],
    );
    return { cards, canEdit: page.access !== 'view' };
  });

  app.post('/pages/:id/flashcards', async (req) => {
    const { id } = parse(idParams, req.params);
    const { cards, row } = parse(z.object({ cards: z.array(CARD).min(1).max(200), row: z.string().max(100).default('') }), req.body);
    const page = await requirePage(req.user.id, id, 'edit');
    const last = await one<{ p: number }>('select coalesce(max(position), 0) as p from flashcards where page_id = $1 and row_id = $2', [id, row]);
    await tx(async (c) => {
      let pos = last?.p ?? 0;
      for (const card of cards) {
        pos += 1;
        await query('insert into flashcards (workspace_id, page_id, row_id, front, back, position, created_by) values ($1, $2, $3, $4, $5, $6, $7)', [page.workspace_id, id, row, card.front, card.back, pos, req.user.id], c);
      }
    });
    return { added: cards.length };
  });

  async function cardOr404(userId: string, cardId: string, need: 'view' | 'edit') {
    const card = await one<{ page_id: string }>('select page_id from flashcards where id = $1', [cardId]);
    if (!card) throw new HttpError(404, 'Card not found');
    await requirePage(userId, card.page_id, need);
    return card;
  }

  app.patch('/flashcards/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(CARD.partial(), req.body);
    await cardOr404(req.user.id, id, 'edit');
    await query('update flashcards set front = coalesce($2, front), back = coalesce($3, back) where id = $1', [id, body.front ?? null, body.back ?? null]);
    return { ok: true };
  });

  app.delete('/flashcards/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await cardOr404(req.user.id, id, 'edit');
    await query('delete from flashcards where id = $1', [id]);
    return { ok: true };
  });

  // How well it was remembered: sets when it comes back for this person.
  app.post('/flashcards/:id/review', async (req) => {
    const { id } = parse(idParams, req.params);
    const { grade, today: day } = parse(z.object({ grade: z.number().int().min(0).max(3), today: date.default(today()) }), req.body);
    await cardOr404(req.user.id, id, 'view');
    const prev = await one<{ interval: number; ease: number; reps: number; lapses: number }>(
      'select interval_days as interval, ease, reps, lapses from flashcard_reviews where card_id = $1 and user_id = $2',
      [id, req.user.id],
    );
    const next = schedule(prev ?? { interval: 0, ease: 2.5, reps: 0, lapses: 0 }, grade, day);
    await query(
      `insert into flashcard_reviews (card_id, user_id, due, interval_days, ease, reps, lapses, reviewed_at) values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (card_id, user_id) do update set due = excluded.due, interval_days = excluded.interval_days, ease = excluded.ease,
         reps = excluded.reps, lapses = excluded.lapses, reviewed_at = now()`,
      [id, req.user.id, next.due, next.interval, next.ease, next.reps, next.lapses],
    );
    return { due: next.due, interval: next.interval };
  });

  // Cards due for this person across the workspace (new ones count as due), for Today.
  app.get('/workspaces/:id/flashcards/due', async (req) => {
    const { id } = parse(idParams, req.params);
    const { today: day } = parse(z.object({ today: date.default(today()) }), req.query);
    await requireMember(req.user.id, id, undefined, true);
    const access = await accessMap(req.user.id, id);
    const rows = await query<{ id: string; pageId: string; front: string; back: string; pageTitle: string; pageIcon: string }>(
      `select c.id, c.page_id as "pageId", c.front, c.back, p.title as "pageTitle", p.icon as "pageIcon"
         from flashcards c join pages p on p.id = c.page_id and p.deleted_at is null
         left join flashcard_reviews r on r.card_id = c.id and r.user_id = $2
        where c.workspace_id = $1 and (r.due is null or r.due <= $3)
        order by r.due nulls last, c.created_at limit 500`,
      [id, req.user.id, day],
    );
    const cards = rows.filter((c) => (access.get(c.pageId) ?? 'none') !== 'none');
    return { cards: cards.slice(0, 200), total: cards.length };
  });

  // What the AI can use: in a card, just that card's sections and files; in a page, also what's in and linked from it.
  app.get('/pages/:id/study-sources', async (req) => {
    const { id } = parse(idParams, req.params);
    const { row } = parse(z.object({ row: z.string().min(1).max(100).optional() }), req.query);
    const page = await requirePage(req.user.id, id, 'view');
    const sources = row ? [await sourceOf(id, row)].filter((x) => !!x) : await sourcesFor(req.user.id, id, page.workspace_id);
    return {
      sources: sources.map((src) => ({ ...src, sections: src.sections.map((sec) => ({ title: sec.title, words: sec.text.split(/\s+/).filter(Boolean).length })) })),
    };
  });

  const GENERATE = z.object({ material: MATERIAL.optional(), row: z.string().min(1).max(100).nullable().default(null) });

  // Cards the AI suggests (not saved: the person picks which to keep).
  app.post('/pages/:id/flashcards/generate', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(GENERATE.extend({ count: z.number().int().min(1).max(50).default(12) }), req.body ?? {});
    const { count } = body;
    const page = await requirePage(req.user.id, id, 'edit');
    const json = (await askAbout(
      req.user.id,
      page.workspace_id,
      materialOf(body, id),
      `Make ${count} flashcards covering the most important facts, terms and ideas. JSON: {"cards": [{"front": "a short question", "back": "the answer, short"}]}`,
    )) as { cards?: unknown };
    const cards = (Array.isArray(json.cards) ? json.cards : [])
      .map((c) => CARD.safeParse(c))
      .filter((r) => r.success)
      .map((r) => r.data!)
      .slice(0, count);
    if (!cards.length) throw new HttpError(502, 'The AI made no cards. Try again.');
    return { cards };
  });

  // A multiple-choice quiz (made fresh each time).
  app.post('/pages/:id/quiz', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(GENERATE.extend({ count: z.number().int().min(1).max(30).default(8) }), req.body ?? {});
    const { count } = body;
    const page = await requirePage(req.user.id, id, 'view');
    const json = (await askAbout(
      req.user.id,
      page.workspace_id,
      materialOf(body, id),
      `Make a quiz of ${count} multiple-choice questions testing understanding of the material. Each has 4 choices with exactly one correct. JSON: {"questions": [{"question": "…", "choices": ["…","…","…","…"], "answer": index of the correct choice (0-3), "explanation": "one sentence on why"}]}`,
    )) as { questions?: unknown };
    const Q = z.object({ question: z.string().min(1).max(1000), choices: z.array(z.string().max(500)).min(2).max(6), answer: z.number().int().min(0), explanation: z.string().max(1000).default('') });
    const questions = (Array.isArray(json.questions) ? json.questions : [])
      .map((q) => Q.safeParse(q))
      .filter((r) => r.success && r.data.answer < r.data.choices.length)
      .map((r) => r.data!)
      .slice(0, count);
    if (!questions.length) throw new HttpError(502, 'The AI made no questions. Try again.');
    return { questions };
  });
}
