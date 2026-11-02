/** Loads PDF.js (and its worker) on first use, so pages without PDFs never download it. */
let loader: Promise<typeof import('pdfjs-dist')> | null = null;

export function loadPdfjs() {
  loader ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return loader;
}

/**
 * Where PDF.js finds its image decoders, character maps, fonts and colour profiles (see vite.config.ts).
 * Pass to every getDocument call: scanned PDFs (JPEG 2000, JBIG2) draw blank without them.
 */
export function pdfAssets() {
  const base = new URL('/pdfjs/', location.href).href;
  return {
    wasmUrl: `${base}wasm/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    iccUrl: `${base}iccs/`,
    useSystemFonts: false,
  };
}
