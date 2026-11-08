import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Archive, CornerDownLeft, FileText, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog, Spinner } from '../components/ui';
import { api, pageTitle, type SearchResult } from '../lib/api';
import { useOpenFile } from '../lib/openFile';
import { getLocal, setLocal } from '../lib/storage';
import { useApp } from './context';
import { PageIcon } from './PageIcon';

// Search (Ctrl/⌘+K) and the quick switcher (Ctrl/⌘+P): pages you opened lately, then results for
// what's typed — pages, cards and the text inside files — with filters.

const recentKey = (workspaceId: string) => `atrium-recent-pages:${workspaceId}`;

/** Remembers that a page was opened (for "Recently opened"). */
export function rememberVisit(workspaceId: string, pageId: string) {
  const list = getLocal<string[]>(recentKey(workspaceId), []).filter((id) => id !== pageId);
  setLocal(recentKey(workspaceId), [pageId, ...list].slice(0, 20));
}

type Kind = 'all' | 'pages' | 'databases' | 'files';
type Edited = 'any' | '1' | '7' | '30' | '365';

const KINDS: { id: Kind; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'pages', label: 'Pages' },
  { id: 'databases', label: 'Databases' },
  { id: 'files', label: 'Files' },
];
const EDITED: { id: Edited; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: '1', label: 'Today' },
  { id: '7', label: 'Past week' },
  { id: '30', label: 'Past month' },
  { id: '365', label: 'Past year' },
];

type Result = SearchResult & { archivedAt?: string | null; mimeType?: string };

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspace, pages } = useApp();
  const navigate = useNavigate();
  const openFile = useOpenFile();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState(0);
  const [kind, setKind] = useState<Kind>('all');
  const [edited, setEdited] = useState<Edited>('any');
  const [mine, setMine] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setDebounced('');
    }
  }, [open]);

  const search = useQuery({
    queryKey: ['search', workspace.id, debounced, kind, edited, mine],
    queryFn: async () =>
      (await api<{ results: Result[] }>(`/api/workspaces/${workspace.id}/search?q=${encodeURIComponent(debounced)}&kind=${kind}&edited=${edited}&mine=${mine ? 1 : 0}`)).results,
    enabled: open && debounced.length > 0,
    placeholderData: keepPreviousData,
  });

  // Nothing typed: the pages opened most recently on this device, then the ones edited lately.
  const visited = getLocal<string[]>(recentKey(workspace.id), [])
    .map((id) => pages.find((p) => p.id === id))
    .filter((p): p is (typeof pages)[number] => !!p);
  const recent = [...visited, ...[...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter((p) => !visited.includes(p))].slice(0, 10);
  const results: Result[] = debounced
    ? (search.data ?? [])
    : recent.map((p) => ({ id: p.id, title: p.title, icon: p.icon, type: p.type, snippet: '', archivedAt: p.archivedAt }));

  useEffect(() => setSelected(0), [debounced, search.data]);

  const go = (r: Result) => {
    onClose();
    if ((r.type as string) === 'file') openFile(`/api/files/${r.id}`, r.title);
    else navigate(`/w/${workspace.id}/p/${r.id}`);
  };

  const chip = (active: boolean) => clsx('rounded-full border px-2.5 py-0.5 text-xs', active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-hover');

  return (
    <Dialog open={open} onClose={onClose} width={640}>
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search size={17} className="shrink-0 text-muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter' && results[selected]) {
              go(results[selected]);
            }
          }}
          placeholder={`Search or jump to a page in ${workspace.name}…`}
          className="h-13 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
        />
        {search.isFetching && <Spinner className="text-muted" />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {KINDS.map((k) => (
          <button key={k.id} onClick={() => setKind(k.id)} className={chip(kind === k.id)}>
            {k.label}
          </button>
        ))}
        <select value={edited} onChange={(e) => setEdited(e.target.value as Edited)} className="ms-auto h-6 rounded-md border border-line bg-bg px-1.5 text-xs text-muted" aria-label="Last edited">
          {EDITED.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id === 'any' ? 'Edited any time' : `Edited: ${x.label.toLowerCase()}`}
            </option>
          ))}
        </select>
        <button onClick={() => setMine((v) => !v)} className={chip(mine)}>
          Made by me
        </button>
      </div>
      <div className="max-h-[56vh] overflow-y-auto p-1.5">
        {!debounced && <div className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-faint">Recently opened</div>}
        {debounced && search.data && results.length === 0 && <div className="px-3 py-10 text-center text-sm text-muted">No results for “{debounced}”</div>}
        {results.map((r, i) => (
          <button
            key={`${r.type}:${r.id}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => go(r)}
            className={clsx('flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-start', i === selected && 'bg-hover')}
          >
            <span className="mt-0.5">{(r.type as string) === 'file' ? <FileText size={16} className="text-accent" /> : <PageIcon page={r} />}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{(r.type as string) === 'file' ? r.title : pageTitle(r)}</span>
                {(r.type as string) === 'file' && <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted uppercase">file</span>}
                {r.archivedAt && (
                  <span className="flex shrink-0 items-center gap-0.5 rounded bg-hover px-1 text-[10px] text-muted">
                    <Archive size={9} /> archived
                  </span>
                )}
              </span>
              {r.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{r.snippet}</span>}
            </span>
            {i === selected && <CornerDownLeft size={14} className="mt-1 shrink-0 text-faint" />}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
