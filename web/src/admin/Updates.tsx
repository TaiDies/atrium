import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpCircle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, confirmDialog, Input, Spinner, toast, toastError } from '../components/ui';
import { adminApi } from './api';

// The admin panel's Updates tab: which version runs and which is out, who's emailed about new
// versions (through the server's email settings), Update now, and auto-update. The installing itself
// is done by the updater container (tools/updater.sh).

interface UpdateStatus {
  current: string;
  repo: string;
  latest: { version: string; url: string; notes: string; publishedAt: string | null } | null;
  available: boolean;
  checkedAt: string | null;
  error: string | null;
  email: string;
  auto: boolean;
  mail: boolean;
  updater: {
    running: boolean;
    canUpdate: boolean;
    reason: string | null;
    status: { state: 'updating' | 'done' | 'failed'; message: string; at: string } | null;
    pending: boolean;
  };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export function UpdatesTab() {
  const qc = useQueryClient();
  const key = ['admin-updates'];
  const status = useQuery({
    queryKey: key,
    queryFn: () => adminApi<UpdateStatus>('/updates'),
    // Follow an update while it runs.
    refetchInterval: (q) => (q.state.data?.updater.pending || q.state.data?.updater.status?.state === 'updating' ? 3000 : false),
  });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (status.data) setEmail(status.data.email);
  }, [status.data?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what: string, fn: () => Promise<UpdateStatus>) => {
    setBusy(what);
    try {
      qc.setQueryData(key, await fn());
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };
  if (!status.data) return <Spinner />;
  const s = status.data;
  const saveSettings = (patch: Partial<{ email: string; auto: boolean }>) =>
    run('settings', () => adminApi<UpdateStatus>('/settings/updates', { method: 'PUT', body: { email: s.email, auto: s.auto, ...patch } })).then(() => toast('Saved'));
  const updating = s.updater.pending || s.updater.status?.state === 'updating';

  return (
    <div className="max-w-2xl space-y-6">
      <section className="rounded-xl border border-line p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className={clsx('flex size-10 items-center justify-center rounded-full', s.available ? 'bg-accent/15 text-accent' : 'bg-green-500/15 text-green-600')}>
            {s.available ? <ArrowUpCircle size={22} /> : <CheckCircle2 size={22} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{s.available ? `Version ${s.latest!.version} is available` : 'This server is up to date'}</div>
            <div className="text-sm text-muted">
              Running {s.current}
              {s.latest && !s.available && ` · latest ${s.latest.version}`} · checked {when(s.checkedAt)}
            </div>
            {s.error && <div className="mt-1 text-sm text-red-500">Couldn't check: {s.error}</div>}
          </div>
          <Button onClick={() => void run('check', () => adminApi<UpdateStatus>('/updates/check', { method: 'POST' }))} loading={busy === 'check'}>
            <RefreshCw size={14} /> Check now
          </Button>
        </div>
        {s.latest && (
          <a href={s.latest.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline">
            What's new in {s.latest.version} <ExternalLink size={12} />
          </a>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button
            variant="primary"
            disabled={!s.updater.canUpdate || updating}
            loading={busy === 'run' || updating}
            onClick={async () => {
              if (!(await confirmDialog({ title: 'Update the server now?', message: 'It downloads the new version and restarts the app; people are signed back in automatically after a minute or two.', confirmLabel: 'Update now' }))) return;
              await run('run', () => adminApi<UpdateStatus>('/updates/run', { method: 'POST' }));
            }}
          >
            Update now
          </Button>
          <span className="text-sm text-muted">
            {updating
              ? s.updater.status?.message ?? 'Starting…'
              : s.updater.status
                ? `${s.updater.status.state === 'failed' ? 'Last update failed: ' : ''}${s.updater.status.message} (${when(s.updater.status.at)})`
                : s.updater.reason ?? 'Installs the newest version from GitHub.'}
          </span>
        </div>
        {!s.updater.canUpdate && s.updater.reason && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{s.updater.reason}</p>}
      </section>

      <section className="rounded-xl border border-line p-5">
        <h3 className="font-semibold">Server notifications receiver email</h3>
        <p className="mt-1 text-sm text-muted">Gets an email when a new version is out (sent with this server's email settings).{!s.mail && ' Set up email first (Email tab).'}</p>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void saveSettings({ email: email.trim() });
          }}
          className="mt-3 flex gap-2"
        >
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com (leave empty for nobody)" className="flex-1" />
          <Button type="submit" loading={busy === 'settings'} disabled={email.trim() === s.email}>
            Save
          </Button>
        </form>
      </section>

      <section className="flex items-start justify-between gap-4 rounded-xl border border-line p-5">
        <div>
          <h3 className="font-semibold">Update automatically</h3>
          <p className="mt-1 text-sm text-muted">When a new version is released, install it straight away (checked every 6 hours).</p>
        </div>
        <button
          role="switch"
          aria-checked={s.auto}
          onClick={() => void saveSettings({ auto: !s.auto })}
          className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', s.auto ? 'bg-accent' : 'bg-line')}
        >
          <span className={clsx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', s.auto ? 'start-[18px]' : 'start-0.5')} />
        </button>
      </section>
      <p className="text-xs text-faint">
        Updates come from github.com/{s.repo}. The updater container (in docker-compose.yml) does the installing; without it, update by hand with git pull and docker compose up -d --build.
      </p>
    </div>
  );
}
