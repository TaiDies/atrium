import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessMap, requireMember, requirePage } from '../access.js';
import { aiAccess, complete } from '../ai.js';
import { requireUser } from '../auth.js';
import { readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { useAi } from '../limits.js';
import { databaseToCsv, docToMarkdown } from '../readable.js';
import { addDays, today } from '../repeat.js';
import { HttpError, idParams, parse } from '../util.js';

// Flashcards kept with a page, reviewed with spaced repetition (each person on their own schedule), and
// quizzes the AI makes from a page.

const CARD = z.object({ front: z.string().trim().min(1, 'Write the question').max(2000), back: z.string().max(5000).default('') });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CARD_COLUMNS = `c.id, c.page_id as "pageId", c.front, c.back,
  to_char(r.due, 'YYYY-MM-DD') as due, coalesce(r.interval_days, 0) as interval, coalesce(r.reps, 0) as reps`;

/** The page as text, for the AI to make cards or a quiz from. */
async function pageText(pageId: string, title: string, type: string) {
  const isDb = (DATABASE_TYPES as readonly string[]).includes(type);
  return readDoc(pageId, null, (doc) =>
    isDb ? databaseToCsv(doc) : docToMarkdown(doc, title, { pageLink: () => ({ title: 'a page', href: null }), fileLink: () => null, eventLabel: () => null, boardLabel: () => null }),
  );
}

/** Asks the AI for JSON made from a page. */
async function askAboutPage(userId: string, pageId: string, instruction: string): Promise<unknown> {
  const page = await one<{ title: string; type: string }>('select title, type from pages where id = $1', [pageId]);
  const text = (await pageText(pageId, page?.title ?? '', page?.type ?? 'document')).trim();
  if (text.split('\n').filter((l) => l.trim()).length < 2) throw new HttpError(400, 'This page has too little in it to make cards from');
  const a = await aiAccess(userId);
  if (!a.active) throw new HttpError(400, 'Set up an AI connection first (AI → Settings)');
  await useAi(userId);
  const system = `You make study material in ${config.appName} from a page the person gives you. Use only what the page says. Write in the page's language. Reply with ONLY JSON as described.`;
  const answer = await complete(a.active, system, [{ role: 'user', content: `<page>\n${text.slice(0, 60_000)}\n</page>\n\n${instruction}` }], { json: true });
  try {
    return JSON.parse(answer.replace(/^```(?:json)?\n([\s\S]*?)\n```\s*$/, '$1'));
  } catch {
    throw new HttpError(502, 'The AI gave an answer that could not be read. Try again.');
  }
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
    const cards = await query(
      `select ${CARD_COLUMNS} from flashcards c left join flashcard_reviews r on r.card_id = c.id and r.user_id = $2
        where c.page_id = $1 order by c.position, c.created_at`,
      [id, req.user.id],
    );
    return { cards, canEdit: page.access !== 'view' };
  });

  app.post('/pages/:id/flashcards', async (req) => {
    const { id } = parse(idParams, req.params);
    const { cards } = parse(z.object({ cards: z.array(CARD).min(1).max(200) }), req.body);
    const page = await requirePage(req.user.id, id, 'edit');
    const last = await one<{ p: number }>('select coalesce(max(position), 0) as p from flashcards where page_id = $1', [id]);
    await tx(async (c) => {
      let pos = last?.p ?? 0;
      for (const card of cards) {
        pos += 1;
        await query('insert into flashcards (workspace_id, page_id, front, back, position, created_by) values ($1, $2, $3, $4, $5, $6)', [page.workspace_id, id, card.front, card.back, pos, req.user.id], c);
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

  // Cards the AI suggests from the page (not saved: the person picks which to keep).
  app.post('/pages/:id/flashcards/generate', async (req) => {
    const { id } = parse(idParams, req.params);
    const { count } = parse(z.object({ count: z.number().int().min(1).max(50).default(12) }), req.body ?? {});
    await requirePage(req.user.id, id, 'edit');
    const json = (await askAboutPage(
      req.user.id,
      id,
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

  // A multiple-choice quiz from the page (made fresh each time).
  app.post('/pages/:id/quiz', async (req) => {
    const { id } = parse(idParams, req.params);
    const { count } = parse(z.object({ count: z.number().int().min(1).max(30).default(8) }), req.body ?? {});
    await requirePage(req.user.id, id, 'view');
    const json = (await askAboutPage(
      req.user.id,
      id,
      `Make a quiz of ${count} multiple-choice questions testing understanding of the page. Each has 4 choices with exactly one correct. JSON: {"questions": [{"question": "…", "choices": ["…","…","…","…"], "answer": index of the correct choice (0-3), "explanation": "one sentence on why"}]}`,
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
