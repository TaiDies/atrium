import { parentPort } from 'node:worker_threads';

// Reads the text of a PDF away from the main thread (see fileText.ts), so a big file doesn't stall live
// editing, chat and page loads. MuPDF (WebAssembly) does the reading; pdf.js is the fallback for files
// MuPDF can't open or finds no text in. Only type annotations here (no local imports), so the file runs
// both compiled (dist/) and as .ts in development.

export type PdfJob = { id: number; data: Uint8Array; max: number };
export type PdfResult = { id: number; text: string; fallback?: string } | { id: number; error: string };

let mupdfModule: Promise<typeof import('mupdf')> | undefined;

async function viaMupdf(data: Uint8Array, max: number): Promise<string> {
  mupdfModule ??= import('mupdf').then((m) => {
    // Repair notes for damaged files ("warning: trying to repair broken xref") would only fill the log;
    // a file it can't read still throws.
    m.setLog(null);
    return m;
  });
  const mupdf = await mupdfModule;
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  try {
    if (doc.needsPassword()) return '';
    const parts: string[] = [];
    let size = 0;
    const pages = doc.countPages();
    for (let i = 0; i < pages && size < max; i++) {
      const page = doc.loadPage(i);
      try {
        const st = page.toStructuredText('preserve-whitespace');
        const text = st.asText();
        st.destroy();
        parts.push(text);
        size += text.length;
      } finally {
        page.destroy();
      }
    }
    return parts.join('\n');
  } finally {
    doc.destroy();
  }
}

async function viaPdfjs(data: Uint8Array, max: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const parts: string[] = [];
    let size = 0;
    for (let i = 1; i <= doc.numPages && size < max; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
      parts.push(text);
      size += text.length;
      page.cleanup();
    }
    return parts.join('\n');
  } finally {
    await task.destroy();
  }
}

parentPort?.on('message', async ({ id, data, max }: PdfJob) => {
  let reply: PdfResult;
  let fallback: string | undefined;
  try {
    const text = await viaMupdf(data, max);
    if (text.trim()) {
      parentPort!.postMessage({ id, text } satisfies PdfResult);
      return;
    }
  } catch (err) {
    fallback = err instanceof Error ? err.message : String(err);
  }
  try {
    // MuPDF copies the file into its own memory, so `data` is still whole here.
    reply = { id, text: await viaPdfjs(data, max), ...(fallback ? { fallback } : {}) };
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(reply);
});
