import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';

// Markdown written to a page through the API, as editor blocks: headings, paragraphs, bullet,
// numbered and to-do lists (nested by indent), quotes, code and dividers, with **bold**, *italic*,
// ~~strike~~, `code` and [links](https://…) in the text.

interface Line {
  indent: number;
  node: string;
  attrs: Record<string, string | boolean>;
  text: string;
}

function parseLines(markdown: string): Line[] {
  const out: Line[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const fence = /^\s*```(\w*)\s*$/.exec(raw);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      out.push({ indent: 0, node: 'codeBlock', attrs: { language: fence[1] || 'text' }, text: code.join('\n') });
      continue;
    }
    const indent = Math.floor((/^\s*/.exec(raw)![0].replace(/\t/g, '  ').length) / 2);
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) out.push({ indent: 0, node: 'heading', attrs: { level: String(m[1].length) }, text: m[2] });
    else if ((m = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) out.push({ indent, node: 'checkListItem', attrs: { checked: m[1] !== ' ' }, text: m[2] });
    else if ((m = /^[-*+]\s+(.*)$/.exec(line))) out.push({ indent, node: 'bulletListItem', attrs: {}, text: m[1] });
    else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) out.push({ indent, node: 'numberedListItem', attrs: {}, text: m[1] });
    else if ((m = /^>\s?(.*)$/.exec(line))) out.push({ indent: 0, node: 'quote', attrs: {}, text: m[1] });
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) out.push({ indent: 0, node: 'divider', attrs: {}, text: '' });
    else out.push({ indent, node: 'paragraph', attrs: {}, text: line });
  }
  return out;
}

/** Longest line whose inline formatting is read. */
const MAX_INLINE = 20_000;

/** Inline Markdown as text runs with formatting (marks as y-prosemirror stores them). */
function inline(text: string, pages?: PageLinks): { insert: string; attributes?: Record<string, unknown> }[] {
  const runs: { insert: string; attributes?: Record<string, unknown> }[] = [];
  // A very long line is kept as plain text: formatting is only looked for in lines of normal length,
  // and every part of the pattern has a bounded length, so odd input (thousands of "[") stays fast.
  if (text.length > MAX_INLINE) return text ? [{ insert: text }] : [];
  const re = /(\*\*([^*\n]{1,2000})\*\*)|(~~([^~\n]{1,2000})~~)|(`([^`\n]{1,2000})`)|(\[([^\]\n]{1,500})\]\((https?:\/\/[^)\s]{1,2000})\))|(\*([^*\n]{1,2000})\*)|(_([^_\n]{1,2000})_)|(\[\[([^\]|\n]{1,300})(?:\|([^\]\n]{1,300}))?\]\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ insert: text.slice(last, m.index) });
    if (m[2]) runs.push({ insert: m[2], attributes: { bold: {} } });
    else if (m[4]) runs.push({ insert: m[4], attributes: { strike: {} } });
    else if (m[6]) runs.push({ insert: m[6], attributes: { code: {} } });
    else if (m[8]) runs.push({ insert: m[8], attributes: { link: { href: m[9] } } });
    else if (m[11]) runs.push({ insert: m[11], attributes: { italic: {} } });
    else if (m[13]) runs.push({ insert: m[13], attributes: { italic: {} } });
    else if (m[15]) {
      // [[Page title]] or [[Page title|shown text]]: a link to that page (which counts as a link in the graph).
      const href = pages?.get(m[15].trim().toLowerCase());
      const shown = (m[16] ?? m[15]).trim();
      runs.push(href ? { insert: shown, attributes: { link: { href } } } : { insert: `[[${m[15]}]]` });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ insert: text.slice(last) });
  return runs.filter((r) => r.insert);
}

/** Page titles (lower case) → the address of that page, for [[links]]. */
export type PageLinks = Map<string, string>;

/** The titles written as [[links]] in some Markdown. */
export function linkedTitles(markdown: string): string[] {
  // Code (fenced blocks and `inline code`) is shown as written, so [[…]] inside it isn't a link.
  const prose = markdown.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '');
  // Found with indexOf (no pattern over the whole text): each "[[" looks ahead a short way for "]]".
  const titles = new Set<string>();
  let at = 0;
  let close = -1; // the next "]]", found again only once passed (so one far-off "]]" isn't searched for again and again)
  while (titles.size < 2000) {
    const open = prose.indexOf('[[', at);
    if (open < 0) break;
    if (close < open + 2) close = prose.indexOf(']]', open + 2);
    if (close < 0) break;
    const inner = prose.slice(open + 2, close);
    if (close - open <= 602 && !inner.includes('\n') && !inner.includes('[')) {
      const title = inner.split('|')[0].trim();
      if (title) titles.add(title);
      at = close + 2;
    } else at = open + 2;
  }
  return [...titles];
}

function container(line: Line, pages?: PageLinks): Y.XmlElement {
  const c = new Y.XmlElement('blockContainer');
  c.setAttribute('id', randomUUID());
  const block = new Y.XmlElement(line.node);
  // A real boolean for to-dos: the editor reads any non-empty text (even "false") as ticked.
  for (const [k, v] of Object.entries(line.attrs)) block.setAttribute(k, v as string);
  if (line.node !== 'divider') {
    const text = new Y.XmlText();
    if (line.node === 'codeBlock') text.insert(0, line.text);
    else text.applyDelta(inline(line.text, pages));
    block.insert(0, [text]);
  }
  c.insert(0, [block]);
  return c;
}

function rootGroup(doc: Y.Doc): Y.XmlElement {
  const fragment = doc.getXmlFragment('document-store');
  let group = fragment.get(0);
  if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') {
    group = new Y.XmlElement('blockGroup');
    fragment.insert(fragment.length, [group]);
  }
  return group as Y.XmlElement;
}

/** Adds Markdown to the end of a document (`replace` clears it first). Returns how many blocks were added. */
export function writeMarkdown(doc: Y.Doc, markdown: string, replace: boolean, pages?: PageLinks): number {
  const root = rootGroup(doc);
  if (replace && root.length) root.delete(0, root.length);
  const lines = parseLines(markdown);
  // Each line goes under the closest earlier line with a smaller indent (lists nest).
  const stack: { indent: number; el: Y.XmlElement }[] = [];
  for (const line of lines) {
    const el = container(line, pages);
    while (stack.length && stack[stack.length - 1].indent >= line.indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && line.indent > 0) {
      let group = parent.el.get(1);
      if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') {
        group = new Y.XmlElement('blockGroup');
        parent.el.insert(1, [group]);
      }
      (group as Y.XmlElement).insert((group as Y.XmlElement).length, [el]);
    } else {
      root.insert(root.length, [el]);
    }
    stack.push({ indent: line.indent, el });
  }
  return lines.length;
}
