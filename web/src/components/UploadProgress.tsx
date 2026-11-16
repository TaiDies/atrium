import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import { useUploads, type UploadItem } from '../lib/upload';

/** Uploads that finish this quickly (small images, autosaves) never show, so the panel doesn't flicker. */
const SHOW_AFTER_MS = 600;
const MAX_ROWS = 4;

const sizeOf = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** A small panel in the corner with a progress bar for each upload in progress. */
export function UploadProgress() {
  const uploads = useUploads();
  const [now, setNow] = useState(() => Date.now());
  // Shown once an upload has been going for a moment: tick while any are running.
  const running = uploads.some((u) => u.state === 'sending' || u.state === 'processing');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  const [seen] = useState(() => new Set<number>());
  const shown = uploads.filter((u) => {
    if (seen.has(u.id)) return true;
    // A failure always shows, with its reason, even when it came at once (e.g. over the size limit).
    if (u.state === 'failed' || ((u.state === 'sending' || u.state === 'processing') && now - u.started >= SHOW_AFTER_MS)) {
      seen.add(u.id);
      return true;
    }
    return false;
  });
  if (!shown.length) return null;
  const failed = shown.filter((u) => u.state === 'failed').length;
  const active = shown.filter((u) => u.state === 'sending' || u.state === 'processing');
  const rows = shown.slice(-MAX_ROWS);
  const hidden = shown.length - rows.length;
  return createPortal(
    <div
      className="atrium-uploads shadow-pop fixed bottom-4 right-4 z-[65] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-bg p-3 text-sm"
      role="status"
      aria-live="polite"
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
        <Upload size={13} />
        {active.length ? `Uploading ${active.length} file${active.length === 1 ? '' : 's'}` : failed ? `${failed} upload${failed === 1 ? '' : 's'} failed` : 'Uploads finished'}
      </div>
      <div className="flex flex-col gap-2.5">
        {hidden > 0 && <div className="text-xs text-muted">and {hidden} more</div>}
        {rows.map((u) => (
          <Row key={u.id} u={u} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function Row({ u }: { u: UploadItem }) {
  const pct = u.total ? Math.floor((100 * u.sent) / u.total) : 100;
  const label =
    u.state === 'failed' ? (u.error ? `Failed: ${u.error}` : 'Failed') : u.state === 'done' ? 'Uploaded' : u.state === 'processing' ? 'Processing…' : `${pct}% · ${sizeOf(u.sent)} of ${sizeOf(u.total)}`;
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-fg" title={u.name}>
          {u.name}
        </span>
        {u.state === 'done' ? (
          <Check size={14} className="shrink-0 text-accent" />
        ) : u.state === 'failed' ? (
          <X size={14} className="shrink-0 text-danger" />
        ) : u.state === 'processing' ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-muted" />
        ) : null}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
        <div
          className={clsx(
            'h-full rounded-full transition-[width] duration-200',
            u.state === 'failed' ? 'bg-danger' : 'bg-accent',
            u.state === 'processing' && 'animate-pulse',
          )}
          style={{ width: `${u.state === 'failed' ? Math.max(pct, 4) : pct}%` }}
        />
      </div>
      <div className={clsx('mt-0.5 text-xs tabular-nums break-words', u.state === 'failed' ? 'text-danger' : 'text-muted')}>{label}</div>
    </div>
  );
}
