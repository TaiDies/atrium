import clsx from 'clsx';
import { unzipSync } from 'fflate';
import { AlertCircle, CheckCircle2, FileUp, FolderTree, PackageOpen, Sparkles } from 'lucide-react';
import AI_INSTRUCTIONS from '../../../docs/AI-PAGE-INSTRUCTIONS.md?raw';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Dialog, Spinner, toast, toastError } from '../components/ui';
import { ApiError, pageTitle } from '../lib/api';
import { collectFiles, type ImportProgress, migrationNotes, planImport, runImport } from '../lib/importer';
import { convertForeignFormats } from '../lib/importFormats';
import { invalidatePages } from '../lib/queries';
import { useApp } from './context';
import { PageTypeIcon } from './PageIcon';

type Step = 'pick' | 'review' | 'running' | 'done';

/** What an export .zip from this app contains (read from its manifest). */
interface ExportSummary {
  file: File;
  workspace: string;
  pages: { title: string; top: boolean }[];
  files: number;
  events: number;
  whiteboards: number;
}

/** Recognises an export made by this app ("Export…"), which is imported whole by the server. */
async function readExport(file: File): Promise<ExportSummary | null> {
  if (!/\.zip$/i.test(file.name)) return null;
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => f.name === 'atrium-export.json' });
  const raw = entries['atrium-export.json'];
  if (!raw) return null;
  const m = JSON.parse(new TextDecoder().decode(raw)) as {
    format?: string;
    source?: { workspace?: string };
    pages?: { id: string; parentId: string | null; title: string }[];
    files?: unknown[];
    events?: unknown[];
    whiteboards?: unknown[];
  };
  if (m.format !== 'atrium-export') return null;
  const ids = new Set((m.pages ?? []).map((p) => p.id));
  return {
    file,
    workspace: m.source?.workspace ?? '',
    pages: (m.pages ?? []).map((p) => ({ title: p.title || 'Untitled', top: !p.parentId || !ids.has(p.parentId) })),
    files: m.files?.length ?? 0,
    events: m.events?.length ?? 0,
    whiteboards: m.whiteboards?.length ?? 0,
  };
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspace, pages } = useApp();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('pick');
  const [files, setFiles] = useState<Map<string, Uint8Array>>(new Map());
  const [plan, setPlan] = useState<ReturnType<typeof planImport>>([]);
  const [progress, setProgress] = useState<Record<string, ImportProgress>>({});
  const [parentId, setParentId] = useState<string>('');
  const [dragging, setDragging] = useState(false);
  const [first, setFirst] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [native, setNative] = useState<ExportSummary | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep('pick');
      setFiles(new Map());
      setPlan([]);
      setProgress({});
      setFirst(null);
      setNative(null);
      setNativeError(null);
    }
  }, [open]);

  const load = async (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    try {
      const exported = list.length === 1 ? await readExport(Array.from(list)[0]) : null;
      if (exported) {
        setNative(exported);
        setStep('review');
        return;
      }
      // Notion, Evernote, Trello and Word files are turned into pages the importer reads.
      const { files: collected, notes: converted } = convertForeignFormats(await collectFiles(Array.from(list)));
      const planned = planImport(collected);
      if (planned.length === 0) {
        toast('Nothing to import found in those files', 'error');
        return;
      }
      setFiles(collected);
      setPlan(planned);
      setNotes([...converted, ...migrationNotes(collected)]);
      setProgress(Object.fromEntries(planned.map((p) => [p.key, { path: p.path ?? p.key, title: p.title, status: 'pending' as const }])));
      setStep('review');
    } catch (err) {
      toastError(err);
    }
  };

  const startNative = async () => {
    if (!native) return;
    setStep('running');
    try {
      const form = new FormData();
      form.append('file', native.file);
      const res = await fetch(`/api/workspaces/${workspace.id}/import-export${parentId ? `?parentId=${parentId}` : ''}`, { method: 'POST', body: form, credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, data?.error ?? 'Import failed');
      invalidatePages(workspace.id, parentId || undefined);
      setFirst(data.top?.[0] ?? null);
      setNativeError(null);
    } catch (err) {
      setNativeError(err instanceof Error ? err.message : 'Import failed');
    }
    setStep('done');
  };

  const start = async () => {
    setStep('running');
    const firstId = await runImport(workspace.id, parentId || null, files, plan, (key, p) =>
      setProgress((prev) => ({ ...prev, [key]: { ...prev[key], ...p } })),
    );
    invalidatePages(workspace.id, parentId || undefined);
    setFirst(firstId);
    setStep('done');
  };

  const items = plan.map((p) => ({ plan: p, state: progress[p.key] }));
  const failed = items.filter((i) => i.state?.status === 'error').length;
  const depth = (key: string) => {
    let d = 0;
    let current = plan.find((p) => p.key === key);
    while (current?.parentKey) {
      d++;
      current = plan.find((p) => p.key === current!.parentKey);
    }
    return d;
  };

  return (
    <Dialog open={open} onClose={step === 'running' ? () => {} : onClose} title="Import pages" width={560}>
      <div className="px-5 pb-5">
        {step === 'pick' && (
          <>
            <p className="mb-3 text-sm text-muted">
              Bring in pages from another workspace or account, or from other apps. Markdown, HTML, document and text files become documents,
              CSV files become grids, and folders inside a .zip become nested pages. Pictures and files that come with them are uploaded too.
            </p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                load(e.dataTransfer.files);
              }}
              onClick={() => input.current?.click()}
              className={clsx(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
                dragging ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
              )}
            >
              <FileUp size={28} className="text-muted" />
              <div className="text-sm font-medium">Drop files here or click to choose</div>
              <div className="text-xs text-faint">
                An export from this app · Notion (.zip) · Evernote (.enex) · Trello (.json) · documents (.docx) · .md · .html · .csv · .txt · .json (pages made by an AI)
              </div>
            </div>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              accept=".zip,.md,.markdown,.txt,.html,.htm,.csv,.json,.enex,.docx,.pdf,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.rtf,image/*,audio/*,video/*"
              onChange={(e) => {
                load(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-line p-3 text-xs leading-relaxed text-muted">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
              <span className="flex-1">
                <b className="text-fg">Pages made by an AI chat:</b> copy the instructions, paste them into ChatGPT, Claude, Gemini or any AI chat
                with what you want, save its answer as a <b>.json</b> file and drop it here — documents, databases, cards, dates and more. If it
                uses files (pictures, PDFs…), drop them in together with the .json, or zip them all.
              </span>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(AI_INSTRUCTIONS);
                    toast('Instructions copied — paste them into an AI chat');
                  } catch {
                    toast('Could not copy', 'error');
                  }
                }}
                className="shrink-0 rounded-md border border-line px-2 py-1 font-medium text-fg hover:bg-hover"
              >
                Copy instructions for an AI
              </button>
            </div>
            <div className="mt-2 rounded-lg bg-sidebar p-3 text-xs leading-relaxed text-muted">
              <b className="text-fg">From other apps:</b> export your pages as Markdown or HTML (documents) and CSV (tables and boards) — most
              note apps can (Notion: Export → Markdown & CSV; Obsidian: the vault folder as a .zip) — then drop the files or the .zip here.
            </div>
          </>
        )}

        {step !== 'pick' && native && (
          <NativeImport
            summary={native}
            step={step}
            error={nativeError}
            parentId={parentId}
            setParentId={setParentId}
            parents={pages.filter((p) => p.type === 'document')}
            onBack={() => {
              setNative(null);
              setStep('pick');
            }}
            onStart={startNative}
            onOpen={() => {
              onClose();
              if (first) navigate(`/w/${workspace.id}/p/${first}`);
            }}
          />
        )}

        {step !== 'pick' && !native && (
          <>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted">
                <FolderTree size={15} /> {plan.length} {plan.length === 1 ? 'page' : 'pages'}
              </span>
              {step === 'review' && (
                <label className="flex items-center gap-2 text-muted">
                  Put them in
                  <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="h-8 max-w-[200px] rounded-md border border-line bg-bg px-2 text-sm text-fg outline-none">
                    <option value="">Top level</option>
                    {pages
                      .filter((p) => p.type === 'document')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {pageTitle(p)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            <div className="max-h-[42vh] overflow-y-auto rounded-lg border border-line py-1">
              {items.map(({ plan: p, state }) => (
                <div key={p.key} className="flex items-center gap-2 px-3 py-1.5 text-sm" style={{ paddingLeft: 12 + depth(p.key) * 18 }}>
                  <PageTypeIcon type={p.type} size={15} />
                  <span className="min-w-0 flex-1 truncate">{state?.title ?? p.title}</span>
                  {state?.status === 'working' && <Spinner className="size-3.5 text-muted" />}
                  {state?.status === 'done' && <CheckCircle2 size={15} className="text-green-500" />}
                  {state?.status === 'error' && (
                    <span className="flex items-center gap-1 text-xs text-danger" title={state.error}>
                      <AlertCircle size={14} /> {state.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {notes.length > 0 && step === 'review' && (
              <details className="mt-3 rounded-lg bg-sidebar px-3 py-2 text-xs text-muted">
                <summary className="cursor-pointer font-medium text-fg">Notes about this import · {notes.length} note{notes.length === 1 ? '' : 's'}</summary>
                <ul className="mt-1.5 list-disc space-y-0.5 ps-4">
                  {notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-muted">
                {step === 'done' && (failed ? `${plan.length - failed} imported, ${failed} failed` : 'All pages imported')}
                {step === 'running' && 'Importing… keep this window open'}
              </span>
              <div className="flex gap-2">
                {step === 'review' && (
                  <>
                    <Button onClick={() => setStep('pick')}>Back</Button>
                    <Button variant="primary" onClick={start}>
                      Import {plan.length} {plan.length === 1 ? 'page' : 'pages'}
                    </Button>
                  </>
                )}
                {step === 'running' && <Button loading>Importing</Button>}
                {step === 'done' && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      onClose();
                      if (first) navigate(`/w/${workspace.id}/p/${first}`);
                    }}
                  >
                    {first ? 'Open imported page' : 'Close'}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function NativeImport({
  summary,
  step,
  error,
  parentId,
  setParentId,
  parents,
  onBack,
  onStart,
  onOpen,
}: {
  summary: ExportSummary;
  step: Step;
  error: string | null;
  parentId: string;
  setParentId: (id: string) => void;
  parents: { id: string; title: string }[];
  onBack: () => void;
  onStart: () => void;
  onOpen: () => void;
}) {
  const top = summary.pages.filter((p) => p.top);
  const counts = [
    `${summary.pages.length} ${summary.pages.length === 1 ? 'page' : 'pages'}`,
    summary.files && `${summary.files} ${summary.files === 1 ? 'file' : 'files'}`,
    summary.events && `${summary.events} ${summary.events === 1 ? 'event' : 'events'}`,
    summary.whiteboards && `${summary.whiteboards} ${summary.whiteboards === 1 ? 'whiteboard' : 'whiteboards'}`,
  ].filter(Boolean);
  return (
    <div>
      <div className="flex items-start gap-3 rounded-xl border border-line p-4">
        <PackageOpen size={22} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 text-sm">
          <div className="font-medium">An export{summary.workspace ? ` from “${summary.workspace}”` : ''}</div>
          <div className="mt-0.5 text-muted">{counts.join(' · ')}</div>
          <div className="mt-2 truncate text-xs text-faint">
            {top
              .slice(0, 4)
              .map((p) => p.title)
              .join(', ')}
            {top.length > 4 ? ` and ${top.length - 4} more` : ''}
          </div>
        </div>
      </div>
      {step === 'review' && (
        <label className="mt-4 flex items-center justify-between gap-2 text-sm text-muted">
          Put it in
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="h-8 max-w-[240px] rounded-md border border-line bg-bg px-2 text-sm text-fg outline-none">
            <option value="">Top level</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {pageTitle(p)}
              </option>
            ))}
          </select>
        </label>
      )}
      {step === 'done' && (
        <div className={clsx('mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm', error ? 'bg-danger/10 text-danger' : 'bg-accent-soft')}>
          {error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} className="text-green-500" />}
          {error ?? 'Imported. Pages, files, events and whiteboards are all here.'}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {step === 'review' && (
          <>
            <Button onClick={onBack}>Back</Button>
            <Button variant="primary" onClick={onStart}>
              Import
            </Button>
          </>
        )}
        {step === 'running' && <Button loading>Importing</Button>}
        {step === 'done' && (
          <Button variant="primary" onClick={onOpen}>
            {!error && top.length ? 'Open imported page' : 'Close'}
          </Button>
        )}
      </div>
    </div>
  );
}
