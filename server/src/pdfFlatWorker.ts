import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

// Makes the "without text" copy of a PDF (see pdfFlat.ts): every page drawn once as a picture and
// put in a new PDF. Viewers then only have to show pictures, with no fonts, text or vector drawings to
// work out, which is much lighter for big books full of text. MuPDF (WebAssembly) does the drawing.
// Only type annotations here (no local imports), so the file runs both compiled and as .ts.

export type FlatJob = { src: string; out: string; dpi: number; quality: number };
export type FlatResult = { done: 'flat'; pages: number } | { done: 'notext' } | { error: string };

/** Pages looked at for text: a PDF with none in its first pages is a scan, already pictures. */
const TEXT_PROBE_PAGES = 15;

async function run({ src, out, dpi, quality }: FlatJob): Promise<FlatResult> {
  const mupdf = await import('mupdf');
  mupdf.setLog(null);
  const doc = mupdf.Document.openDocument(readFileSync(src), 'application/pdf');
  try {
    if (doc.needsPassword()) return { error: 'The PDF has a password' };
    const pages = doc.countPages();
    let hasText = false;
    for (let i = 0; i < Math.min(pages, TEXT_PROBE_PAGES) && !hasText; i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText('');
      hasText = st.asText().trim().length > 20;
      st.destroy();
      page.destroy();
    }
    if (!hasText) return { done: 'notext' };

    const flat = new mupdf.PDFDocument();
    const scale = dpi / 72;
    for (let i = 0; i < pages; i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const w = Math.max(1, x1 - x0);
        const h = Math.max(1, y1 - y0);
        // Annotations (highlights, stamps, form fields) are drawn into the picture too.
        const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        const jpeg = pix.asJPEG(quality, false);
        pix.destroy();
        const image = flat.addImage(new mupdf.Image(jpeg));
        const resources = flat.addObject({ XObject: { P: image } });
        const contents = `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} 0 0 cm /P Do Q`;
        flat.insertPage(-1, flat.addPage([0, 0, w, h], 0, resources, contents));
      } finally {
        page.destroy();
      }
    }
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, flat.saveToBuffer('compress').asUint8Array());
    flat.destroy();
    try {
      renameSync(tmp, out);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw err;
    }
    return { done: 'flat', pages };
  } finally {
    doc.destroy();
  }
}

parentPort?.once('message', (job: FlatJob) => {
  run(job)
    .then((r) => parentPort?.postMessage(r))
    .catch((err) => parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) } satisfies FlatResult));
});
