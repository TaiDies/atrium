import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { Database } from '@hocuspocus/extension-database';
import { Hocuspocus } from '@hocuspocus/server';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { accessMap, atLeast } from './access.js';
import { parseCookieHeader, sessionToken, userFromToken, websocketOriginOk, type SessionUser } from './auth.js';
import { one, query } from './db.js';
import { updateDocIndex } from './docIndex.js';
import { recordVersion } from './routes/history.js';
import { noticeEdit, trackConnection, untrackConnection } from './routes/social.js';

interface CollabContext {
  user?: SessionUser;
}

export const DATABASE_TYPES = ['grid', 'board', 'calendar', 'list', 'gallery', 'feed', 'timeline', 'chart', 'form'] as const;
export type DatabaseType = (typeof DATABASE_TYPES)[number];

const VIEW_NAMES: Record<DatabaseType, string> = {
  grid: 'Grid',
  board: 'Board',
  calendar: 'Calendar',
  list: 'List',
  gallery: 'Gallery',
  feed: 'Feed',
  timeline: 'Timeline',
  chart: 'Chart',
  form: 'Form',
};

// A document name is either "<pageId>" (the page itself) or "<pageId>:<rowId>" (a database row's document).
const NAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):?([A-Za-z0-9_-]{1,64})?$/i;

function parseName(name: string): { pageId: string; rowId: string | null } | null {
  const m = NAME_RE.exec(name);
  return m ? { pageId: m[1], rowId: m[2] ?? null } : null;
}

// "file:<fileId>" holds the pen and highlighter strokes drawn on an uploaded file (see notes in the web app).
const FILE_DOC_RE = /^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const fileDocName = (fileId: string) => `file:${fileId}`;

// "board:<whiteboardId>" holds a whiteboard's elements, shared live like any other document.
const BOARD_DOC_RE = /^board:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const boardDocName = (boardId: string) => `board:${boardId}`;

/** Whiteboard elements that are still on the canvas (Excalidraw keeps deleted ones, flagged). */
export function liveElementCount(doc: Y.Doc) {
  let n = 0;
  doc.getMap<{ isDeleted?: boolean }>('elements').forEach((el) => {
    if (el && !el.isDeleted) n++;
  });
  return n;
}

/**
 * Guests only see what's shared with them: a whiteboard or file only when it sits on a page they can
 * open, and read-only unless they can edit that page.
 */
async function guestAccess(userId: string, workspaceId: string, table: 'board_refs' | 'file_refs', column: 'board_id' | 'file_id', id: string, connectionConfig: { readOnly: boolean }) {
  const refs = await query<{ page_id: string }>(`select page_id from ${table} where ${column} = $1`, [id]);
  const access = await accessMap(userId, workspaceId);
  const levels = refs.map((r) => access.get(r.page_id) ?? 'none');
  if (!levels.some((l) => l !== 'none')) throw new Error('Forbidden');
  if (!levels.some((l) => atLeast(l, 'edit'))) connectionConfig.readOnly = true;
}

export const hocuspocus = new Hocuspocus<CollabContext>({
  name: 'atrium',
  quiet: true,
  debounce: 1500,
  maxDebounce: 10000,

  async connected({ socketId, documentName, context }) {
    trackConnection(socketId, documentName, context.user);
  },

  async onDisconnect({ socketId, documentName }) {
    untrackConnection(socketId, documentName);
  },

  async onAuthenticate({ context, documentName, connectionConfig }) {
    if (!context.user) throw new Error('Not signed in');
    const boardMatch = BOARD_DOC_RE.exec(documentName);
    if (boardMatch) {
      // Whiteboards are shared with the whole workspace, like files (guests: see guestAccess).
      const board = await one<{ workspace_id: string; role: string }>(
        `select b.workspace_id, m.role from whiteboards b join workspace_members m on m.workspace_id = b.workspace_id and m.user_id = $2 where b.id = $1`,
        [boardMatch[1], context.user.id],
      );
      if (!board) throw new Error('Forbidden');
      if (board.role === 'guest') await guestAccess(context.user.id, board.workspace_id, 'board_refs', 'board_id', boardMatch[1], connectionConfig);
      return;
    }
    const fileMatch = FILE_DOC_RE.exec(documentName);
    if (fileMatch) {
      // Anyone in the workspace can open (and write on) its files, the same as downloading them.
      const file = await one<{ workspace_id: string; role: string }>(
        `select f.workspace_id, m.role from files f join workspace_members m on m.workspace_id = f.workspace_id and m.user_id = $2 where f.id = $1`,
        [fileMatch[1], context.user.id],
      );
      if (!file) throw new Error('Forbidden');
      if (file.role === 'guest') await guestAccess(context.user.id, file.workspace_id, 'file_refs', 'file_id', fileMatch[1], connectionConfig);
      return;
    }
    const parsed = parseName(documentName);
    if (!parsed) throw new Error('Unknown document');
    const page = await one<{ workspace_id: string }>(
      `select p.workspace_id from pages p
         join workspace_members m on m.workspace_id = p.workspace_id and m.user_id = $2
        where p.id = $1 and p.deleted_at is null`,
      [parsed.pageId, context.user.id],
    );
    if (!page) throw new Error('Forbidden');
    const access = (await accessMap(context.user.id, page.workspace_id)).get(parsed.pageId) ?? 'none';
    if (access === 'none') throw new Error('Forbidden');
    // Viewers receive live changes but anything they send is ignored.
    if (!atLeast(access, 'edit')) connectionConfig.readOnly = true;
  },

  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const boardMatch = BOARD_DOC_RE.exec(documentName);
        if (boardMatch) {
          const row = await one<{ state: Buffer | null }>('select state from whiteboards where id = $1', [boardMatch[1]]);
          return row?.state ? new Uint8Array(row.state) : null;
        }
        const fileMatch = FILE_DOC_RE.exec(documentName);
        if (fileMatch) {
          const row = await one<{ state: Buffer }>('select state from file_annotations where file_id = $1', [fileMatch[1]]);
          return row ? new Uint8Array(row.state) : null;
        }
        const parsed = parseName(documentName);
        if (!parsed) return null;
        const row = parsed.rowId
          ? await one<{ state: Buffer }>('select state from row_documents where page_id = $1 and row_id = $2', [parsed.pageId, parsed.rowId])
          : await one<{ state: Buffer }>('select state from page_content where page_id = $1', [parsed.pageId]);
        return row ? new Uint8Array(row.state) : null;
      },
      store: async ({ documentName, state, document, lastContext }) => {
        const boardMatch = BOARD_DOC_RE.exec(documentName);
        if (boardMatch) {
          await query('update whiteboards set state = $2, element_count = $3, updated_at = now() where id = $1', [boardMatch[1], state, liveElementCount(document)]);
          return;
        }
        const fileMatch = FILE_DOC_RE.exec(documentName);
        if (fileMatch) {
          const strokes = document.getArray('strokes').length;
          try {
            await query(
              `insert into file_annotations (file_id, state, stroke_count, updated_at) values ($1, $2, $3, now())
               on conflict (file_id) do update set state = excluded.state, stroke_count = excluded.stroke_count, updated_at = now()`,
              [fileMatch[1], state, strokes],
            );
            await query('update files set updated_at = now() where id = $1', [fileMatch[1]]);
          } catch (err: any) {
            if (err?.code !== '23503') throw err; // the file was deleted
          }
          return;
        }
        const parsed = parseName(documentName);
        if (!parsed) return;
        try {
          if (parsed.rowId) {
            await query(
              `insert into row_documents (page_id, row_id, state, text_content, updated_at) values ($1, $2, $3, $4, now())
               on conflict (page_id, row_id) do update
                 set state = excluded.state, text_content = excluded.text_content, updated_at = now()`,
              [parsed.pageId, parsed.rowId, state, extractText(document)],
            );
          } else {
            await query(
              `insert into page_content (page_id, state, text_content, updated_at) values ($1, $2, $3, now())
               on conflict (page_id) do update
                 set state = excluded.state, text_content = excluded.text_content, updated_at = now()`,
              [parsed.pageId, state, extractText(document)],
            );
          }
          await query('update pages set updated_at = now(), updated_by = coalesce($2, updated_by) where id = $1', [
            parsed.pageId,
            (lastContext as CollabContext | undefined)?.user?.id ?? null,
          ]);
          await updateDocIndex(parsed.pageId, parsed.rowId, document, { editor: (lastContext as CollabContext | undefined)?.user?.id ?? null });
          await recordVersion(parsed.pageId, parsed.rowId, state, (lastContext as CollabContext | undefined)?.user?.id ?? null);
          if (!parsed.rowId?.startsWith('tpl_')) await noticeEdit(parsed.pageId, (lastContext as CollabContext | undefined)?.user?.id ?? null);
        } catch (err: any) {
          // The page was permanently deleted while the document was still open.
          if (err?.code !== '23503') throw err;
        }
      },
    }),
  ],
});

function map(entries: Record<string, unknown>) {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12);

/** Initial Yjs state for a new database page, set up for the chosen layout. */
export function createDatabaseState(type: DatabaseType): { state: Buffer; text: string } {
  const doc = new Y.Doc();
  const fields = doc.getArray<Y.Map<unknown>>('fields');
  const rows = doc.getArray<Y.Map<unknown>>('rows');
  const views = doc.getArray<Y.Map<unknown>>('views');

  const ids = { name: shortId(), status: shortId(), date: shortId(), end: shortId(), done: shortId(), points: shortId(), media: shortId(), email: shortId(), feedback: shortId(), rating: shortId() };
  const opt = { todo: shortId(), doing: shortId(), done: shortId() };
  const statusOptions = [
    { id: opt.todo, name: 'To Do', color: 'purple' },
    { id: opt.doing, name: 'Doing', color: 'orange' },
    { id: opt.done, name: 'Done', color: 'green' },
  ];
  const field = (entries: Record<string, unknown>) => fields.push([map({ width: 180, ...entries })]);
  const day = (offset: number) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  field({ id: ids.name, name: 'Name', type: 'text', primary: true, width: 240 });
  const status = () => field({ id: ids.status, name: type === 'grid' ? 'Type' : 'Status', type: 'select', options: statusOptions, width: 160 });
  const seedRows: Record<string, unknown>[] = [];
  const view: Record<string, unknown> = { groupBy: null, dateField: null };

  switch (type) {
    case 'grid':
      status();
      field({ id: ids.done, name: 'Done', type: 'checkbox', width: 100 });
      seedRows.push({}, {}, {});
      break;
    case 'board':
      status();
      for (let i = 1; i <= 3; i++) seedRows.push({ [ids.name]: `Card ${i}`, [ids.status]: opt.todo });
      view.groupBy = ids.status;
      break;
    case 'calendar':
      field({ id: ids.date, name: 'Date', type: 'date', width: 160 });
      view.dateField = ids.date;
      break;
    case 'list':
    case 'feed':
      status();
      field({ id: ids.date, name: 'Date', type: 'date', width: 160 });
      for (const [i, s] of [opt.todo, opt.doing, opt.done].entries()) seedRows.push({ [ids.name]: type === 'feed' ? `Post ${i + 1}` : `Item ${i + 1}`, [ids.status]: s, [ids.date]: day(i) });
      break;
    case 'gallery':
      status();
      field({ id: ids.media, name: 'Cover', type: 'media' });
      for (let i = 1; i <= 3; i++) seedRows.push({ [ids.name]: `Card ${i}`, [ids.status]: opt.todo });
      break;
    case 'timeline':
      field({ id: ids.date, name: 'Start', type: 'date', width: 150 });
      field({ id: ids.end, name: 'End', type: 'date', width: 150 });
      status();
      seedRows.push(
        { [ids.name]: 'Research', [ids.date]: day(0), [ids.end]: day(3), [ids.status]: opt.doing },
        { [ids.name]: 'Design', [ids.date]: day(3), [ids.end]: day(8), [ids.status]: opt.todo },
        { [ids.name]: 'Build', [ids.date]: day(7), [ids.end]: day(15), [ids.status]: opt.todo },
      );
      view.dateField = ids.date;
      view.endField = ids.end;
      break;
    case 'chart':
      status();
      field({ id: ids.points, name: 'Points', type: 'number', width: 120 });
      for (const [s, p] of [[opt.todo, 3], [opt.todo, 5], [opt.doing, 2], [opt.done, 8]] as const) seedRows.push({ [ids.name]: `Task ${seedRows.length + 1}`, [ids.status]: s, [ids.points]: p });
      view.chart = { kind: 'bar', groupBy: ids.status, metric: 'count', valueField: ids.points };
      break;
    case 'form':
      field({ id: ids.email, name: 'Email', type: 'text' });
      field({ id: ids.feedback, name: 'Feedback', type: 'text', width: 280 });
      field({
        id: ids.rating,
        name: 'Rating',
        type: 'select',
        options: ['1', '2', '3', '4', '5'].map((n, i) => ({ id: shortId(), name: n, color: ['purple', 'blue', 'aqua', 'green', 'yellow'][i] })),
      });
      view.form = {
        published: false,
        title: 'Feedback form',
        description: 'Tell us what you think.',
        submitText: 'Submit',
        items: [
          { fieldId: ids.name, required: true },
          { fieldId: ids.email, required: false },
          { fieldId: ids.feedback, required: false },
          { fieldId: ids.rating, required: false },
        ],
      };
      break;
  }

  const now = Date.now();
  for (const cellValues of seedRows) {
    const cells = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(cellValues)) cells.set(k, v);
    rows.push([map({ id: shortId(), createdAt: now, updatedAt: now, cells })]);
  }

  views.push([map({ id: shortId(), name: VIEW_NAMES[type], type, sorts: [], filters: [], hidden: [], ...view })]);
  if (type === 'form') {
    views.push([map({ id: shortId(), name: 'Responses', type: 'grid', groupBy: null, dateField: null, sorts: [], filters: [], hidden: [] })]);
  }

  return { state: Buffer.from(Y.encodeStateAsUpdate(doc)), text: extractText(doc) };
}

/** Plain text of a page or row document, used for full-text search. */
export function extractText(doc: Y.Doc): string {
  const parts: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta()) if (typeof op.insert === 'string') parts.push(op.insert);
      parts.push(' ');
      return;
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) walk(child);
    }
  };
  walk(doc.getXmlFragment('document-store'));

  for (const field of doc.getArray<Y.Map<unknown>>('fields').toArray()) {
    if (field instanceof Y.Map) parts.push(String(field.get('name') ?? ''), ' ');
  }
  for (const row of doc.getArray<Y.Map<unknown>>('rows').toArray()) {
    const cells = row instanceof Y.Map ? row.get('cells') : null;
    if (!(cells instanceof Y.Map)) continue;
    for (const value of cells.values()) if (typeof value === 'string') parts.push(value, ' ');
  }
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, 200_000);
}

/**
 * Adds a "sub-page" block that links to `childId` at the end of a document page,
 * the way a new sub-page shows up inside its parent.
 */
export async function appendSubpageBlock(parentId: string, childId: string) {
  const connection = await hocuspocus.openDirectConnection(parentId, {});
  try {
    await connection.transact((doc) => {
      const fragment = doc.getXmlFragment('document-store');
      let group = fragment.get(0);
      if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') {
        group = new Y.XmlElement('blockGroup');
        fragment.insert(fragment.length, [group]);
      }
      const container = new Y.XmlElement('blockContainer');
      container.setAttribute('id', randomUUID());
      const block = new Y.XmlElement('subpage');
      block.setAttribute('pageId', childId);
      container.insert(0, [block]);

      // Keep the editor's trailing empty paragraph last.
      const blocks = (group as Y.XmlElement).toArray();
      const last = blocks[blocks.length - 1];
      const lastIsEmpty =
        last instanceof Y.XmlElement &&
        last.length === 1 &&
        last.get(0) instanceof Y.XmlElement &&
        (last.get(0) as Y.XmlElement).nodeName === 'paragraph' &&
        (last.get(0) as Y.XmlElement).toArray().every((t) => t instanceof Y.XmlText && t.length === 0);
      (group as Y.XmlElement).insert(lastIsEmpty ? blocks.length - 1 : blocks.length, [container]);
    });
  } finally {
    await connection.disconnect();
  }
}

// ---------- public forms ----------

export interface PublicFormField {
  id: string;
  name: string;
  type: string;
  required: boolean;
  options?: { id: string; name: string; color: string }[];
}

export interface PublicForm {
  title: string;
  description: string;
  submitText: string;
  fields: PublicFormField[];
}

const FORM_TYPES = new Set(['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url']);

/** Reads a published Form view, or null when it doesn't exist or isn't published. */
function formFromDoc(doc: Y.Doc, viewId: string): PublicForm | null {
  const view = doc.getArray<Y.Map<unknown>>('views').toArray().find((v) => v instanceof Y.Map && v.get('id') === viewId);
  if (!view || view.get('type') !== 'form') return null;
  const form = view.get('form') as { published?: boolean; title?: string; description?: string; submitText?: string; items?: { fieldId: string; required?: boolean }[] } | undefined;
  if (!form?.published) return null;
  const fields = new Map(
    doc
      .getArray<Y.Map<unknown>>('fields')
      .toArray()
      .filter((f) => f instanceof Y.Map)
      .map((f) => [String(f.get('id')), f.toJSON() as { id: string; name: string; type: string; options?: PublicFormField['options'] }]),
  );
  return {
    title: form.title || 'Form',
    description: form.description || '',
    submitText: form.submitText || 'Submit',
    fields: (form.items ?? [])
      .map((item) => {
        const f = fields.get(item.fieldId);
        if (!f || !FORM_TYPES.has(f.type)) return null;
        return { id: f.id, name: f.name, type: f.type, required: !!item.required, ...(f.options ? { options: f.options } : {}) };
      })
      .filter((f): f is PublicFormField => !!f),
  };
}

/** Runs `fn` against a database page's document; `found` is false when there's no such live database. */
async function withDoc<T>(pageId: string, fn: (doc: Y.Doc) => T): Promise<{ found: false } | { found: true; value: T }> {
  const page = await one<{ deleted_at: Date | null; type: string }>('select deleted_at, type from pages where id = $1', [pageId]);
  if (!page || page.deleted_at || page.type === 'document') return { found: false };
  const connection = await hocuspocus.openDirectConnection(pageId, {});
  try {
    let value!: T;
    await connection.transact((doc) => {
      value = fn(doc);
    });
    return { found: true, value };
  } finally {
    await connection.disconnect();
  }
}

export async function readPublicForm(pageId: string, viewId: string): Promise<PublicForm | null> {
  const result = await withDoc(pageId, (doc) => formFromDoc(doc, viewId));
  return result.found ? result.value : null;
}

/** Validates a submission against the form and adds it as a new row. Returns an error message or null. */
export async function submitPublicForm(pageId: string, viewId: string, values: Record<string, unknown>): Promise<string | null> {
  const outcome = await withDoc(pageId, (doc): string | null => {
    const form = formFromDoc(doc, viewId);
    if (!form) return 'not-found';
    const cells = new Y.Map<unknown>();
    for (const f of form.fields) {
      const raw = values[f.id];
      let value: unknown = null;
      if (f.type === 'text' || f.type === 'url') value = typeof raw === 'string' ? raw.trim().slice(0, 5000) : null;
      else if (f.type === 'number') value = raw === '' || raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
      else if (f.type === 'checkbox') value = raw === true;
      else if (f.type === 'date') value = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
      else if (f.type === 'select') value = f.options?.some((o) => o.id === raw) ? raw : null;
      else if (f.type === 'multi_select') value = Array.isArray(raw) ? raw.filter((id) => f.options?.some((o) => o.id === id)) : [];
      const empty = value === null || value === '' || value === false || (Array.isArray(value) && value.length === 0);
      if (f.required && empty) return `“${f.name}” is required`;
      if (!empty) cells.set(f.id, value);
    }
    const now = Date.now();
    doc.getArray<Y.Map<unknown>>('rows').push([map({ id: shortId(), createdAt: now, updatedAt: now, cells })]);
    return null;
  });
  return outcome.found ? outcome.value : 'not-found';
}

/** Apply a Yjs update to a page document; it is persisted and broadcast like any edit. */
export async function applyUpdate(pageId: string, update: Uint8Array) {
  const connection = await hocuspocus.openDirectConnection(pageId, {});
  try {
    await connection.transact((doc) => {
      try {
        Y.applyUpdate(doc, update);
      } catch {
        throw Object.assign(new Error('Invalid document data'), { statusCode: 400 });
      }
    });
  } finally {
    await connection.disconnect();
  }
}

/** Tell everyone viewing a page that its title, icon or location changed. */
export function notifyPageChanged(pageId: string) {
  hocuspocus.documents.get(pageId)?.broadcastStateless(JSON.stringify({ type: 'page-updated' }));
}

export function closeFileDoc(fileId: string) {
  hocuspocus.closeConnections(fileDocName(fileId));
}

export function closeBoardDoc(boardId: string) {
  hocuspocus.closeConnections(boardDocName(boardId));
}

export function closePage(pageId: string) {
  hocuspocus.closeConnections(pageId);
}

/** Each person's open live connections, so they can be cut off (e.g. when the admin disables them). */
const socketsByUser = new Map<string, Set<WebSocket>>();

export function closeUserSessions(userId: string) {
  for (const ws of socketsByUser.get(userId) ?? []) ws.close(4401, 'Signed out');
}

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
}

export function attachCollab(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    // Anything that goes wrong with one connection closes that connection, never the server.
    upgrade(req, socket, head).catch((err) => {
      console.error('A live-editing connection failed', err);
      socket.destroy();
    });
  });

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy(); // a request target that isn't a path, such as "//%"
      return;
    }
    if (url.pathname === '/live') return; // the live channel (live.ts) answers that one
    if (url.pathname !== '/collab') {
      socket.destroy();
      return;
    }
    // The web app signs in with its cookie; the desktop and phone apps pass a live-editing ticket instead.
    const cookie = sessionToken(parseCookieHeader(req.headers.cookie));
    const ticket = url.searchParams.get('ticket') ?? undefined;
    if (!websocketOriginOk(req.headers, !cookie)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = await (cookie ? userFromToken(cookie) : userFromToken(ticket, 'live')).catch(() => null);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const connection = hocuspocus.handleConnection(ws, new Request(`http://localhost${req.url}`, { headers }), { user });
      const mine = socketsByUser.get(user.id) ?? new Set();
      mine.add(ws);
      socketsByUser.set(user.id, mine);
      const ping = setInterval(() => ws.ping(), 15_000);
      ws.on('message', (data) => {
        try {
          connection.handleMessage(toUint8(data));
        } catch (err) {
          console.error('A live-editing message failed', err);
          ws.terminate();
        }
      });
      ws.on('pong', () => connection.touch());
      ws.on('close', (code, reason) => {
        clearInterval(ping);
        mine.delete(ws);
        if (!mine.size) socketsByUser.delete(user.id);
        connection.handleClose({ code, reason: reason.toString() });
      });
      ws.on('error', () => ws.terminate());
    });
  }
}
