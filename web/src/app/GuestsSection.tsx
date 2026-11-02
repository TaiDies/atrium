import { useQuery } from '@tanstack/react-query';
import { UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Button, toast, toastError } from '../components/ui';
import { api, type PageDetail } from '../lib/api';
import { queryClient } from '../lib/queries';

// Sharing one page with someone outside the workspace: they become a guest who sees only this page
// (and the pages inside it).

interface GuestList {
  guests: { id: string; name: string; email: string; color: string; level: 'edit' | 'view' }[];
  pending: { email: string; level: 'edit' | 'view' }[];
}

export function GuestsSection({ page }: { page: PageDetail }) {
  const key = ['guests', page.id];
  const list = useQuery({ queryKey: key, queryFn: () => api<GuestList>(`/api/pages/${page.id}/guests`) });
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const canManage = page.access === 'manage';

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ status: string; hasAccount?: boolean }>(`/api/pages/${page.id}/guests`, { method: 'POST', body: { email: email.trim(), level } });
      toast(res.status === 'shared' ? 'Shared — they already have access to the workspace' : res.hasAccount ? 'Invited — they’ll see it under their 🔔' : 'Invited — they’ll see it after signing up with that email');
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (q: string) => {
    try {
      await api(`/api/pages/${page.id}/guests?${q}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toastError(err);
    }
  };

  const data = list.data;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-1 text-sm font-medium">Guests</div>
      <p className="mb-2 text-xs text-muted">People outside the workspace who can open only this page and the pages inside it.</p>
      {canManage && (
        <form onSubmit={invite} className="flex gap-1.5">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <select value={level} onChange={(e) => setLevel(e.target.value as 'view' | 'edit')} className="h-8 rounded-md border border-line bg-bg px-1.5 text-sm">
            <option value="view">Can view</option>
            <option value="edit">Can edit</option>
          </select>
          <Button size="sm" variant="primary" type="submit" loading={busy}>
            <UserPlus size={14} /> Invite
          </Button>
        </form>
      )}
      <div className="mt-2 space-y-1">
        {data?.guests.map((g) => (
          <div key={g.id} className="flex items-center gap-2 text-sm">
            <Avatar name={g.name} color={g.color} size={24} />
            <span className="min-w-0 flex-1 truncate">
              {g.name} <span className="text-xs text-muted">{g.email}</span>
            </span>
            <span className="text-xs text-muted">{g.level === 'edit' ? 'Can edit' : 'Can view'}</span>
            {canManage && (
              <button onClick={() => remove(`userId=${g.id}`)} className="rounded p-1 text-muted hover:text-danger" title="Stop sharing">
                <X size={13} />
              </button>
            )}
          </div>
        ))}
        {data?.pending.map((p) => (
          <div key={p.email} className="flex items-center gap-2 text-sm">
            <span className="flex size-6 items-center justify-center rounded-full bg-hover text-xs text-muted">@</span>
            <span className="min-w-0 flex-1 truncate text-muted">{p.email}</span>
            <span className="text-xs text-faint">Invited · {p.level === 'edit' ? 'can edit' : 'can view'}</span>
            {canManage && (
              <button onClick={() => remove(`email=${encodeURIComponent(p.email)}`)} className="rounded p-1 text-muted hover:text-danger" title="Withdraw">
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
