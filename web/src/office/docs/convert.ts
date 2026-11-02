import DOMPurify from 'dompurify';
import { uploadFile } from '../../lib/api';
import { convertStored, extOf, fileBytes, type OfficeFile } from '../shared';

// Getting documents into and out of the editor. Word, OpenDocument and RTF files are turned into
// HTML by the server (LibreOffice); Markdown, text and HTML files are read here. On the way out the
// editor's HTML (with the page size and margins) goes back through LibreOffice to the chosen format.

export interface PageSetup {
  size: 'a4' | 'letter' | 'legal' | 'a5';
  orientation: 'portrait' | 'landscape';
  /** Margins in millimetres. */
  margins: { top: number; right: number; bottom: number; left: number };
}

export const PAGE_SIZES: Record<PageSetup['size'], { label: string; w: number; h: number }> = {
  a4: { label: 'A4', w: 210, h: 297 },
  letter: { label: 'Letter', w: 215.9, h: 279.4 },
  legal: { label: 'Legal', w: 215.9, h: 355.6 },
  a5: { label: 'A5', w: 148, h: 210 },
};

export const MARGIN_PRESETS: { id: string; label: string; mm: number }[] = [
  { id: 'normal', label: 'Normal (2.54 cm)', mm: 25.4 },
  { id: 'narrow', label: 'Narrow (1.27 cm)', mm: 12.7 },
  { id: 'moderate', label: 'Moderate (1.91 cm)', mm: 19.1 },
  { id: 'wide', label: 'Wide (5.08 cm)', mm: 50.8 },
];

export const DEFAULT_SETUP: PageSetup = { size: 'a4', orientation: 'portrait', margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 } };

export function pageSize(setup: PageSetup) {
  const s = PAGE_SIZES[setup.size];
  return setup.orientation === 'portrait' ? { w: s.w, h: s.h } : { w: s.h, h: s.w };
}

const SIZE_PT: Record<string, string> = { '1': '8pt', '2': '10pt', '3': '12pt', '4': '14pt', '5': '18pt', '6': '24pt', '7': '36pt' };

/** Turns LibreOffice/Word HTML into what the editor understands: inline styles instead of <font>. */
function normalise(html: string): { body: string; setup: PageSetup | null } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Page size and margins from @page, when the file had them.
  let setup: PageSetup | null = null;
  const page = /@page\s*\{([^}]*)\}/i.exec([...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n'));
  if (page) {
    const toMm = (v: string) => {
      const m = /([\d.]+)\s*(in|cm|mm|pt|px)?/.exec(v);
      if (!m) return null;
      const n = parseFloat(m[1]);
      return m[2] === 'in' ? n * 25.4 : m[2] === 'cm' ? n * 10 : m[2] === 'pt' ? n * 0.3528 : m[2] === 'px' ? n * 0.2646 : n;
    };
    const get = (k: string) => new RegExp(`${k}\\s*:\\s*([^;]+)`, 'i').exec(page[1])?.[1];
    const size = get('size')?.trim().split(/\s+/);
    const w = size && toMm(size[0]);
    const h = size && size[1] ? toMm(size[1]) : null;
    const near = (a: number, b: number) => Math.abs(a - b) < 3;
    let found: PageSetup['size'] = 'a4';
    let orientation: PageSetup['orientation'] = 'portrait';
    if (w && h) {
      for (const [id, s] of Object.entries(PAGE_SIZES) as [PageSetup['size'], { w: number; h: number }][]) {
        if (near(w, s.w) && near(h, s.h)) found = id;
        if (near(w, s.h) && near(h, s.w)) {
          found = id;
          orientation = 'landscape';
        }
      }
    }
    const margin = (side: string) => toMm(get(`margin-${side}`) ?? '') ?? 25.4;
    setup = { size: found, orientation, margins: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') } };
  }
  for (const font of [...doc.querySelectorAll('font')]) {
    const span = doc.createElement('span');
    const styles: string[] = [];
    if (font.getAttribute('face')) styles.push(`font-family: ${font.getAttribute('face')}`);
    if (font.getAttribute('size') && SIZE_PT[font.getAttribute('size')!]) styles.push(`font-size: ${SIZE_PT[font.getAttribute('size')!]}`);
    if (font.getAttribute('color')) styles.push(`color: ${font.getAttribute('color')}`);
    if (font.getAttribute('style')) styles.push(font.getAttribute('style')!);
    span.setAttribute('style', styles.join('; '));
    span.append(...font.childNodes);
    font.replaceWith(span);
  }
  // LibreOffice writes tiny fixed column widths; let tables fill the page instead (they can be resized).
  for (const el of [...doc.querySelectorAll('table, col, td, th')]) {
    el.removeAttribute('width');
    (el as HTMLElement).style?.removeProperty('width');
  }
  for (const el of [...doc.querySelectorAll('colgroup')]) el.remove();
  // Paragraph alignment written as align="…".
  for (const el of [...doc.querySelectorAll('[align]')]) {
    const align = el.getAttribute('align');
    if (align && ['left', 'center', 'right', 'justify'].includes(align)) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; text-align: ${align}`);
  }
  // Page breaks LibreOffice writes as a style on the following paragraph.
  for (const el of [...doc.querySelectorAll('[style*="page-break-before"]')]) {
    if (!/always/i.test(el.getAttribute('style') ?? '')) continue;
    const br = doc.createElement('p');
    br.setAttribute('data-page-break', '');
    el.before(br);
  }
  return { body: doc.body.innerHTML, setup };
}

/** Moves images embedded as data: URLs into the workspace's files, so the live document stays small. */
async function uploadEmbeddedImages(html: string, workspaceId: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of [...doc.querySelectorAll('img[src^="data:"]')]) {
    const src = img.getAttribute('src')!;
    try {
      const blob = await (await fetch(src)).blob();
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      img.setAttribute('src', await uploadFile(workspaceId, new File([blob], `image.${ext}`, { type: blob.type })));
    } catch {
      img.remove();
    }
  }
  return doc.body.innerHTML;
}

const clean = (html: string) =>
  DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-page-break', 'data-comment-id', 'data-type', 'data-checked', 'colspan', 'rowspan', 'colwidth', 'style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link', 'title'],
  });

function textToHtml(text: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => `<p>${esc(l) || '<br>'}</p>`)
    .join('');
}

/** The stored file as editor HTML (and its page setup, if the file had one). */
export async function documentToHtml(file: OfficeFile): Promise<{ html: string; setup: PageSetup | null }> {
  if (file.size === 0) return { html: '<p></p>', setup: null };
  const ext = extOf(file.name);
  const decode = async () => new TextDecoder().decode(await fileBytes(file));
  let html: string;
  let setup: PageSetup | null = null;
  if (ext === 'txt') html = textToHtml(await decode());
  else if (ext === 'md' || ext === 'markdown') {
    const { marked } = await import('marked');
    html = await marked.parse(await decode(), { gfm: true });
  } else if (ext === 'html' || ext === 'htm') ({ body: html, setup } = normalise(await decode()));
  else ({ body: html, setup } = normalise(new TextDecoder().decode(await convertStored(file, 'html'))));
  return { html: clean(await uploadEmbeddedImages(html, file.workspaceId)), setup };
}

/** A complete HTML page for LibreOffice to turn into .docx/.odt/.pdf…, with the page size and margins. */
export function exportHtml(bodyHtml: string, setup: PageSetup, title: string) {
  const { w, h } = pageSize(setup);
  const m = setup.margins;
  // Images must already be inlined (see inlineImages): LibreOffice can't fetch the app's file URLs.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>
@page { size: ${w}mm ${h}mm; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; }
body { font-family: Calibri, Carlito, 'Liberation Sans', Arial, sans-serif; font-size: 11pt; line-height: 1.15; }
table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
th { background: #f2f2f2; font-weight: bold; }
img { max-width: 100%; }
mark { background-color: #fff59d; }
ul[data-type="taskList"] { list-style: none; padding-left: 0; }
.doc-toc a { display: block; }
</style></head><body>${bodyHtml}</body></html>`;
}

/** Images referenced by URL turned into data: URLs, so the exported file carries them. */
export async function inlineImages(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of [...doc.querySelectorAll('img[src]')]) {
    const src = img.getAttribute('src')!;
    if (src.startsWith('data:')) continue;
    try {
      const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
      img.setAttribute(
        'src',
        await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.readAsDataURL(blob);
        }),
      );
    } catch {
      // Leave it as a link.
    }
  }
  return doc.documentElement.outerHTML;
}

export async function htmlToMarkdown(html: string) {
  const { default: TurndownService } = await import('turndown');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.addRule('taskItem', {
    filter: (node) => node.nodeName === 'LI' && (node as HTMLElement).getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => `- [${(node as HTMLElement).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.trim()}\n`,
  });
  td.addRule('pageBreak', { filter: (node) => (node as HTMLElement).hasAttribute?.('data-page-break'), replacement: () => '\n\n---\n\n' });
  return td.turndown(html);
}
