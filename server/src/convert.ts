import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpError } from './util.js';

// Converting office files between formats with LibreOffice (installed in the Docker image): Word,
// Excel and PowerPoint formats, OpenDocument, RTF, CSV, HTML and PDF. Used to open any document,
// spreadsheet or presentation in the editors, to save back in its original format, and to show an
// exact "original layout" view (as PDF).

const SOFFICE = process.env.SOFFICE_PATH ?? 'soffice';
const MAX_PARALLEL = Math.max(1, Number(process.env.CONVERT_PARALLEL ?? 2));
const TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS ?? 180_000);

export const DOCUMENT_EXT = ['docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'markdown', 'html', 'htm', 'dotx', 'dot', 'ott', 'wpd', 'docm', 'fodt', 'xml'];
export const SPREADSHEET_EXT = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv', 'xltx', 'xlt', 'ots', 'fods', 'numbers'];
export const PRESENTATION_EXT = ['pptx', 'ppt', 'odp', 'ppsx', 'pps', 'potx', 'pot', 'otp', 'pptm', 'fodp', 'key'];

/** LibreOffice export filters for each target format (by what kind of file is being converted). */
const FILTERS: Record<string, Record<string, string>> = {
  document: {
    docx: 'docx:"MS Word 2007 XML"',
    doc: 'doc:"MS Word 97"',
    odt: 'odt:writer8',
    rtf: 'rtf:"Rich Text Format"',
    pdf: 'pdf:writer_pdf_Export',
    html: 'html:"HTML (StarWriter)":EmbedImages',
    txt: 'txt:Text',
  },
  spreadsheet: {
    xlsx: 'xlsx:"Calc MS Excel 2007 XML"',
    xls: 'xls:"MS Excel 97"',
    ods: 'ods:calc8',
    csv: 'csv:"Text - txt - csv (StarCalc)":44,34,76,1',
    pdf: 'pdf:calc_pdf_Export',
    html: 'html:"HTML (StarCalc)"',
  },
  presentation: {
    pptx: 'pptx:"Impress MS PowerPoint 2007 XML"',
    ppt: 'ppt:"MS PowerPoint 97"',
    odp: 'odp:impress8',
    pdf: 'pdf:impress_pdf_Export',
  },
};

export type OfficeKind = 'document' | 'spreadsheet' | 'presentation';

export function kindOfName(name: string, mime = ''): OfficeKind | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (DOCUMENT_EXT.includes(ext) && !['txt', 'md', 'markdown', 'html', 'htm', 'xml'].includes(ext)) return 'document';
  if (SPREADSHEET_EXT.includes(ext)) return 'spreadsheet';
  if (PRESENTATION_EXT.includes(ext)) return 'presentation';
  if (/wordprocessingml|msword|opendocument\.text|rtf/.test(mime)) return 'document';
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(mime)) return 'spreadsheet';
  if (/presentationml|ms-powerpoint|opendocument\.presentation/.test(mime)) return 'presentation';
  return null;
}

export const canConvertTo = (kind: OfficeKind, format: string) => format in FILTERS[kind];

let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

let available: boolean | null = null;

/** Whether LibreOffice is installed (it is in the Docker image). */
export async function converterAvailable(): Promise<boolean> {
  if (available !== null) return available;
  available = await new Promise<boolean>((resolve) => {
    const p = spawn(SOFFICE, ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return available;
}

/**
 * Converts `input` (a file named `name`) to `format`. `kind` picks the LibreOffice filter; for HTML
 * input, `kind` also decides whether it opens as a text document. Returns the converted bytes.
 */
export async function convert(input: Buffer, name: string, kind: OfficeKind, format: string): Promise<Buffer> {
  if (!(await converterAvailable())) throw new HttpError(501, 'Converting files needs LibreOffice, which is included in the Docker image');
  const filter = FILTERS[kind][format];
  if (!filter) throw new HttpError(400, `Can't convert to .${format}`);
  return slot(async () => {
    const dir = path.join(tmpdir(), `convert-${randomUUID()}`);
    const profile = path.join(dir, 'profile');
    const out = path.join(dir, 'out');
    await mkdir(out, { recursive: true });
    const ext = path.extname(name).slice(1).toLowerCase() || 'bin';
    // Keep the file's own name (LibreOffice uses it, e.g. for a CSV's sheet), minus anything unsafe.
    const base = path.basename(name, path.extname(name)).replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 80) || 'input';
    const source = path.join(dir, `${base}.${ext}`);
    await writeFile(source, input);
    const args = [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--norestore',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      // HTML (from the document editor) opens as a text document, not a web page.
      ...((ext === 'html' || ext === 'htm') && kind === 'document' ? ['--infilter=HTML (StarWriter)'] : []),
      ...(ext === 'csv' || ext === 'tsv' ? [`--infilter=CSV:${ext === 'tsv' ? '9' : '44'},34,76,1`] : []),
      '--convert-to',
      filter.replace(/"/g, ''),
      '--outdir',
      out,
      source,
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(SOFFICE, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: dir } });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        const timer = setTimeout(() => {
          p.kill('SIGKILL');
          reject(new HttpError(504, 'Converting the file took too long'));
        }, TIMEOUT_MS);
        p.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        p.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new HttpError(422, `This file couldn't be converted${err ? ` (${err.trim().split('\n').pop()})` : ''}`));
        });
      });
      const produced = (await readdir(out)).filter((f) => !f.startsWith('.'));
      if (!produced.length) throw new HttpError(422, "This file couldn't be converted");
      return await readFile(path.join(out, produced[0]));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
