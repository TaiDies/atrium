import * as Y from 'yjs';

// Plain-file copies of pages for use in other apps: documents as Markdown, databases as CSV.

export interface ReadableContext {
  /** Relative link from this page's Markdown file to another page's file (or null if not exported). */
  pageLink: (pageId: string) => { title: string; href: string | null };
  /** Relative link to an exported attachment (or null). */
  fileLink: (url: string) => string | null;
  eventLabel: (eventId: string) => string | null;
  boardLabel: (boardId: string) => string | null;
}

type Delta = { insert?: unknown; attributes?: Record<string, unknown> }[];

function escapeMd(s: string) {
  return s.replace(/([\\`*_[\]#<>|])/g, '\\$1');
}

function inlineText(el: Y.XmlElement, ctx: ReadableContext): string {
  let out = '';
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Delta) {
        if (typeof op.insert !== 'string') continue;
        let t = op.insert;
        const a = op.attributes ?? {};
        if (a.code) t = `\`${t}\``;
        else t = escapeMd(t);
        if (a.bold) t = `**${t}**`;
        if (a.italic) t = `*${t}*`;
        if (a.strike) t = `~~${t}~~`;
        const link = a.link as { href?: string } | undefined;
        if (link?.href) t = `[${t}](${link.href})`;
        out += t;
      }
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'pageMention') {
        const link = ctx.pageLink(String(child.getAttribute('pageId') ?? ''));
        out += link.href ? `[@${escapeMd(link.title)}](${link.href})` : `@${escapeMd(link.title)}`;
      } else if (child.nodeName === 'dateMention') {
        out += `📅 ${child.getAttribute('date') ?? ''}`;
      } else {
        out += inlineText(child, ctx);
      }
    }
  }
  return out;
}

function tableMarkdown(table: Y.XmlElement, ctx: ReadableContext): string {
  // tableContent > tableRow > tableCell|tableHeader > tableParagraph
  const rows: string[][] = [];
  const collectRows = (el: Y.XmlElement) => {
    for (const c of el.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      if (c.nodeName === 'tableRow') rows.push(c.toArray().filter((x): x is Y.XmlElement => x instanceof Y.XmlElement).map((cell) => inlineText(cell, ctx).replace(/\n/g, ' ')));
      else collectRows(c);
    }
  };
  collectRows(table);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

/** A page's blocks as Markdown. */
export function docToMarkdown(doc: Y.Doc, title: string, ctx: ReadableContext): string {
  const lines: string[] = [`# ${escapeMd(title || 'Untitled')}`, ''];
  const visit = (group: Y.XmlElement, depth: number) => {
    let number = 0;
    for (const container of group.toArray()) {
      if (!(container instanceof Y.XmlElement) || container.nodeName !== 'blockContainer') continue;
      const block = container.get(0);
      const nested = container.get(1);
      const indent = '  '.repeat(depth);
      if (block instanceof Y.XmlElement) {
        const type = block.nodeName;
        const attrs = block.getAttributes();
        const text = () => inlineText(block, ctx);
        number = type === 'numberedListItem' ? number + 1 : 0;
        switch (type) {
          case 'heading':
            lines.push(`${'#'.repeat(Math.min(6, Number(attrs.level ?? 1) + 1))} ${text()}`, '');
            break;
          case 'bulletListItem':
            lines.push(`${indent}- ${text()}`);
            break;
          case 'numberedListItem':
            lines.push(`${indent}${number}. ${text()}`);
            break;
          case 'checkListItem':
            lines.push(`${indent}- [${String(attrs.checked) === 'true' ? 'x' : ' '}] ${text()}`);
            break;
          case 'toggleListItem':
            lines.push(`${indent}- ${text()}`);
            break;
          case 'quote':
            lines.push(`${indent}> ${text()}`, '');
            break;
          case 'codeBlock': {
            const code = block
              .toArray()
              .map((c) => (c instanceof Y.XmlText ? c.toString() : ''))
              .join('');
            lines.push(`${indent}\`\`\`${attrs.language && attrs.language !== 'text' ? attrs.language : ''}`, ...code.split('\n').map((l) => indent + l), `${indent}\`\`\``, '');
            break;
          }
          case 'table':
            lines.push(tableMarkdown(block, ctx), '');
            break;
          case 'image':
          case 'video':
          case 'audio':
          case 'file': {
            const url = String(attrs.url ?? '');
            const href = ctx.fileLink(url) ?? url;
            const name = String(attrs.name || attrs.caption || type);
            lines.push(type === 'image' ? `${indent}![${escapeMd(name)}](${href})` : `${indent}[${escapeMd(name)}](${href})`, '');
            break;
          }
          case 'divider':
            lines.push('---', '');
            break;
          case 'subpage':
          case 'database': {
            const link = ctx.pageLink(String(attrs.pageId ?? ''));
            lines.push(link.href ? `${indent}📄 [${escapeMd(link.title)}](${link.href})` : `${indent}📄 ${escapeMd(link.title)}`, '');
            break;
          }
          case 'event': {
            const label = ctx.eventLabel(String(attrs.eventId ?? ''));
            if (label) lines.push(`${indent}📅 ${escapeMd(label)}`, '');
            break;
          }
          case 'whiteboard': {
            const label = ctx.boardLabel(String(attrs.boardId ?? ''));
            if (label) lines.push(`${indent}🖊 Whiteboard: ${escapeMd(label)}`, '');
            break;
          }
          default: {
            const t = text();
            lines.push(t ? `${indent}${t}` : '');
            if (depth === 0) lines.push('');
          }
        }
      }
      if (nested instanceof Y.XmlElement) visit(nested, depth + 1);
    }
  };
  const root = doc.getXmlFragment('document-store').get(0);
  if (root instanceof Y.XmlElement) visit(root, 0);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

interface Field {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string }[];
}

function csvCell(v: string) {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A database's cards as CSV, one column per property (select options by name, files by name). */
export function databaseToCsv(doc: Y.Doc): string {
  const fields = doc
    .getArray<Y.Map<unknown>>('fields')
    .toArray()
    .filter((f) => f instanceof Y.Map)
    .map((f) => f.toJSON() as Field);
  const rows = doc
    .getArray<Y.Map<unknown>>('rows')
    .toArray()
    .filter((r) => r instanceof Y.Map)
    .map((r) => {
      const cells = r.get('cells');
      return { cells: (cells instanceof Y.Map ? cells.toJSON() : {}) as Record<string, unknown>, createdAt: Number(r.get('createdAt') ?? 0), updatedAt: Number(r.get('updatedAt') ?? 0) };
    });
  const display = (f: Field, row: (typeof rows)[number]): string => {
    const v = row.cells[f.id];
    const name = (id: unknown) => f.options?.find((o) => o.id === id)?.name ?? '';
    switch (f.type) {
      case 'select':
        return name(v);
      case 'multi_select':
        return Array.isArray(v) ? v.map(name).filter(Boolean).join(', ') : '';
      case 'checkbox':
        return v === true ? 'Yes' : 'No';
      case 'checklist':
        return Array.isArray(v) ? v.map((i: { text?: string; done?: boolean }) => `[${i.done ? 'x' : ' '}] ${i.text ?? ''}`).join('; ') : '';
      case 'media':
        return Array.isArray(v) ? v.map((m: { name?: string }) => m.name ?? '').join(', ') : '';
      case 'created_time':
        return row.createdAt ? new Date(row.createdAt).toISOString() : '';
      case 'last_edited':
        return row.updatedAt ? new Date(row.updatedAt).toISOString() : '';
      default:
        return v === null || v === undefined ? '' : String(v);
    }
  };
  const lines = [fields.map((f) => csvCell(f.name)).join(',')];
  for (const row of rows) lines.push(fields.map((f) => csvCell(display(f, row))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
