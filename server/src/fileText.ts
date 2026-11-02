import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { convert, converterAvailable, kindOfName } from './convert.js';
import { one, query } from './db.js';

// The words inside uploaded files (PDFs, Word, Excel, PowerPoint, text…), kept for search. Scanned
// PDFs have no text layer, so only their names are searchable.

const MAX_TEXT = 300_000;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log)$/i;

async function pdfText(data: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const parts: string[] = [];
  let size = 0;
  for (let i = 1; i <= doc.numPages && size < MAX_TEXT; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
    parts.push(text);
    size += text.length;
    page.cleanup();
  }
  await task.destroy();
  return parts.join('\n');
}

/** Reads a file's text and stores it (an empty string means "looked, nothing found"). */
export async function indexFileText(fileId: string) {
  const file = await one<{ filename: string; mime_type: string; size: string }>('select filename, mime_type, size from files where id = $1', [fileId]);
  if (!file || Number(file.size) === 0 || Number(file.size) > 60 * 1024 * 1024) return;
  let text = '';
  try {
    const data = await readFile(path.join(config.uploadDir, fileId));
    if (file.mime_type === 'application/pdf' || /\.pdf$/i.test(file.filename)) text = await pdfText(data);
    else if (file.mime_type.startsWith('text/') || TEXT_EXT.test(file.filename)) text = data.toString('utf8');
    else {
      const kind = kindOfName(file.filename, file.mime_type);
      if (kind && (await converterAvailable())) text = await pdfText(await convert(data, file.filename, kind, 'pdf'));
    }
  } catch {
    text = '';
  }
  await query('update files set text_content = $2 where id = $1', [fileId, text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)]);
}

let queue: Promise<void> = Promise.resolve();

/** Indexes a file in the background, one at a time (conversions are heavy). */
export function queueFileText(fileId: string) {
  queue = queue.then(() => indexFileText(fileId)).catch((err) => console.error('Could not read the text of a file', fileId, err));
}

/** Files uploaded before text search existed. */
export async function backfillFileText() {
  const files = await query<{ id: string }>('select id from files where text_content is null order by created_at desc limit 2000');
  for (const f of files) queueFileText(f.id);
}
