import clsx from 'clsx';
import { Check, CloudOff, Download, Loader2, Save } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Anchor, Menu, MenuDivider, MenuItem, toast, toastError } from '../components/ui';
import { downloadUrl } from '../lib/api';
import { useCollab } from '../lib/collab';
import { queryClient, useMe } from '../lib/queries';
import { refreshFiles } from '../notes/api';
import { DocEditor, loadDocument } from './docs/DocEditor';
import { downloadBlob, type EditorHandle, type OfficeFile, type OfficeKind, saveContent, useAutosave, useLoadedDoc } from './shared';
import { SlidesEditor, loadPresentation } from './slides/SlidesEditor';
import { loadSpreadsheet, SpreadsheetEditor } from './sheets/SpreadsheetEditor';
import './office.css';

const LOADERS = { document: loadDocument, spreadsheet: loadSpreadsheet, presentation: loadPresentation };

/** Puts the editor's actions in the viewer's header. */
function HeaderPortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById('viewer-actions')), []);
  return host ? createPortal(children, host) : null;
}

/**
 * A document, spreadsheet or presentation: edited live with everyone else ("Edit"), or shown exactly as
 * it looks in its own app ("Original layout", rendered by LibreOffice as a PDF). Edits save back into
 * the file in its own format.
 */
export default function OfficeView({ file, kind, renderOriginal }: { file: OfficeFile; kind: OfficeKind; renderOriginal: () => ReactNode }) {
  const me = useMe();
  const { session, synced, denied } = useCollab(`file:${file.id}`, me.data!, () => {});
  const { state, error } = useLoadedDoc(session, synced, file.id, (doc) => LOADERS[kind](doc, file));
  const editor = useRef<EditorHandle>(null);
  const [mode, setMode] = useState<'edit' | 'original'>('edit');
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState(false);
  // Saving starts only once this person actually edits, so just opening a file never rewrites it.
  const [armed, setArmed] = useState(false);

  const save = useCallback(async () => {
    if (!editor.current) return;
    const { blob, name } = await editor.current.exportOriginal();
    await saveContent(file.id, blob, name !== file.name ? name : undefined);
    queryClient.invalidateQueries({ queryKey: ['file-info', file.id] });
    refreshFiles(file.workspaceId);
  }, [file.id, file.name, file.workspaceId]);
  const autosave = useAutosave(session, state === 'ready', armed, save);

  const download = async (ext: string) => {
    if (!editor.current) return;
    setBusy(true);
    try {
      downloadBlob(await editor.current.exportAs(ext), `${file.name.replace(/\.[^.]+$/, '')}.${ext}`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  if (denied) return <div className="p-10 text-center text-sm text-muted">You don't have access to this file.</div>;

  const user = me.data!;
  const props = { file, session: session!, user, readOnly: false };
  const status = autosave.status;

  return (
    <div className="flex h-full flex-col">
      <HeaderPortal>
        <div className="flex shrink-0 rounded-lg border border-line p-0.5 text-sm max-sm:hidden">
          {(['edit', 'original'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={m === 'original' && (file.size === 0 || /\.(txt|md|markdown)$/i.test(file.name))}
              className={clsx('h-7 rounded-md px-2.5 disabled:opacity-40', mode === m ? 'bg-active font-medium' : 'text-muted hover:text-fg')}
              title={m === 'original' ? 'Exactly as it looks in the desktop office apps' : 'Edit together with everyone'}
            >
              {m === 'edit' ? 'Edit' : 'Original layout'}
            </button>
          ))}
        </div>
        {mode === 'edit' && state === 'ready' && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted max-sm:hidden" title="Changes are saved into the file automatically">
            {status === 'saving' ? <Loader2 size={13} className="animate-spin" /> : status === 'error' ? <CloudOff size={13} className="text-danger" /> : status === 'saved' ? <Check size={13} /> : <Save size={13} />}
            {{ saving: 'Saving…', saved: armed ? 'Saved' : 'Up to date', unsaved: 'Unsaved changes', error: 'Not saved' }[status]}
          </span>
        )}
        <button
          onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
          disabled={busy}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white hover:brightness-110 disabled:opacity-60"
        >
          <Download size={15} /> <span className="max-sm:hidden">{busy ? 'Preparing…' : 'Download'}</span>
        </button>
        <Menu anchor={menu} onClose={() => setMenu(null)} align="end">
          {state === 'ready' &&
            (editor.current?.formats ?? []).map((f) => <MenuItem key={f.ext} icon={<Download size={15} />} label={f.label} onClick={() => download(f.ext)} />)}
          {state === 'ready' && <MenuDivider />}
          {file.size > 0 && <MenuItem icon={<Download size={15} />} label="Original file, as stored" onClick={() => (location.href = downloadUrl(file.url))} />}
          {state === 'ready' && (
            <MenuItem
              icon={<Save size={15} />}
              label="Save into the file now"
              onClick={async () => {
                setArmed(true);
                try {
                  await autosave.saveNow();
                  toast('Saved');
                } catch (err) {
                  toastError(err);
                }
              }}
            />
          )}
        </Menu>
      </HeaderPortal>

      {mode === 'original' ? (
        <div className="min-h-0 flex-1">{renderOriginal()}</div>
      ) : state === 'ready' && session ? (
        <div className={kind === 'document' ? 'min-h-0 flex-1' : 'af-ltr min-h-0 flex-1'} onKeyDownCapture={() => setArmed(true)} onPointerDownCapture={() => setArmed(true)} onPasteCapture={() => setArmed(true)} onDropCapture={() => setArmed(true)}>
          {kind === 'document' && <DocEditor ref={editor} {...props} />}
          {kind === 'spreadsheet' && <SpreadsheetEditor ref={editor} {...props} />}
          {kind === 'presentation' && <SlidesEditor ref={editor} {...props} />}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
          {state === 'error' ? (
            <>
              <CloudOff size={28} className="text-danger" />
              <div>{error}</div>
              {file.size > 0 && (
                <button onClick={() => setMode('original')} className="text-accent hover:underline">
                  Show the original layout instead
                </button>
              )}
            </>
          ) : (
            <>
              <span className="inline-block size-6 animate-spin rounded-full border-2 border-current border-r-transparent" />
              {state === 'importing' && 'Opening the file…'}
              {state === 'waiting' && 'Someone else is opening this file — one moment…'}
            </>
          )}
        </div>
      )}
    </div>
  );
}
