import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessMap, requireMember, visibleFiles } from '../access.js';
import { aiAccess, type ChatTurn, complete, DEFAULT_MODELS, encryptKey, listModels, PROVIDERS } from '../ai.js';
import { requireUser } from '../auth.js';
import { useAi } from '../limits.js';
import { asyncCapable, jobState, runInBackground } from '../aiJobs.js';
import { transcribeFile } from '../transcribe.js';
import { readDoc } from '../blocks.js';
import { DATABASE_TYPES } from '../collab.js';
import { APP_GUIDE, BUILD_GUIDE } from '../aiGuide.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { addDays, isDate } from '../repeat.js';
import { databaseToCsv, docToMarkdown } from '../readable.js';
import { HttpError, idParams, parse } from '../util.js';

// The AI assistant. It answers in chat and can propose documents, databases and dated tasks (e.g. a
// study plan that runs up to a deadline); the person looks them over and adds them from the app. What it
// knows about the app and how to describe what it makes is in aiGuide.ts.

/** How much reference material goes with one question (characters; roughly 4 per token). */
const CONTEXT_LIMIT = 400_000;
const MAX_TASKS = 400;
const MAX_DOCUMENTS = 10;
const MAX_DATABASES = 5;
const MAX_ROWS = 300;
/** How many of the workspace's pages are listed for the assistant (so it can put things under them). */
const MAX_LISTED_PAGES = 300;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red', 'aqua'];
const FIELD_TYPES = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url'] as const;
const LAYOUTS = ['board', 'list', 'grid', 'calendar', 'timeline', 'gallery'] as const;

export interface ProposedDocument {
  ref: string;
  title: string;
  icon: string;
  /** null, another document's ref, or an existing page id. */
  parent: string | null;
  /** An existing document to add the markdown to, instead of a new page. */
  appendTo: string | null;
  markdown: string;
}

export interface ProposedDatabase {
  ref: string;
  title: string;
  icon: string;
  parent: string | null;
  layout: (typeof LAYOUTS)[number];
  fields: { name: string; type: (typeof FIELD_TYPES)[number]; options: string[] }[];
  rows: { name: string; cells: Record<string, unknown>; notes: string }[];
}

export interface ProposedTask {
  title: string;
  date: string;
  endDate: string | null;
  time: string | null;
  minutes: number | null;
  notes: string;
  color: string | null;
  reminder: number | null;
  repeat: { every: number; unit: 'day' | 'week' | 'month' | 'year'; until: string | null } | null;
  /** A document ref to link the task inside. */
  document: string | null;
  task: boolean;
}

export interface Proposal {
  documents: ProposedDocument[];
  databases: ProposedDatabase[];
  tasks: ProposedTask[];
}

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  /** User turns: what was attached, and the material itself (so follow-up questions can use it). */
  attachments?: { name: string; chars: number; truncated: boolean }[];
  context?: string;
  /** Assistant turns: what it suggests adding, and what was added. */
  proposal?: Proposal;
  applied?: { pages: { id: string; title: string }[]; tasks: number };
  /** Assistant turns: still being written (the answer is saved when it arrives), or why it failed. */
  pending?: boolean;
  error?: string;
}

/** An answer still "pending" this long after it was asked was lost (e.g. the server restarted). */
const PENDING_MS = 15 * 60 * 1000;

const STOP_WORDS = new Set(
  'the and for are but not you all any can had her was one our out has have how what when where which who why will with this that from they them their there then than into about your yours mine my me is it in on of to a an do does did be been by or as at so if we us i im ive its also just like more most some such very what whats tell show give find list make my notes page pages'.split(' '),
);

/**
 * The pages (up to 6) and files (up to 3) this person can see that best match a question, by how many
 * of its words they contain (a title match counts more).
 */
async function searchForQuestion(userId: string, workspaceId: string, question: string) {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP_WORDS.has(w)).slice(0, 12);
  if (!words.length) return { pageIds: [] as string[], files: [] as { name: string; text: string }[] };
  const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`);
  const access = await accessMap(userId, workspaceId);
  const pages = await query<{ id: string; score: number }>(
    `select p.id,
            (select count(*) from unnest($2::text[]) k where p.title ilike k) * 3
          + (select count(*) from unnest($2::text[]) k where c.text_content ilike k)
          + (select count(*) from unnest($2::text[]) k where exists (select 1 from row_documents r where r.page_id = p.id and r.text_content ilike k)) as score
       from pages p left join page_content c on c.page_id = p.id
      where p.workspace_id = $1 and p.deleted_at is null and p.archived_at is null
      order by score desc, p.updated_at desc
      limit 40`,
    [workspaceId, patterns],
  );
  const pageIds = pages.filter((p) => p.score > 0 && (access.get(p.id) ?? 'none') !== 'none').slice(0, 6).map((p) => p.id);
  const guest = (await requireMember(userId, workspaceId, undefined, true)) === 'guest';
  const files = guest
    ? []
    : (
        await query<{ id: string; name: string; text: string | null; score: number }>(
          `select f.id, f.filename as name, f.text_content as text,
                  (select count(*) from unnest($2::text[]) k where f.filename ilike k) * 3
                + (select count(*) from unnest($2::text[]) k where f.text_content ilike k) as score
             from files f where f.workspace_id = $1 and f.text_content is not null and f.text_content <> ''
            order by score desc, f.updated_at desc limit 20`,
          [workspaceId, patterns],
        )
      )
        .filter((f) => f.score > 0);
  // Files on pages hidden from this person don't count.
  const seen = await visibleFiles(userId, workspaceId, files.map((f) => f.id));
  const shown = files.filter((f) => seen.has(f.id)).slice(0, 3).map((f) => ({ name: f.name, text: (f.text ?? '').slice(0, 30_000) }));
  return { pageIds, files: shown };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function systemPrompt(today: string) {
  const weekday = WEEKDAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];
  return `You are the assistant inside ${config.appName}. You help people use the app and you can build things in their workspace: documents, databases and calendar tasks. Today is ${weekday} ${today}.

${APP_GUIDE}

${BUILD_GUIDE}`;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const clock = (v: unknown) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
const refOf = (v: unknown, fallback: string) => str(v, 60).trim() || fallback;
const ident = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

/** Pulls the JSON object out of the model's answer (some models wrap it in a code block). */
function parseAnswer(text: string): { reply: string; proposal: Proposal } {
  const empty: Proposal = { documents: [], databases: [], tasks: [] };
  let data: any = null;
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  data = tryParse(text.trim());
  if (!data) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
    if (fenced) data = tryParse(fenced.trim());
  }
  if (!data) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) data = tryParse(text.slice(start, end + 1));
  }
  if (!data || typeof data !== 'object') return { reply: text.trim(), proposal: empty };

  const documents: ProposedDocument[] = (Array.isArray(data.documents) ? data.documents : [])
    .filter((d: any) => d && typeof d.markdown === 'string' && d.markdown.trim())
    .slice(0, MAX_DOCUMENTS)
    .map((d: any, i: number) => ({
      ref: refOf(d.ref, `doc${i + 1}`),
      title: str(d.title, 200).trim() || 'Untitled',
      icon: str(d.icon, 8).trim() || '📄',
      parent: ident(d.parent),
      appendTo: ident(d.appendTo),
      markdown: str(d.markdown, 500_000),
    }));

  const databases: ProposedDatabase[] = (Array.isArray(data.databases) ? data.databases : [])
    .filter((d: any) => d && typeof d.title === 'string')
    .slice(0, MAX_DATABASES)
    .map((d: any, i: number) => {
      const fields = (Array.isArray(d.fields) ? d.fields : [])
        .filter((f: any) => f && typeof f.name === 'string' && f.name.trim() && (FIELD_TYPES as readonly string[]).includes(f.type))
        .slice(0, 30)
        .map((f: any) => ({
          name: str(f.name, 80).trim(),
          type: f.type,
          options: (Array.isArray(f.options) ? f.options : [])
            .filter((o: unknown) => typeof o === 'string' && o.trim())
            .slice(0, 50)
            .map((o: string) => o.trim().slice(0, 80)),
        }));
      const rows = (Array.isArray(d.rows) ? d.rows : [])
        .filter((r: any) => r && typeof r === 'object')
        .slice(0, MAX_ROWS)
        .map((r: any) => ({
          name: str(r.name ?? r.title, 300).trim(),
          cells: r.cells && typeof r.cells === 'object' && !Array.isArray(r.cells) ? (r.cells as Record<string, unknown>) : {},
          notes: str(r.notes, 50_000),
        }));
      return {
        ref: refOf(d.ref, `db${i + 1}`),
        title: str(d.title, 200).trim() || 'Untitled',
        icon: str(d.icon, 8).trim() || '🗂️',
        parent: ident(d.parent),
        layout: (LAYOUTS as readonly string[]).includes(d.layout) ? d.layout : 'grid',
        fields,
        rows,
      };
    });

  const tasks: ProposedTask[] = (Array.isArray(data.tasks) ? data.tasks : [])
    .filter((t: any) => t && typeof t.title === 'string' && t.title.trim() && isDate(t.date))
    .slice(0, MAX_TASKS)
    .map((t: any) => {
      const r = t.repeat;
      const repeat =
        r && typeof r === 'object' && ['day', 'week', 'month', 'year'].includes(r.unit)
          ? { every: Math.max(1, Math.min(365, Math.round(Number(r.every) || 1))), unit: r.unit, until: isDate(r.until) ? r.until : null }
          : null;
      return {
        title: str(t.title, 300).trim(),
        date: t.date as string,
        endDate: isDate(t.endDate) && t.endDate > t.date ? t.endDate : null,
        time: clock(t.time),
        minutes: typeof t.minutes === 'number' && t.minutes > 0 && t.minutes < 24 * 60 ? Math.round(t.minutes) : null,
        notes: str(t.notes, 5000),
        color: COLORS.includes(t.color) ? t.color : null,
        reminder: typeof t.reminder === 'number' && t.reminder >= 0 && t.reminder <= 40320 ? Math.round(t.reminder) : null,
        repeat,
        document: ident(t.document),
        task: t.task !== false,
      };
    })
    .sort((a: ProposedTask, b: ProposedTask) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));

  const made = documents.length || databases.length || tasks.length;
  return { reply: str(data.reply, 100_000).trim() || (made ? 'Here is what I made.' : ''), proposal: { documents, databases, tasks } };
}

/** What the model sees of an earlier answer: the reply, and what it proposed. */
function assistantTurn(m: StoredMessage): string {
  const p = m.proposal;
  if (!p || (!p.documents.length && !p.tasks.length && !p.databases?.length)) return m.content;
  return JSON.stringify({ reply: m.content, documents: p.documents, databases: p.databases ?? [], tasks: p.tasks });
}

const settingsBody = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1, 'Choose a model').max(200),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Use a full address starting with http:// or https://')
    .nullable()
    .optional(),
  /** Omit to keep the saved key; '' removes it. */
  key: z.string().trim().max(500).optional(),
  useOwn: z.boolean().default(true),
});

export async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** What's available to this person: the server's connection, their own, and which is used. */
  app.get('/ai/status', async (req) => {
    const a = await aiAccess(req.user.id);
    return {
      available: !!a.active,
      source: a.active?.source ?? null,
      model: a.active ? { provider: a.active.provider, model: a.active.model } : null,
      shared: a.shared,
      canUseOwn: a.canUseOwn,
      own: a.own,
      defaults: DEFAULT_MODELS,
    };
  });

  app.put('/ai/connection', async (req) => {
    const body = parse(settingsBody, req.body);
    const a = await aiAccess(req.user.id);
    if (!a.canUseOwn) throw new HttpError(403, 'The administrator provides the AI connection on this server');
    const existing = await one<{ key_enc: string | null }>('select key_enc from ai_connections where user_id = $1', [req.user.id]);
    const keyEnc = body.key === undefined ? (existing?.key_enc ?? null) : body.key ? encryptKey(body.key) : null;
    if (!keyEnc && body.provider !== 'openai') throw new HttpError(400, 'Enter your API key');
    await query(
      `insert into ai_connections (user_id, provider, model, base_url, key_enc, use_own, updated_at) values ($1, $2, $3, $4, $5, $6, now())
       on conflict (user_id) do update set provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
         key_enc = excluded.key_enc, use_own = excluded.use_own, updated_at = now()`,
      [req.user.id, body.provider, body.model, body.baseUrl || null, keyEnc, body.useOwn],
    );
    return { ok: true };
  });

  app.delete('/ai/connection', async (req) => {
    await query('delete from ai_connections where user_id = $1', [req.user.id]);
    return { ok: true };
  });

  /** Lists the models a key can use (with the saved key when none is typed). */
  app.post('/ai/models', async (req) => {
    const body = parse(settingsBody.pick({ provider: true, baseUrl: true, key: true }), req.body);
    let key = body.key || null;
    if (!key) {
      const a = await aiAccess(req.user.id);
      if (a.active?.source === 'own' && a.own?.provider === body.provider) key = a.active.key;
    }
    return { models: await listModels({ provider: body.provider, model: '', baseUrl: body.baseUrl || null, key }) };
  });

  // ----- conversations -----

  app.get('/workspaces/:id/ai/chats', async (req) => {
    const { id } = parse(idParams, req.params);
    await requireMember(req.user.id, id);
    const chats = await query(
      `select id, title, updated_at as "updatedAt" from ai_chats where user_id = $1 and workspace_id = $2 order by updated_at desc limit 100`,
      [req.user.id, id],
    );
    return { chats };
  });

  async function chatOr404(userId: string, id: string) {
    const chat = await one<{ id: string; workspace_id: string; title: string; messages: StoredMessage[] }>(
      'select id, workspace_id, title, messages from ai_chats where id = $1 and user_id = $2',
      [id, userId],
    );
    if (!chat) throw new HttpError(404, 'Conversation not found');
    return chat;
  }

  /** A conversation, without the stored reference material. */
  const publicChat = (chat: { id: string; title: string; messages: StoredMessage[] }) => ({
    id: chat.id,
    title: chat.title,
    messages: chat.messages.map(({ context: _, ...m }) =>
      m.pending && Date.now() - new Date(m.at).getTime() > PENDING_MS ? { ...m, pending: false, error: 'No answer came back. Try again.' } : m,
    ),
  });

  app.get('/ai/chats/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { chat: publicChat(await chatOr404(req.user.id, id)) };
  });

  app.delete('/ai/chats/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await query('delete from ai_chats where id = $1 and user_id = $2', [id, req.user.id]);
    return { ok: true };
  });

  const busy = new Set<string>();

  /** Asks the assistant. Attached files arrive as text (the app reads PDFs and documents itself). */
  app.post('/workspaces/:id/ai/ask', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        chatId: z.uuid().nullable().optional(),
        message: z.string().trim().min(1, 'Write a message').max(20_000),
        attachments: z.array(z.object({ name: z.string().max(300), text: z.string().max(2_000_000) })).max(20).default([]),
        pageIds: z.array(z.uuid()).max(20).default([]),
        useCalendar: z.boolean().default(false),
        /** Look through the workspace for the pages and files that answer the question. */
        searchWorkspace: z.boolean().default(false),
        today: date,
        /** Rewrite an earlier question of yours: everything from it on is replaced. */
        editIndex: z.number().int().min(0).optional(),
      }),
      req.body,
    );
    await requireMember(req.user.id, id);
    const a = await aiAccess(req.user.id);
    if (!a.active) throw new HttpError(400, 'Set up an AI connection first (AI → Settings)');
    if (busy.has(req.user.id)) throw new HttpError(429, 'The assistant is still working on your last question');

    const chat = body.chatId ? await chatOr404(req.user.id, body.chatId) : null;
    if (chat && chat.workspace_id !== id) throw new HttpError(404, 'Conversation not found');
    if (body.editIndex !== undefined && chat?.messages[body.editIndex]?.role !== 'user') throw new HttpError(400, 'That message can’t be edited');
    await useAi(req.user.id);
    busy.add(req.user.id);
    let answering = false;
    try {

      // Reference material for this question, within the limit (anything cut is reported).
      let room = CONTEXT_LIMIT;
      const parts: string[] = [];
      const attached: NonNullable<StoredMessage['attachments']> = [];
      const add = (name: string, text: string) => {
        const clean = text.replace(/\u0000/g, '').trim();
        const take = Math.max(0, Math.min(clean.length, room));
        room -= take;
        parts.push(`<material name="${name.replace(/"/g, "'")}">\n${clean.slice(0, take)}${take < clean.length ? '\n[…the rest was left out: too long]' : ''}\n</material>`);
        attached.push({ name, chars: clean.length, truncated: take < clean.length });
      };
      for (const f of body.attachments) add(f.name, f.text);

      // "Search my workspace": the pages (and files) that best match the question go along as material.
      if (body.searchWorkspace) {
        const found = await searchForQuestion(req.user.id, id, body.message);
        for (const pageId of found.pageIds) if (!body.pageIds.includes(pageId)) body.pageIds.push(pageId);
        for (const f of found.files) add(`File: ${f.name}`, f.text);
        if (!found.pageIds.length && !found.files.length) add('Workspace search', 'Nothing in the workspace matched this question.');
      }

      if (body.pageIds.length) {
        const access = await accessMap(req.user.id, id);
        for (const pageId of body.pageIds) {
          if ((access.get(pageId) ?? 'none') === 'none') continue;
          const page = await one<{ title: string; type: string }>('select title, type from pages where id = $1 and workspace_id = $2 and deleted_at is null', [pageId, id]);
          if (!page) continue;
          const isDb = (DATABASE_TYPES as readonly string[]).includes(page.type);
          const text = await readDoc(pageId, null, (doc) =>
            isDb
              ? databaseToCsv(doc)
              : docToMarkdown(doc, page.title, { pageLink: () => ({ title: 'a page', href: null }), fileLink: () => null, eventLabel: () => null, boardLabel: () => null }),
          );
          add(`Page: ${page.title || 'Untitled'} (id ${pageId})`, text);
        }
      }

      if (body.useCalendar) {
        const until = addDays(body.today, 180);
        const events = await query<{ title: string; start: string; end: string | null; time: string | null; status: string | null }>(
          `select title, to_char(start_date, 'YYYY-MM-DD') as start, to_char(end_date, 'YYYY-MM-DD') as "end", start_time as time, status
             from events where workspace_id = $1 and start_date between $2 and $3 order by start_date, start_time nulls first limit 500`,
          [id, body.today, until],
        );
        const lines = events.map((e) => `${e.start}${e.end && e.end !== e.start ? `–${e.end}` : ''}${e.time ? ` ${e.time}` : ''}: ${e.title || 'Untitled'}${e.status ? ` (task, ${e.status})` : ''}`);
        add('Calendar for the next 6 months', lines.length ? lines.join('\n') : 'Nothing planned yet.');
      }

      // The workspace's pages (that this person can see), so new things can go under them.
      const role = await requireMember(req.user.id, id);
      const access = await accessMap(req.user.id, id);
      const listed = (
        await query<{ id: string; parent_id: string | null; type: string; title: string }>(
          'select id, parent_id, type, title from pages where workspace_id = $1 and deleted_at is null order by position, created_at',
          [id],
        )
      ).filter((p) => (access.get(p.id) ?? 'none') !== 'none');
      const pageList = listed
        .slice(0, MAX_LISTED_PAGES)
        .map((p) => `- ${p.title || 'Untitled'} | ${p.type} | id ${p.id}${p.parent_id ? ` | inside ${p.parent_id}` : ''} | ${access.get(p.id) === 'view' ? 'view only' : 'can edit'}`)
        .join('\n');
      const workspaceInfo = `<workspace>
This person is ${role === 'owner' ? 'an owner: they can add pages and databases anywhere' : 'a member: they CANNOT add pages or databases — only tasks, and text added (appendTo) to documents marked "can edit"'}.
Pages (title | type | id | parent | access):
${pageList || '(none yet)'}${listed.length > MAX_LISTED_PAGES ? `\n…and ${listed.length - MAX_LISTED_PAGES} more` : ''}
</workspace>`;

      const history = (chat?.messages ?? []).slice(0, body.editIndex);
      const turns: ChatTurn[] = [];
      for (let i = 0; i < history.length; i++) {
        const m = history[i];
        const next = history[i + 1];
        // A question that got no answer (it failed) is left out, with its error.
        if (m.role === 'user' && (!next || next.error || next.pending)) continue;
        if (m.role === 'assistant' && (m.error || m.pending)) continue;
        if (m.role === 'user') turns.push({ role: 'user', content: m.context ? `${m.context}\n\n${m.content}` : m.content });
        else turns.push({ role: 'assistant', content: assistantTurn(m) });
      }
      const context = parts.join('\n\n');
      turns.push({ role: 'user', content: `${workspaceInfo}\n\n${context ? `${context}\n\n` : ''}${body.message}` });

      // The question is saved straight away (with the answer marked as coming), so leaving the page or
      // closing the app doesn't lose it; the answer is saved into the conversation when it arrives.
      const now = new Date().toISOString();
      const asked: StoredMessage[] = [
        ...history,
        { role: 'user', content: body.message, at: now, ...(attached.length ? { attachments: attached, context } : {}) },
      ];
      const messages: StoredMessage[] = [...asked, { role: 'assistant', content: '', at: now, pending: true }];
      const title = chat?.title || body.message.split('\n')[0].slice(0, 80);
      const saved = chat
        ? await one<{ id: string }>('update ai_chats set messages = $2, updated_at = now() where id = $1 returning id', [chat.id, JSON.stringify(messages)])
        : await one<{ id: string }>('insert into ai_chats (user_id, workspace_id, title, messages) values ($1, $2, $3, $4) returning id', [
            req.user.id,
            id,
            title,
            JSON.stringify(messages),
          ]);
      const chatId = saved!.id;
      const userId = req.user.id;
      const finish = async (last: StoredMessage) => {
        await query('update ai_chats set messages = $2, updated_at = now() where id = $1', [chatId, JSON.stringify([...asked, last])]);
      };
      answering = true;
      void runInBackground(() => complete(a.active!, systemPrompt(body.today), turns, { json: true }))
        .then((answer) => {
          const { reply, proposal } = parseAnswer(answer);
          // Tasks dated before today can't be scheduled.
          proposal.tasks = proposal.tasks.filter((t) => t.date >= body.today);
          return finish({ role: 'assistant', content: reply || '…', at: new Date().toISOString(), proposal });
        })
        .catch((err) => finish({ role: 'assistant', content: '', at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }))
        .catch((err) => console.error('Saving an AI answer failed', err))
        .finally(() => busy.delete(userId));
      return { chat: publicChat({ id: chatId, title, messages }) };
    } finally {
      if (!answering) busy.delete(req.user.id);
    }
  });

  /**
   * Rewrites a piece of text as asked ("make it shorter", "fix the spelling", "translate to French"…),
   * for the AI button on selected text in pages and cards. Returns only the new text (Markdown).
   */
  app.post('/workspaces/:id/ai/transform', { bodyLimit: 2 * 1024 * 1024 }, asyncCapable(async (req) => {
    const { id } = parse(idParams, req.params);
    const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const taskShape = z.object({
      id: z.uuid(),
      title: z.string().max(500),
      startDate: date,
      startTime: time.nullable(),
      endDate: date.nullable(),
      endTime: time.nullable(),
      status: z.enum(['todo', 'doing', 'done']).nullable(),
      description: z.string().max(10_000),
    });
    const body = parse(
      z.object({
        text: z.string().max(100_000),
        instruction: z.string().trim().min(1, 'Say what to do').max(2_000),
        /** The rest of the page, for context (not rewritten). */
        context: z.string().max(200_000).default(''),
        /** Tasks and events among the selected blocks: the AI may change them. */
        events: z.array(taskShape).max(50).default([]),
        /** Attachments among the selected blocks: the AI reads their text. */
        fileIds: z.array(z.uuid()).max(10).default([]),
        today: date.optional(),
      }),
      req.body,
    );
    await requireMember(req.user.id, id);
    const a = await aiAccess(req.user.id);
    if (!a.active) throw new HttpError(400, 'Set up an AI connection first (AI → Settings)');
    await useAi(req.user.id);

    // Only files this person may see (not ones on pages hidden from them).
    const allowed = [...(await visibleFiles(req.user.id, id, body.fileIds))];
    const files = allowed.length
      ? await query<{ id: string; filename: string; text: string | null }>(
          `select id, filename, text_content as text from files where id = any($1::uuid[]) and workspace_id = $2`,
          [allowed, id],
        )
      : [];
    const withTasks = body.events.length > 0;
    const system = withTasks
      ? `You edit content inside ${config.appName}, a notes and documents app. Do exactly what the person asks with what they selected: text, and calendar tasks/events.${body.today ? ` Today is ${body.today}.` : ''}
Reply with ONLY a JSON object: {"text": string, "events": [ ... ]}.
- "text": the new Markdown for the selected text (or your answer, if they asked a question). Use "" to leave the text as it is when the request is only about the tasks.
- "events": only the tasks/events you change, each {"id": the same id, plus only the fields that change: "title", "startDate" (YYYY-MM-DD), "startTime" ("HH:MM" or null for all day), "endDate" (YYYY-MM-DD or null), "endTime" ("HH:MM" or null), "status" ("todo", "doing", "done", or null for an event), "description"}. Use [] when nothing about them changes.
Keep the language of the original unless asked to translate.`
      : `You edit text inside ${config.appName}, a notes and documents app. Do exactly what the person asks with the text they give you.
Reply with ONLY the resulting text, in Markdown (headings, lists, **bold**, tables are fine) — no introduction, no explanation, no quotes or code fences around it.
If they ask a question about the text (or the attached files) instead of asking for a change, answer briefly in Markdown.
Keep the language of the original text unless asked to translate.`;
    const parts = [
      body.context ? `<page>\n${body.context.slice(0, 60_000)}\n</page>` : '',
      ...files.map((f) => `<file name="${f.filename.replace(/"/g, "'")}">\n${(f.text ?? '(no readable text in this file)').slice(0, 60_000)}\n</file>`),
      withTasks ? `<tasks>\n${JSON.stringify(body.events, null, 1)}\n</tasks>` : '',
      body.text ? `<text>\n${body.text}\n</text>` : withTasks || files.length ? '<text>(no text selected)</text>' : '<text>(nothing selected: write new text at the cursor)</text>',
      `Instruction: ${body.instruction}`,
    ].filter(Boolean);
    const answer = await complete(a.active, system, [{ role: 'user', content: parts.join('\n\n') }], { json: withTasks });
    const clean = (t: string) => t.replace(/^```(?:markdown|md|json)?\n([\s\S]*?)\n```\s*$/, '$1').trim();
    if (!withTasks) return { text: clean(answer), events: [] };

    // Only real changes to the tasks that were sent, in the shapes the app accepts.
    const known = new Map(body.events.map((e) => [e.id, e]));
    let parsed: { text?: unknown; events?: unknown } = {};
    try {
      parsed = JSON.parse(clean(answer));
    } catch {
      return { text: clean(answer), events: [] };
    }
    const changes: Record<string, unknown>[] = [];
    for (const raw of Array.isArray(parsed.events) ? parsed.events : []) {
      const r = raw as Record<string, unknown>;
      const before = known.get(String(r.id));
      if (!before) continue;
      const change = taskShape.partial().safeParse(r);
      if (!change.success) continue;
      const diff: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(change.data)) if (k !== 'id' && v !== undefined && v !== (before as Record<string, unknown>)[k]) diff[k] = v;
      if (Object.keys(diff).length) changes.push({ id: before.id, ...diff });
    }
    return { text: typeof parsed.text === 'string' ? clean(parsed.text) : '', events: changes };
  }));

  /** Turns an uploaded recording (audio or video) into text, for pasting into a page. */
  app.post('/workspaces/:id/ai/transcribe', asyncCapable(async (req) => {
    const { id } = parse(idParams, req.params);
    const { fileId } = parse(z.object({ fileId: z.uuid() }), req.body);
    await requireMember(req.user.id, id, undefined, true);
    const file = await one<{ id: string; filename: string; mime_type: string; size: string }>(
      'select id, filename, mime_type, size from files where id = $1 and workspace_id = $2',
      [fileId, id],
    );
    if (!file) throw new HttpError(404, 'File not found');
    if (!/^(audio|video)\//.test(file.mime_type) && !/\.(mp3|m4a|wav|ogg|oga|webm|mp4|mov|flac|aac)$/i.test(file.filename)) {
      throw new HttpError(400, 'Only audio and video recordings can be transcribed');
    }
    const a = await aiAccess(req.user.id);
    if (!a.active) throw new HttpError(400, 'Set up an AI connection first (AI → Settings)');
    await useAi(req.user.id);
    return { text: await transcribeFile(a.active, file) };
  }));

  /** Records what was added to the workspace from an answer (the app creates the pages and tasks). */
  /** How a background AI request is getting on (see aiJobs.ts). */
  app.get('/ai/jobs/:id', async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return jobState(id, req.user.id);
  });

  app.post('/ai/chats/:id/applied', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        index: z.number().int().min(0),
        pages: z.array(z.object({ id: z.uuid(), title: z.string().max(300) })).max(MAX_DOCUMENTS),
        tasks: z.number().int().min(0).max(MAX_TASKS),
      }),
      req.body,
    );
    const chat = await chatOr404(req.user.id, id);
    const m = chat.messages[body.index];
    if (!m || m.role !== 'assistant') throw new HttpError(400, 'Unknown answer');
    const prev = m.applied ?? { pages: [], tasks: 0 };
    m.applied = { pages: [...prev.pages, ...body.pages], tasks: prev.tasks + body.tasks };
    await query('update ai_chats set messages = $2, updated_at = now() where id = $1', [id, JSON.stringify(chat.messages)]);
    return { chat: publicChat(chat) };
  });
}
