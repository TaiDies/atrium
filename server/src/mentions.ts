import * as Y from 'yjs';
import { accessMap } from './access.js';
import { one, query } from './db.js';
import { fieldsOf } from './docIndex.js';
import { notify } from './notify.js';
import { followersOf } from './routes/social.js';

// Telling people when they're @mentioned in a page or card, and when someone comments on a page they
// started or a thread they're part of. Each mention and comment notifies once (kept in doc_notices).

interface Mention {
  userId: string;
  blockId: string;
  text: string;
}

interface Comment {
  id: string;
  threadId: string;
  userId: string;
  text: string;
  /** Everyone who wrote earlier in the same thread. */
  participants: string[];
}

function plainText(el: Y.XmlElement): string {
  return el
    .toArray()
    .map((c) =>
      c instanceof Y.XmlText
        ? c.toDelta().map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : '')).join('')
        : c instanceof Y.XmlElement
          ? c.nodeName === 'personMention'
            ? `@${c.getAttribute('name') ?? ''}`
            : plainText(c)
          : '',
    )
    .join('');
}

function mentionsOf(doc: Y.Doc): Mention[] {
  const out: Mention[] = [];
  const visit = (node: Y.XmlElement | Y.XmlFragment, block: { id: string; content: Y.XmlElement | null } | null) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'personMention' && block?.id) {
        const userId = String(child.getAttribute('userId') ?? '');
        if (userId) out.push({ userId, blockId: block.id, text: block.content ? plainText(block.content).trim() : '' });
      }
      if (child.nodeName === 'blockContainer') {
        const first = child.get(0);
        visit(child, { id: String(child.getAttribute('id') ?? ''), content: first instanceof Y.XmlElement ? first : null });
      } else {
        visit(child, block);
      }
    }
  };
  visit(doc.getXmlFragment('document-store'), null);
  return out;
}

/** The words in a comment (stored as BlockNote blocks). */
function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return body.map(bodyText).filter(Boolean).join(' ');
  if (body && typeof body === 'object') {
    const b = body as { text?: unknown; content?: unknown; children?: unknown };
    if (typeof b.text === 'string') return b.text;
    return [bodyText(b.content), bodyText(b.children)].filter(Boolean).join(' ');
  }
  return '';
}

function commentsOf(doc: Y.Doc): Comment[] {
  const out: Comment[] = [];
  for (const [threadId, thread] of doc.getMap('threads').entries()) {
    if (!(thread instanceof Y.Map)) continue;
    const comments = thread.get('comments');
    if (!(comments instanceof Y.Array)) continue;
    const authors: string[] = [];
    for (const c of comments.toArray()) {
      if (!(c instanceof Y.Map)) continue;
      const userId = String(c.get('userId') ?? '');
      if (c.get('id') && userId && !c.get('deletedAt')) {
        out.push({ id: String(c.get('id')), threadId, userId, text: bodyText(c.get('body')).trim(), participants: [...new Set(authors)] });
      }
      if (userId) authors.push(userId);
    }
  }
  return out;
}

/** Records which mentions and comments a document has, notifying anyone not told yet (unless `log` is off). */
export async function noticeMentions(pageId: string, rowId: string | null, doc: Y.Doc, opts: { editor: string | null; log: boolean }) {
  const row = rowId ?? '';
  const mentions = mentionsOf(doc);
  const comments = commentsOf(doc);
  if (!mentions.length && !comments.length) return;
  const keys = [...mentions.map((m) => `mention:${m.userId}:${m.blockId}`), ...comments.map((c) => `comment:${c.id}`)];
  const added = new Set(
    (
      await query<{ key: string }>(
        `insert into doc_notices (page_id, row_id, key) select $1, $2, unnest($3::text[]) on conflict do nothing returning key`,
        [pageId, row, keys],
      )
    ).map((r) => r.key),
  );
  if (!opts.log || !added.size) return;

  const page = await one<{ workspace_id: string; title: string; created_by: string | null }>('select workspace_id, title, created_by from pages where id = $1', [pageId]);
  if (!page) return;
  let title = page.title || 'Untitled';
  if (rowId) {
    const card = await cardTitle(pageId, rowId);
    if (card) title = `${card} (in ${title})`;
  }
  const base = rowId ? `/w/${page.workspace_id}/p/${pageId}?row=${pageId}:${rowId}` : `/w/${page.workspace_id}/p/${pageId}`;
  const names = new Map<string, string>();
  const nameOf = async (id: string | null) => {
    if (!id) return 'Someone';
    if (!names.has(id)) names.set(id, (await one<{ name: string }>('select name from users where id = $1', [id]))?.name ?? 'Someone');
    return names.get(id)!;
  };
  // Only people who can see the page hear about it.
  const canSee = async (userId: string) => {
    try {
      return ((await accessMap(userId, page.workspace_id)).get(pageId) ?? 'none') !== 'none';
    } catch {
      return false;
    }
  };

  const told = new Set<string>();
  for (const m of mentions) {
    const key = `mention:${m.userId}:${m.blockId}`;
    if (!added.has(key) || told.has(key) || m.userId === opts.editor) continue;
    told.add(key);
    if (!(await canSee(m.userId))) continue;
    await notify(m.userId, {
      kind: 'mention',
      title: `${await nameOf(opts.editor)} mentioned you in “${title}”`,
      body: m.text.slice(0, 300),
      link: `${base}#block-${m.blockId}`,
    });
  }
  for (const c of comments) {
    if (!added.has(`comment:${c.id}`)) continue;
    const reply = c.participants.length > 0;
    const to = new Set([...c.participants, ...(page.created_by ? [page.created_by] : []), ...(await followersOf(pageId))]);
    to.delete(c.userId);
    for (const userId of to) {
      if (!(await canSee(userId))) continue;
      await notify(userId, {
        kind: 'comment',
        title: `${await nameOf(c.userId)} ${reply ? 'replied to a comment' : 'commented'} in “${title}”`,
        body: c.text.slice(0, 300),
        link: `${base}${rowId ? '&' : '?'}comments=open`,
      });
    }
  }
}

/** A card's title, from its row in the database page (the card document only holds the body). */
async function cardTitle(pageId: string, rowId: string): Promise<string> {
  const stored = await one<{ state: Buffer }>('select state from page_content where page_id = $1', [pageId]);
  if (!stored) return '';
  const db = new Y.Doc();
  try {
    Y.applyUpdate(db, new Uint8Array(stored.state));
    const fields = fieldsOf(db);
    const primary = fields.find((f) => f.primary) ?? fields[0];
    const row = db.getArray<Y.Map<unknown>>('rows').toArray().find((r) => r instanceof Y.Map && r.get('id') === rowId);
    const cells = row?.get('cells');
    const v = primary && cells instanceof Y.Map ? cells.get(primary.id) : null;
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  } finally {
    db.destroy();
  }
}
