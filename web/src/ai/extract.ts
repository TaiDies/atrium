import { loadPdfjs, pdfAssets } from '../notes/pdf';
import { convertBytes } from '../office/shared';

// Reading attachments as text for the assistant: PDFs with PDF.js, office files through the server's
// converter (presentations via PDF), and anything text-like as it is.

const TEXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|tex|rtf|log)$/i;
const DOCUMENT = /\.(docx?|odt|rtf|dotx?|ott|wpd|docm|pages)$/i;
const SPREADSHEET = /\.(xlsx?|xlsm|xlsb|ods|numbers)$/i;
const PRESENTATION = /\.(pptx?|odp|ppsx?|potx?|pptm|key)$/i;

export const ACCEPTED = '.pdf,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.docx,.doc,.odt,.rtf,.xlsx,.xls,.ods,.pptx,.ppt,.odp';

const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

async function pdfText(data: ArrayBuffer, onProgress?: (page: number, pages: number) => void): Promise<string> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data), ...pdfAssets() });
  const doc = await task.promise;
  const out: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      out.push(`[Page ${i}]\n${text.replace(/[ \t]+\n/g, '\n').trim()}`);
      onProgress?.(i, doc.numPages);
    }
  } finally {
    await task.destroy();
  }
  return out.join('\n\n');
}

/** The text of a file, for the assistant to read. */
export async function extractText(workspaceId: string, file: Blob, name: string, onProgress?: (msg: string) => void): Promise<string> {
  const ext = extOf(name);
  if (ext === 'pdf' || file.type === 'application/pdf') {
    const text = await pdfText(await file.arrayBuffer(), (p, n) => onProgress?.(`Reading page ${p} of ${n}`));
    if (!text.replace(/\[Page \d+\]/g, '').trim()) throw new Error(`“${name}” has no text to read (it may be scanned images)`);
    return text;
  }
  if (TEXT.test(name) || file.type.startsWith('text/')) return file.text();
  if (DOCUMENT.test(name)) return (await convertBytes(workspaceId, 'document', ext, 'txt', file, name)).text();
  if (SPREADSHEET.test(name)) return (await convertBytes(workspaceId, 'spreadsheet', ext, 'csv', file, name)).text();
  if (PRESENTATION.test(name)) {
    onProgress?.('Converting the slides');
    const pdf = await convertBytes(workspaceId, 'presentation', ext, 'pdf', file, name);
    return pdfText(await pdf.arrayBuffer());
  }
  throw new Error(`The assistant can't read “${name}” — use PDF, Word, Excel, PowerPoint or text files`);
}
