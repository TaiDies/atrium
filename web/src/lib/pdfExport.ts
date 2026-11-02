import { toast, toastError } from '../components/ui';
import { convertBytes, downloadBlob } from '../office/shared';

// "Export as PDF" for a document page: the page as HTML (its pictures built in, since the converter
// can't sign in to fetch them), made into a PDF by the server's LibreOffice. Without it (a server set
// up without LibreOffice), the browser's print window opens instead, where "Save as PDF" does the same.

const STYLE = `
  body { font-family: "Liberation Sans", Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f2328; }
  h1 { font-size: 22pt; margin: 0 0 12pt; }
  h2 { font-size: 16pt; margin: 14pt 0 6pt; }
  h3 { font-size: 13pt; margin: 12pt 0 4pt; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 6pt 0; }
  td, th { border: 1px solid #c8ccd1; padding: 3pt 6pt; vertical-align: top; }
  blockquote { border-left: 3px solid #c8ccd1; margin: 6pt 0; padding-left: 10pt; color: #555; }
  pre, code { font-family: "Liberation Mono", Consolas, monospace; font-size: 9.5pt; background: #f4f5f7; }
  pre { padding: 6pt; white-space: pre-wrap; }
`;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function toDataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 15 * 1024 * 1024 || !blob.type.startsWith('image/')) return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function pageHtml(editor: any, title: string): Promise<string> {
  const body = await editor.blocksToHTMLLossy(editor.document);
  const doc = new DOMParser().parseFromString(`<div id="root">${body}</div>`, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:')) continue;
    const url = new URL(src, location.origin);
    const data = url.origin === location.origin ? await toDataUrl(url.toString()) : null;
    if (data) img.setAttribute('src', data);
    else if (url.origin === location.origin) img.remove();
  }
  // Tasks and events show on screen as cards with buttons: on paper, a plain line.
  for (const el of Array.from(doc.querySelectorAll('[data-event-id]'))) {
    const done = !!el.querySelector('[style*="background: rgb"] svg, .line-through');
    const p = doc.createElement('p');
    const parts = Array.from(el.querySelectorAll('span, div'))
      .filter((n) => !n.children.length)
      .map((n) => n.textContent?.trim() ?? '')
      .filter(Boolean);
    p.textContent = `${done ? '☑' : '☐'} ${[...new Set(parts)].join(' · ')}`;
    el.replaceWith(p);
  }
  for (const svg of Array.from(doc.querySelectorAll('svg'))) svg.remove();
  for (const button of Array.from(doc.querySelectorAll('button'))) button.replaceWith(doc.createTextNode(button.textContent ?? ''));
  // Videos and audio can't go on paper: their names are kept as links.
  for (const media of Array.from(doc.querySelectorAll('video, audio, iframe'))) {
    const p = doc.createElement('p');
    p.textContent = `[${media.tagName.toLowerCase()}]`;
    media.replaceWith(p);
  }
  const html = doc.getElementById('root')!.innerHTML;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${html}</body></html>`;
}

function printHtml(html: string) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  frame.contentDocument!.open();
  frame.contentDocument!.write(html);
  frame.contentDocument!.close();
  setTimeout(() => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 60_000);
  }, 400);
}

export async function exportPagePdf(editor: any, title: string, workspaceId: string) {
  const name = (title || 'Untitled').replace(/[\\/:*?"<>|]/g, '-');
  toast('Making the PDF…');
  let html: string;
  try {
    html = await pageHtml(editor, title || 'Untitled');
  } catch (err) {
    return toastError(err);
  }
  try {
    const pdf = await convertBytes(workspaceId, 'document', 'html', 'pdf', new Blob([html], { type: 'text/html' }), name);
    downloadBlob(pdf, `${name}.pdf`);
  } catch (err) {
    // No converter on this server: the browser can print it to a PDF.
    if (err instanceof Error && /LibreOffice/i.test(err.message)) {
      toast('Choose “Save as PDF” in the print window');
      printHtml(html);
    } else toastError(err);
  }
}
