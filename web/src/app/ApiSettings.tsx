import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, Plus, Send, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button, confirmDialog, Input, Spinner, toast, toastError } from '../components/ui';
import { api } from '../lib/api';
import { queryClient, usePermissions, useWorkspaces } from '../lib/queries';
import { ConnectClaude } from './ConnectClaude';
import { useApp } from './context';

// Settings → API & webhooks: personal API tokens (for scripts and other apps) and, for workspace
// owners, webhooks that tell another address when things change.

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  workspaceName: string | null;
}
interface Webhook {
  id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastSentAt: string | null;
}

const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`${what} copied`));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'never');

export function ApiTab() {
  const may = usePermissions();
  const { workspace } = useApp();
  return (
    <div className="space-y-8">
      {may('api_tokens') ? (
        <>
          <ConnectClaude />
          <Tokens />
        </>
      ) : (
        <p className="text-sm text-muted">Your account's role doesn't include API tokens. Ask the server's administrator.</p>
      )}
      {workspace.role === 'owner' && <Webhooks workspaceId={workspace.id} />}
    </div>
  );
}

function Tokens() {
  const key = ['api-tokens'];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ tokens: Token[] }>('/api/auth/tokens') });
  const [name, setName] = useState('');
  const [days, setDays] = useState<string>('');
  const [scope, setScope] = useState('');
  const workspaces = useWorkspaces();
  const [made, setMade] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { token } = await api<{ token: string }>('/api/auth/tokens', { method: 'POST', body: { name: name.trim(), days: days ? Number(days) : null, workspaceId: scope || null } });
      setMade(token);
      setName('');
      queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (t: Token) => {
    if (!(await confirmDialog({ title: `Delete “${t.name}”?`, message: 'Anything using it stops working straight away.', confirmLabel: 'Delete', danger: true }))) return;
    await api(`/api/auth/tokens/${t.id}`, { method: 'DELETE' }).catch(toastError);
    queryClient.invalidateQueries({ queryKey: key });
  };

  return (
    <section>
      <h3 className="text-base font-semibold">API tokens</h3>
      <p className="mt-1 text-sm text-muted">
        For scripts and other apps: a token acts as you, and sees and changes only what you can.{' '}
        <a href="/api/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
          API guide <ExternalLink size={12} />
        </a>
      </p>
      {made && (
        <div className="mt-3 rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
          <p className="font-medium">Copy your new token now — it won't be shown again.</p>
          <div className="mt-2 flex gap-2">
            <input readOnly value={made} onFocus={(e) => e.target.select()} className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-xs" />
            <Button onClick={() => copy(made, 'Token')}>
              <Copy size={14} /> Copy
            </Button>
          </div>
        </div>
      )}
      <form onSubmit={create} className="mt-3 flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="What it's for, e.g. “Backup script”" className="min-w-0 flex-1" />
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-sm" title="What it can reach">
          <option value="">All my workspaces</option>
          {(workspaces.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              Only {w.name}
            </option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-sm" title="When it stops working">
          <option value="">Never expires</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
        </select>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          <Plus size={14} /> New token
        </Button>
      </form>
      <div className="mt-3 divide-y divide-line rounded-lg border border-line">
        {list.isPending && (
          <div className="p-3">
            <Spinner />
          </div>
        )}
        {list.data?.tokens.length === 0 && <p className="p-3 text-sm text-muted">No tokens yet.</p>}
        {list.data?.tokens.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{t.name}</div>
              <div className="text-xs text-faint">
                <span className="font-mono">{t.prefix}…</span> · made {when(t.createdAt)} · last used {when(t.lastUsedAt)}
                {t.expiresAt ? ` · expires ${when(t.expiresAt)}` : ''}
                {t.workspaceName ? ` · only ${t.workspaceName}` : ''}
              </div>
            </div>
            <button onClick={() => void remove(t)} title="Delete token" className="rounded p-1.5 text-faint hover:bg-hover hover:text-red-500">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Webhooks({ workspaceId }: { workspaceId: string }) {
  const key = ['webhooks', workspaceId];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ webhooks: Webhook[]; events: string[] }>(`/api/workspaces/${workspaceId}/webhooks`) });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/workspaces/${workspaceId}/webhooks`, { method: 'POST', body: { url: url.trim(), events } });
      setUrl('');
      setEvents([]);
      refresh();
    } catch (err) {
      toastError(err);
    }
  };
  const test = async (h: Webhook) => {
    try {
      const r = await api<{ status: number | null; error: string | null }>(`/api/webhooks/${h.id}/test`, { method: 'POST' });
      if (r.error) toastError(new Error(r.error));
      else toast(`Delivered (${r.status})`);
      refresh();
    } catch (err) {
      toastError(err);
    }
  };
  const patch = async (h: Webhook, body: Partial<Webhook>) => {
    await api(`/api/webhooks/${h.id}`, { method: 'PATCH', body }).catch(toastError);
    refresh();
  };
  const remove = async (h: Webhook) => {
    if (!(await confirmDialog({ title: 'Delete this webhook?', message: h.url, confirmLabel: 'Delete', danger: true }))) return;
    await api(`/api/webhooks/${h.id}`, { method: 'DELETE' }).catch(toastError);
    refresh();
  };
  const all = list.data?.events ?? [];

  return (
    <section>
      <h3 className="text-base font-semibold">Webhooks</h3>
      <p className="mt-1 text-sm text-muted">
        When something changes in this workspace, the server sends a signed POST to these addresses (see the API guide for the format).
      </p>
      <form onSubmit={add} className="mt-3 space-y-2 rounded-lg border border-line p-3">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/workspace" />
        <div className="flex flex-wrap gap-1.5">
          {all.map((ev) => (
            <label key={ev} className="flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs">
              <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents((l) => (e.target.checked ? [...l, ev] : l.filter((x) => x !== ev)))} />
              {ev}
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-faint">{events.length ? `${events.length} event${events.length === 1 ? '' : 's'}` : 'Nothing ticked: every event'}</span>
          <Button type="submit" variant="primary" disabled={!url.trim()}>
            <Plus size={14} /> Add webhook
          </Button>
        </div>
      </form>
      <div className="mt-3 space-y-2">
        {list.data?.webhooks.map((h) => (
          <div key={h.id} className="rounded-lg border border-line p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{h.url}</span>
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={h.active} onChange={(e) => void patch(h, { active: e.target.checked })} /> On
              </label>
              <button onClick={() => void test(h)} title="Send a test" className="rounded p-1.5 text-muted hover:bg-hover hover:text-fg">
                <Send size={14} />
              </button>
              <button onClick={() => void remove(h)} title="Delete webhook" className="rounded p-1.5 text-faint hover:bg-hover hover:text-red-500">
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-1 text-xs text-faint">
              {h.events.length ? h.events.join(', ') : 'Every event'} ·{' '}
              {h.lastSentAt ? (h.lastError ? <span className="text-red-500">last failed: {h.lastError}</span> : `last delivered ${when(h.lastSentAt)} (${h.lastStatus})`) : 'nothing sent yet'}
            </div>
            <div className="mt-1 flex items-center gap-1 text-xs text-faint">
              Secret: <span className="font-mono">{h.secret.slice(0, 10)}…</span>
              <button onClick={() => copy(h.secret, 'Secret')} className="text-accent hover:underline">
                copy
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
