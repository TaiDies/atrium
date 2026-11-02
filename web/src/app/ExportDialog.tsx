import clsx from 'clsx';
import { Download, PackageOpen, X } from 'lucide-react';
import { useState } from 'react';
import { Dialog, IconButton } from '../components/ui';
import { type PageSummary, pageTitle } from '../lib/api';
import { useApp } from './context';

/** What's inside an export, for the dialogs that make one. */
export function ExportContents() {
  return (
    <ul className="list-disc space-y-1 ps-5 text-xs text-muted">
      <li>
        <b className="text-fg">For another account or workspace:</b> use <b>Import</b> there and choose the .zip. Pages, databases and cards, attachments,
        handwriting on PDFs, events and whiteboards all come across.
      </li>
      <li>
        <b className="text-fg">For other apps:</b> the .zip also has every page as Markdown, every database as a CSV spreadsheet, and every attachment in its
        original format.
      </li>
    </ul>
  );
}

/** "Export…" for a page: this page alone, or with everything under it. */
export function ExportDialog({ page, onClose }: { page: PageSummary; onClose: () => void }) {
  const { pages } = useApp();
  const hasChildren = pages.some((p) => p.parentId === page.id);
  const [subpages, setSubpages] = useState(hasChildren);
  const count = (() => {
    if (!subpages) return 1;
    let n = 0;
    const walk = (id: string) => {
      n++;
      for (const c of pages.filter((p) => p.parentId === id)) walk(c.id);
    };
    walk(page.id);
    return n;
  })();

  return (
    <Dialog open onClose={onClose} width={480}>
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <PackageOpen size={17} className="text-muted" />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">Export “{pageTitle(page)}”</h2>
        <IconButton onClick={onClose} aria-label="Close">
          <X size={16} />
        </IconButton>
      </div>
      <div className="space-y-4 px-5 py-4">
        <div className="space-y-2">
          {[
            { value: false, label: 'This page only', hint: 'Its own content, attachments, events and whiteboards' },
            { value: true, label: 'This page and its sub-pages', hint: hasChildren ? 'Everything nested under it as well' : 'It has no sub-pages yet' },
          ].map((o) => (
            <label
              key={String(o.value)}
              className={clsx(
                'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm',
                subpages === o.value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
                o.value && !hasChildren && 'pointer-events-none opacity-50',
              )}
            >
              <input type="radio" checked={subpages === o.value} onChange={() => setSubpages(o.value)} className="mt-1" />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="text-xs text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <ExportContents />
        <div className="flex justify-end">
          <a
            href={`/api/pages/${page.id}/export?subpages=${subpages ? 1 : 0}`}
            download
            onClick={() => setTimeout(onClose, 300)}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:brightness-110"
          >
            <Download size={15} /> Export {count} {count === 1 ? 'page' : 'pages'}
          </a>
        </div>
      </div>
    </Dialog>
  );
}
