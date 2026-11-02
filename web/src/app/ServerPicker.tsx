import clsx from 'clsx';
import { Cloud, Server } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button, Input } from '../components/ui';
import { APP_NAME } from '../lib/api';
import { chooseServer } from '../lib/native';

/**
 * The first screen of the Windows and Android apps: use the hosted service, or connect to a server of
 * your own (by address). Afterwards the app talks only to that server, and keeps working offline.
 */
export function ServerPicker() {
  const [choice, setChoice] = useState<'service' | 'own'>('own');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    let server = address.trim();
    if (!server) return;
    // "192.168.1.20:3000" → "http://192.168.1.20:3000"
    if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
    setLoading(true);
    try {
      const r = await chooseServer(server.replace(/\/+$/, ''));
      if (!r.ok) throw new Error(r.error ?? 'Couldn’t connect to that server');
      location.replace('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t connect to that server');
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-sidebar px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="mb-4 size-12" />
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to {APP_NAME}</h1>
          <p className="mt-1.5 text-sm text-muted">Choose where your workspace lives.</p>
        </div>
        <div className="space-y-3">
          <button
            disabled
            onClick={() => setChoice('service')}
            className={clsx('flex w-full items-start gap-3 rounded-xl border bg-surface p-4 text-start opacity-60', choice === 'service' ? 'border-accent' : 'border-line')}
          >
            <Cloud size={22} className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="block font-medium">Sign in to your {APP_NAME} account</span>
              <span className="text-sm text-muted">Our hosted service — coming soon.</span>
            </span>
          </button>
          <form onSubmit={connect} className={clsx('rounded-xl border bg-surface p-4', choice === 'own' ? 'border-accent' : 'border-line')}>
            <div className="flex items-start gap-3">
              <Server size={22} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">Connect to your own server</div>
                <div className="text-sm text-muted">The address of a self-hosted server, e.g. 192.168.1.20:3000 or notes.example.com.</div>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:3000" className="mt-3 w-full" autoFocus inputMode="url" autoCapitalize="off" autoCorrect="off" required />
                {error && <p className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
                <Button type="submit" variant="primary" className="mt-3 w-full" loading={loading}>
                  Connect
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
