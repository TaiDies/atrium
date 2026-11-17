import type { Op, Presence, Sheet } from '@fortune-sheet/core';
import { Workbook, type WorkbookInstance } from '@fortune-sheet/react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import * as Y from 'yjs';
import { uploadFile, type User } from '../../lib/api';
import type { CollabSession } from '../../lib/collab';
import { convertBytes, convertStored, type EditorHandle, extOf, fileBytes, type OfficeFile } from '../shared';
import { FORMULAS_VERSION, patchFormulaEngine } from './formulas';
import { blankSheet, delimitedToSheet, sheetsToXlsx, sheetToDelimited, xlsxToSheets } from './xlsx';
import { keptFeatures, mergeIntoStored, type Origins, sheetFingerprint, sheetParts } from './xlsxMerge';
import '@fortune-sheet/react/dist/index.css';

// A spreadsheet everyone edits at once. The workbook is a snapshot plus a log of the editor's own
// operations (`sheetOps`), shared through the file's Yjs document; each change is applied on every
// screen as it happens. The log is folded back into the snapshot now and then.

patchFormulaEngine();

const LOCAL = 'sheet-local';
const COMPACT_AFTER = 400;

const READS_AS_XLSX = ['xlsx', 'xlsm', 'xltx'];

/** Fills a new live spreadsheet from the stored file (whatever its format). */
export async function loadSpreadsheet(doc: Y.Doc, file: OfficeFile) {
  const ext = extOf(file.name);
  const upload = (blob: Blob, imgExt: string) => uploadFile(file.workspaceId, new File([blob], `image.${imgExt}`, { type: blob.type }));
  let sheets: Sheet[];
  let origins: Origins | null = null;
  let kept: string[] = [];
  if (file.size === 0) sheets = [blankSheet()];
  else if (READS_AS_XLSX.includes(ext)) {
    const bytes = await fileBytes(file);
    sheets = await xlsxToSheets(bytes, upload);
    // Where each sheet came from and how it looked, so saving can leave unchanged sheets as they were
    // and keep what the editor doesn't show (xlsxMerge.ts).
    try {
      const parts = sheetParts(bytes);
      origins = {};
      for (const s of sheets) {
        const part = parts.get(s.name);
        if (part) origins[String(s.id)] = { part, ...sheetFingerprint(s) };
      }
      kept = keptFeatures(bytes);
    } catch {
      origins = null;
    }
  }
  else if (ext === 'csv' || ext === 'tsv') sheets = [delimitedToSheet(new TextDecoder().decode(await fileBytes(file)), ext === 'tsv' ? '\t' : ',', file.name.replace(/\.[^.]+$/, '').slice(0, 31) || 'Sheet1')];
  else sheets = await xlsxToSheets(await convertStored(file, 'xlsx'), upload); // .xls, .ods, .numbers, …
  doc.transact(() => {
    doc.getMap('sheetSnapshot').set('sheets', JSON.stringify(sheets));
    // Results from the file (or just worked out) are current: nothing to work out again on opening.
    doc.getMap('sheetSnapshot').set('formulas', FORMULAS_VERSION);
    if (origins) doc.getMap('sheetSnapshot').set('origins', JSON.stringify(origins));
    if (kept.length) doc.getMap('office').set('kept', JSON.stringify(kept));
  });
}

export const SPREADSHEET_FORMATS = [
  { ext: 'xlsx', label: 'Spreadsheet (.xlsx)' },
  { ext: 'ods', label: 'OpenDocument spreadsheet (.ods)' },
  { ext: 'xls', label: 'Older spreadsheet format (.xls)' },
  { ext: 'csv', label: 'CSV, current sheet (.csv)' },
  { ext: 'tsv', label: 'Tab-separated, current sheet (.tsv)' },
  { ext: 'pdf', label: 'PDF (.pdf)' },
  { ext: 'html', label: 'Web page (.html)' },
];

interface Props {
  file: OfficeFile;
  session: CollabSession;
  user: User;
  readOnly: boolean;
}

export const SpreadsheetEditor = forwardRef<EditorHandle, Props>(function SpreadsheetEditor({ file, session, user, readOnly }, ref) {
  const workbook = useRef<WorkbookInstance>(null);
  const applying = useRef(false);
  const ops = useMemo(() => session.doc.getArray<{ ops: Op[] }>('sheetOps'), [session]);
  const snapshot = useMemo(() => session.doc.getMap<string>('sheetSnapshot'), [session]);
  const initial = useMemo(() => {
    let sheets: Sheet[] = [];
    try {
      sheets = JSON.parse(snapshot.get('sheets') ?? '[]') as Sheet[];
    } catch {
      // A damaged snapshot opens as a blank sheet.
    }
    if (!sheets.length) sheets = [blankSheet()];
    // Start on the first cell. Without a saved selection the editor picks a half-made one (row [0] with no
    // end), and the cell-name box shows "A1:NaN".
    return sheets.map((s) => (s.luckysheet_select_save?.length ? s : { ...s, luckysheet_select_save: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }] }));
    // Read once: later changes arrive as operations.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchImage = async (src: string) => {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? 'image/png';
    return { buffer: await res.arrayBuffer(), ext: type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png' };
  };

  const allSheets = () => workbook.current?.getAllSheets() ?? initial;
  // The sheet on screen. (The sheets' own "active" flag isn't kept up to date when you switch tabs.)
  const currentSheet = () => {
    const all = allSheets();
    let shown: Sheet | undefined;
    try {
      shown = workbook.current?.getSheet();
    } catch {
      // Not mounted yet.
    }
    return (shown && all.find((s) => s.id === shown.id)) ?? all.find((s) => s.status === 1) ?? all[0];
  };
  const toXlsx = () => sheetsToXlsx(allSheets(), fetchImage);
  const ext = extOf(file.name);
  const MIME: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  };
  /**
   * The editor's workbook merged into the stored .xlsx/.xlsm/.xltx, keeping everything the editor doesn't
   * show (charts, pivot tables, macros…). Null when that isn't possible (then the file is rebuilt as before).
   */
  const toMerged = async (): Promise<Blob | null> => {
    if (!READS_AS_XLSX.includes(ext)) return null;
    try {
      const [stored, generated] = await Promise.all([fileBytes(file), toXlsx().then((b) => b.arrayBuffer())]);
      let origins: Origins = {};
      try {
        origins = JSON.parse(snapshot.get('origins') ?? '{}') as Origins;
      } catch {
        // No record: sheets are matched by name.
      }
      return new Blob([mergeIntoStored(stored, generated, allSheets(), origins) as BlobPart], { type: MIME[ext] });
    } catch (err) {
      console.warn('Could not merge into the stored workbook; saving a new one', err);
      return null;
    }
  };

  useImperativeHandle(ref, () => ({
    formats: SPREADSHEET_FORMATS,
    exportAs: async (to) => {
      if (to === 'csv' || to === 'tsv') return new Blob([sheetToDelimited(currentSheet(), to === 'tsv' ? '\t' : ',')], { type: to === 'csv' ? 'text/csv' : 'text/tab-separated-values' });
      // A macro workbook can't be handed out as plain .xlsx, but other formats can be made from it.
      const merged = to !== 'xlsx' || ext === 'xlsx' ? await toMerged() : null;
      if (to === 'xlsx') return merged ?? toXlsx();
      return convertBytes(file.workspaceId, 'spreadsheet', 'xlsx', to, merged ?? (await toXlsx()), file.name);
    },
    exportOriginal: async () => {
      const base = file.name.replace(/\.[^.]+$/, '');
      if (ext === 'csv' || ext === 'tsv') return { blob: new Blob([sheetToDelimited(currentSheet(), ext === 'tsv' ? '\t' : ',')]), name: file.name };
      if (ext === 'ods' || ext === 'xls') return { blob: await convertBytes(file.workspaceId, 'spreadsheet', 'xlsx', ext, await toXlsx(), file.name), name: file.name };
      // .xlsx, .xlsm and .xltx keep their own format and everything in them; anything else becomes .xlsx.
      const merged = await toMerged();
      if (merged) return { blob: merged, name: file.name };
      return { blob: await toXlsx(), name: ext === 'xlsx' ? file.name : `${base}.xlsx` };
    },
  }));

  // Catch up on changes made since the snapshot, then follow everyone's changes live.
  useEffect(() => {
    const pending = ops.toArray().flatMap((b) => b.ops ?? []);
    // Wait for the workbook to mount.
    requestAnimationFrame(() => {
      if (pending.length) {
        applying.current = true;
        try {
          workbook.current?.applyOp(pending);
        } finally {
          applying.current = false;
        }
      }
      // Results saved before a fix to the formula engine (formulas.ts) can be wrong (#NAME? for
      // VLOOKUP(…, FALSE), dates as long text…): the first person to open the sheet works every formula
      // out again, and everyone gets the new results as ordinary changes.
      if (!readOnly && snapshot.get('formulas') !== FORMULAS_VERSION && workbook.current) {
        session.doc.transact(() => snapshot.set('formulas', FORMULAS_VERSION), LOCAL);
        workbook.current.calculateFormula();
      }
    });
    const onRemote = (event: Y.YArrayEvent<{ ops: Op[] }>, tx: Y.Transaction) => {
      if (tx.origin === LOCAL) return;
      const added = event.changes.added;
      const incoming: Op[] = [];
      for (const item of added) for (const content of item.content.getContent() as { ops: Op[] }[]) incoming.push(...(content.ops ?? []));
      if (!incoming.length) return;
      applying.current = true;
      try {
        workbook.current?.applyOp(incoming);
      } finally {
        applying.current = false;
      }
    };
    ops.observe(onRemote);
    return () => ops.unobserve(onRemote);
  }, [ops]);

  // Who else is here, and which cell each of them has selected.
  useEffect(() => {
    const awareness = session.provider.awareness;
    if (!awareness) return;
    awareness.setLocalStateField('user', { name: user.name, color: user.color, id: user.id });
    let shown: Presence[] = [];
    const update = () => {
      const next: Presence[] = [];
      awareness.getStates().forEach((s, clientId) => {
        const st = s as { user?: { name: string; color: string }; cell?: { sheetId: string; r: number; c: number } };
        if (clientId === awareness.clientID || !st.user || !st.cell) return;
        next.push({ sheetId: st.cell.sheetId, username: st.user.name, userId: String(clientId), color: st.user.color, selection: { r: st.cell.r, c: st.cell.c } });
      });
      const gone = shown.filter((p) => !next.some((n) => n.userId === p.userId));
      if (gone.length) workbook.current?.removePresences(gone.map((p) => ({ username: p.username, userId: p.userId })));
      if (next.length) workbook.current?.addPresences(next);
      shown = next;
    };
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [session, user]);

  const onOp = (batch: Op[]) => {
    if (applying.current || readOnly || !batch.length) return;
    session.doc.transact(() => ops.push([{ ops: JSON.parse(JSON.stringify(batch)) }]), LOCAL);
    // One person (the lowest id among those here) folds the log into the snapshot once it's long.
    if (ops.length > COMPACT_AFTER) {
      const awareness = session.provider.awareness;
      const ids = awareness ? [...awareness.getStates().keys()] : [session.doc.clientID];
      if (Math.min(...ids) === (awareness?.clientID ?? session.doc.clientID)) {
        session.doc.transact(() => {
          snapshot.set('sheets', JSON.stringify(allSheets()));
          ops.delete(0, ops.length);
        }, LOCAL);
      }
    }
  };

  return (
    <div className="sheet-host size-full">
      <Workbook
        ref={workbook}
        data={initial}
        onOp={onOp}
        allowEdit={!readOnly}
        showToolbar={!readOnly}
        showFormulaBar
        showSheetTabs
        currency="$"
        hooks={{
          afterSelectionChange: (sheetId, selection) => {
            session.provider.awareness?.setLocalStateField('cell', { sheetId, r: selection.row_focus ?? selection.row[0], c: selection.column_focus ?? selection.column[0] });
          },
        }}
      />
    </div>
  );
});
