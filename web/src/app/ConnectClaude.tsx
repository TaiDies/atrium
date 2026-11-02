import { Brain, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button, toast, toastError } from '../components/ui';
import { api } from '../lib/api';
import { nativeInfo } from '../lib/native';
import { queryClient, useWorkspaces } from '../lib/queries';

// Settings → API & webhooks → Connect Claude: give an AI assistant (Claude Code, Claude Desktop, or any
// app that speaks MCP) a workspace to use as its long-term memory, through a token limited to that
// workspace, with the setup ready to paste.

/** The server's own address (in the desktop and phone apps the page itself lives elsewhere). */
const serverAddress = () => (nativeInfo()?.server ?? location.origin).replace(/\/+$/, '');

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-muted">
        {label}
        <button
          onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied'))}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-hover"
        >
          <Copy size={12} /> Copy
        </button>
      </div>
      <pre dir="ltr" className="overflow-x-auto rounded-lg bg-hover p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap break-all" data-no-translate>
        {text}
      </pre>
    </div>
  );
}

export function ConnectClaude() {
  const workspaces = useWorkspaces();
  const list = (workspaces.data ?? []).filter((w) => w.role !== 'guest');
  const [workspaceId, setWorkspaceId] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = workspaceId || list[0]?.id || '';
  const url = `${serverAddress()}/api/mcp`;

  const make = async () => {
    setBusy(true);
    try {
      const name = list.find((w) => w.id === chosen)?.name ?? 'workspace';
      const res = await api<{ token: string }>('/api/auth/tokens', { method: 'POST', body: { name: `Claude — ${name}`, workspaceId: chosen } });
      setToken(res.token);
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const t = token ?? 'af_…';
  const code = `claude mcp add --transport http workspace-brain ${url} --header "Authorization: Bearer ${t}"`;
  const desktop = JSON.stringify(
    {
      mcpServers: {
        'workspace-brain': {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH}'],
          env: { AUTH: `Bearer ${t}` },
        },
      },
    },
    null,
    2,
  );

  return (
    <section>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Brain size={17} className="text-accent" /> Connect Claude
      </h3>
      <p className="mt-1 text-sm text-muted">
        Give Claude (or another AI assistant that supports MCP) a workspace to use as its own memory — a second brain of linked notes. It can
        search and read notes, write new ones, update them and link them with [[Title]], so they connect in the Graph. It sees only the workspace
        you pick here. Tip: make a new workspace just for it.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={chosen} onChange={(e) => setWorkspaceId(e.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm">
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.icon ? `${w.icon} ` : ''}
              {w.name}
            </option>
          ))}
        </select>
        <Button variant="primary" onClick={make} loading={busy} disabled={!chosen}>
          Make a token for Claude
        </Button>
      </div>
      {token && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Copy the setup now — the token isn't shown again (delete it below to cut Claude off).</p>}
      <Snippet label="Claude Code (run in a terminal)" text={code} />
      <Snippet label="Claude Desktop (Settings → Developer → Edit config, add to claude_desktop_config.json; needs Node.js)" text={desktop} />
      <p className="mt-2 text-xs text-faint">
        Claude needs to reach {serverAddress()} from where it runs. Other MCP apps: connect to {url} with the header “Authorization: Bearer &lt;token&gt;”.
      </p>
    </section>
  );
}
