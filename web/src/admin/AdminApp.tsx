import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpCircle, Building2, Gauge, KeyRound, LogOut, Mail, Search, ShieldCheck, SlidersHorizontal, UserCog, Sparkles, UserPlus, Users } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Avatar, Button, confirmDialog, Dialog, Input, Spinner, toast, toastError } from '../components/ui';
import { adminApi, bytes, setSignedOutHandler } from './api';
import { UpdatesTab } from './Updates';
import { AssignRolesDialog, RolesTab, useRoles } from './Roles';
import { type Effective, type Limits, LimitsTab, limitText, MailTab, PeopleLimitsDialog, tokens } from './LimitsAndMail';

// The admin panel (its own page and port): accounts, workspaces, sign-ups, the AI connection offered to
// everyone, and the panel's password.

type Tab = 'overview' | 'accounts' | 'roles' | 'workspaces' | 'limits' | 'ai' | 'email' | 'updates' | 'security';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <Gauge size={16} /> },
  { id: 'accounts', label: 'Accounts', icon: <Users size={16} /> },
  { id: 'roles', label: 'Roles', icon: <UserCog size={16} /> },
  { id: 'workspaces', label: 'Workspaces', icon: <Building2 size={16} /> },
  { id: 'limits', label: 'Limits', icon: <SlidersHorizontal size={16} /> },
  { id: 'ai', label: 'AI', icon: <Sparkles size={16} /> },
  { id: 'email', label: 'Email', icon: <Mail size={16} /> },
  { id: 'updates', label: 'Updates', icon: <ArrowUpCircle size={16} /> },
  { id: 'security', label: 'Sign-ups & security', icon: <ShieldCheck size={16} /> },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

export function AdminApp() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'overview');
  const qc = useQueryClient();

  useEffect(() => {
    setSignedOutHandler(() => setSignedIn(false));
    adminApi('/overview')
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, []);
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  if (signedIn === null)
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Spinner />
      </div>
    );
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;

  const signOut = async () => {
    await adminApi('/logout', { method: 'POST' }).catch(() => {});
    qc.clear();
    setSignedIn(false);
  };

  return (
    <div className="flex h-screen flex-col bg-bg text-fg md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-line bg-sidebar md:w-60 md:border-e md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3">
          <ShieldCheck size={18} className="text-accent" />
          <span className="font-semibold">Admin panel</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx('flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm', tab === t.id ? 'bg-active font-medium' : 'text-muted hover:bg-hover hover:text-fg')}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
        <div className="hidden flex-1 md:block" />
        <button onClick={signOut} className="m-2 hidden h-8 items-center gap-2 rounded-md px-2.5 text-sm text-muted hover:bg-hover hover:text-fg md:flex">
          <LogOut size={16} /> Sign out
        </button>
      </aside>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8">
          {tab === 'overview' && <Overview />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'roles' && <RolesTab />}
          {tab === 'workspaces' && <Workspaces />}
          {tab === 'limits' && <LimitsTab />}
          {tab === 'ai' && <AiSettings />}
          {tab === 'email' && <MailTab />}
          {tab === 'updates' && <UpdatesTab />}
          {tab === 'security' && <Security />}
          <button onClick={signOut} className="mt-10 flex items-center gap-2 text-sm text-muted md:hidden">
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi('/login', { method: 'POST', body: { password } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4 text-fg">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck size={20} className="text-accent" />
          <h1 className="text-lg font-semibold">Admin panel</h1>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Admin password</span>
          <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        <Button type="submit" variant="primary" className="mt-4 w-full" loading={busy} disabled={!password}>
          Sign in
        </Button>
        <p className="mt-4 text-xs text-muted">
          The password is ADMIN_PASSWORD on the server, or — if that isn't set — the one made on first start, kept in /data/admin-password.txt until you change it.
        </p>
      </form>
    </div>
  );
}

function Heading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ---------- overview ----------

function Overview() {
  const { data } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => adminApi<{ users: number; active: number; disabled: number; workspaces: number; pages: number; files: number; storage: number; appName: string; notices?: { id: string; text: string }[] }>('/overview'),
  });
  const stat = (label: string, value: ReactNode) => (
    <div className="rounded-xl border border-line p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
  return (
    <>
      <Heading title={data?.appName ?? 'Overview'} description="This server at a glance." />
      {data?.notices?.map((n) => (
        <div key={n.id} role="alert" className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {n.text}
        </div>
      ))}
      {!data ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stat('Accounts', data.users)}
          {stat('Active this week', data.active)}
          {stat('Switched off', data.disabled)}
          {stat('Workspaces', data.workspaces)}
          {stat('Pages', data.pages)}
          {stat('Files', data.files)}
          {stat('Storage used', bytes(data.storage))}
        </div>
      )}
    </>
  );
}

// ---------- accounts ----------

interface AdminUser {
  id: string;
  name: string;
  email: string;
  color: string;
  createdAt: string;
  lastSeenAt: string | null;
  verified: boolean;
  disabled: boolean;
  hasPassword: boolean;
  workspaces: number;
  storage: number;
  ownAi: boolean;
  roleIds: string[];
  ownedWorkspaces: number;
  limits: Effective;
  ownLimits: Limits;
}

function Accounts() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [bulkRoles, setBulkRoles] = useState(false);
  const roles = useRoles();
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name;
  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, refetch, isPending } = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: () => adminApi<{ users: AdminUser[]; more: boolean }>(`/users?q=${encodeURIComponent(search)}`),
  });

  return (
    <>
      <Heading
        title="Accounts"
        description="Everyone with an account on this server."
        action={
          <div className="flex gap-2">
            {picked.size > 0 && (
              <Button onClick={() => setBulkRoles(true)}>
                <UserCog size={15} /> Roles for {picked.size}
              </Button>
            )}
            {picked.size > 0 && (
              <Button onClick={() => setBulk(true)}>
                <SlidersHorizontal size={15} /> Set limits for {picked.size}
              </Button>
            )}
            <Button variant="primary" onClick={() => setCreating(true)}>
              <UserPlus size={15} /> New account
            </Button>
          </div>
        }
      />
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-line px-3 focus-within:border-accent">
        <Search size={15} className="text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" className="h-9 flex-1 bg-transparent text-sm outline-none" />
      </div>
      {isPending && <Spinner />}
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-hover/50 text-start text-xs text-muted">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={!!data?.users.length && data.users.every((u) => picked.has(u.id))}
                  onChange={(e) => setPicked(e.target.checked ? new Set(data?.users.map((u) => u.id)) : new Set())}
                />
              </th>
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Joined</th>
              <th className="px-3 py-2 font-medium">Last active</th>
              <th className="px-3 py-2 font-medium">Workspaces</th>
              <th className="px-3 py-2 font-medium">Storage</th>
              <th className="px-3 py-2 font-medium">Roles</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data?.users ?? []).map((u) => (
              <tr key={u.id} onClick={() => setSelected(u)} className="cursor-pointer border-t border-line hover:bg-hover">
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${u.name}`}
                    checked={picked.has(u.id)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        return next;
                      })
                    }
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Avatar name={u.name} color={u.color} size={26} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{u.name}</div>
                      <div className="truncate text-xs text-muted">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-muted">{when(u.createdAt)}</td>
                <td className="px-3 py-2 text-muted">{when(u.lastSeenAt)}</td>
                <td className="px-3 py-2 text-muted">
                  {u.workspaces}
                  {u.limits.workspaces !== null && <span className="text-faint"> · owns {u.ownedWorkspaces} of {u.limits.workspaces}</span>}
                </td>
                <td className="px-3 py-2 text-muted">
                  {bytes(u.storage)}
                  {u.limits.storageMb !== null && <span className="text-faint"> of {limitText('storageMb', u.limits.storageMb)}</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(u.roleIds ?? []).map((id) => roleName(id)).filter(Boolean).map((n) => (
                      <span key={n} className="rounded-md bg-accent/10 px-1.5 py-0.5 text-xs whitespace-nowrap text-accent">{n}</span>
                    ))}
                    {!(u.roleIds ?? []).length && <span className="text-xs text-faint">Everyone</span>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {u.disabled ? (
                    <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs whitespace-nowrap text-red-500">Switched off</span>
                  ) : (
                    <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs whitespace-nowrap text-green-600">Active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.users.length === 0 && <p className="p-4 text-sm text-muted">No accounts found.</p>}
      </div>
      {data?.more && <p className="mt-2 text-xs text-muted">Showing the 50 newest matches. Search to narrow it down.</p>}
      {selected && (
        <AccountDialog
          user={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void refetch();
          }}
        />
      )}
      {bulkRoles && (
        <AssignRolesDialog
          userIds={[...picked]}
          label={`${picked.size} ${picked.size === 1 ? 'person' : 'people'}`}
          current={(data?.users ?? []).filter((u) => picked.has(u.id)).map((u) => u.roleIds ?? [])}
          onClose={() => setBulkRoles(false)}
          onSaved={() => {
            void refetch();
            void roles.refetch();
          }}
        />
      )}
      {bulk && (
        <PeopleLimitsDialog
          userIds={[...picked]}
          label={`${picked.size} ${picked.size === 1 ? 'person' : 'people'}`}
          onClose={() => setBulk(false)}
          onSaved={() => {
            setPicked(new Set());
            void refetch();
          }}
        />
      )}
      {creating && (
        <CreateAccount
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refetch();
          }}
        />
      )}
    </>
  );
}

function CreateAccount({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await adminApi('/users', { method: 'POST', body: { name, email, password: password || null } });
      toast(`Account made for ${email}`);
      onCreated();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} width={440}>
      <form onSubmit={submit} className="space-y-3 p-5">
        <h3 className="text-lg font-semibold">New account</h3>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Email</span>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Password (leave empty if they'll sign in with email codes)</span>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !email.trim()}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AccountDialog({ user, onClose, onChanged }: { user: AdminUser; onClose: () => void; onChanged: () => void }) {
  const { data, refetch } = useQuery({
    queryKey: ['admin', 'user', user.id],
    queryFn: () =>
      adminApi<{
        user: { name: string; email: string; createdAt: string; lastSeenAt: string | null; verified: boolean; disabled: boolean; hasPassword: boolean };
        workspaces: { id: string; name: string; icon: string; role: string; members: number; pages: number }[];
        ai: { own: { provider: string; model: string } | null; source: string | null };
        limits: Effective;
        ownLimits: Limits;
        roleIds: string[];
        usage: { workspaces: number; storageBytes: number; aiRequestsToday: number; aiRequestsMonth: number; aiTokensToday: number; aiTokensMonth: number };
      }>(`/users/${user.id}`),
  });
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [editLimits, setEditLimits] = useState(false);
  const [editRoles, setEditRoles] = useState(false);
  const roles = useRoles();
  const u = data?.user ?? user;

  const patch = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await adminApi(`/users/${user.id}`, { method: 'PATCH', body });
      toast(done);
      await refetch();
      onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${user.name}'s account?`,
      message: 'Workspaces only they belong to are deleted too, with their pages and files. In shared workspaces, someone else becomes an owner if needed. This cannot be undone.',
      confirmLabel: 'Delete account',
      danger: true,
    });
    if (!ok) return;
    try {
      await adminApi(`/users/${user.id}`, { method: 'DELETE' });
      toast('Account deleted');
      onChanged();
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Dialog open onClose={onClose} width={560} top="6vh" maxHeight="88vh">
      <div className="space-y-5 overflow-y-auto p-5">
        <div className="flex items-center gap-3">
          <Avatar name={user.name} color={user.color} size={36} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-lg font-semibold">{u.name}</h3>
            <p className="truncate text-sm text-muted">
              Joined {when(u.createdAt)} · last active {when(u.lastSeenAt)} · email {u.verified ? 'confirmed' : 'not confirmed'}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Email</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        {(name !== u.name || email !== u.email) && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => patch({ name, email }, 'Saved')}>
            Save name and email
          </Button>
        )}

        <div>
          <span className="mb-1 block text-xs text-muted">{u.hasPassword ? 'Set a new password' : 'Give them a password (they sign in with email codes now)'}</span>
          <div className="flex gap-2">
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
            <Button disabled={busy || password.length < 8} onClick={() => patch({ password }, 'Password changed').then(() => setPassword(''))}>
              Set
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {u.disabled ? (
            <Button variant="primary" disabled={busy} onClick={() => patch({ disabled: false }, 'Account switched back on')}>
              Switch account on
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => patch({ disabled: true }, 'Account switched off — they are signed out everywhere')}>
              Switch account off
            </Button>
          )}
          {!u.verified && (
            <Button disabled={busy} onClick={() => patch({ verified: true }, 'Email marked as confirmed')}>
              Mark email as confirmed
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="danger" onClick={remove}>
            Delete account
          </Button>
        </div>

        <div>
          <div className="mb-1 flex items-center text-xs font-medium text-faint">
            <span className="flex-1">Roles</span>
            <button onClick={() => setEditRoles(true)} disabled={!data} className="text-accent hover:underline disabled:opacity-50">
              Change
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 text-sm">
            <span className="rounded-md bg-hover px-2 py-0.5 text-xs text-muted">Everyone</span>
            {(data?.roleIds ?? []).map((id) => (
              <span key={id} className="rounded-md bg-accent/10 px-2 py-0.5 text-xs text-accent">
                {roles.data?.roles.find((r) => r.id === id)?.name ?? '…'}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center text-xs font-medium text-faint">
            <span className="flex-1">Limits</span>
            <button onClick={() => setEditLimits(true)} disabled={!data} className="text-accent hover:underline disabled:opacity-50">
              Change
            </button>
          </div>
          {!data ? (
            <Spinner />
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line p-3 text-sm sm:grid-cols-3">
              <span className="text-muted">Owns</span>
              <span className="sm:col-span-2">
                {data.usage.workspaces} of {limitText('workspaces', data.limits.workspaces)} workspaces
              </span>
              <span className="text-muted">Storage</span>
              <span className="sm:col-span-2">
                {bytes(data.usage.storageBytes)} of {limitText('storageMb', data.limits.storageMb)}
              </span>
              <span className="text-muted">Largest file</span>
              <span className="sm:col-span-2">{limitText('uploadMb', data.limits.uploadMb)}</span>
              <span className="text-muted">People per workspace</span>
              <span className="sm:col-span-2">{limitText('members', data.limits.members)}</span>
              <span className="text-muted">AI requests today</span>
              <span className="sm:col-span-2">
                {data.usage.aiRequestsToday} of {limitText('aiRequestsPerDay', data.limits.aiRequestsPerDay)}
              </span>
              <span className="text-muted">AI requests this month</span>
              <span className="sm:col-span-2">
                {data.usage.aiRequestsMonth} of {limitText('aiRequestsPerMonth', data.limits.aiRequestsPerMonth)}
              </span>
              <span className="text-muted">AI tokens today</span>
              <span className="sm:col-span-2">
                {tokens(data.usage.aiTokensToday)} of {limitText('aiTokensPerDay', data.limits.aiTokensPerDay)}
              </span>
              <span className="text-muted">AI tokens this month</span>
              <span className="sm:col-span-2">
                {tokens(data.usage.aiTokensMonth)} of {limitText('aiTokensPerMonth', data.limits.aiTokensPerMonth)}
              </span>
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-faint">Workspaces</div>
          {!data ? (
            <Spinner />
          ) : data.workspaces.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <div className="divide-y divide-line rounded-lg border border-line">
              {data.workspaces.map((w) => (
                <div key={w.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span>{w.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  <span className="text-xs text-muted">
                    {w.role} · {w.members} member{w.members === 1 ? '' : 's'} · {w.pages} pages
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        {data?.ai.own && (
          <p className="text-xs text-muted">
            Uses their own AI key ({data.ai.own.provider}, {data.ai.own.model}){data.ai.source === 'shared' ? ', but the server’s connection is in use' : ''}.
          </p>
        )}
      </div>
      {editRoles && data && (
        <AssignRolesDialog
          userIds={[user.id]}
          label={u.name}
          current={[data.roleIds ?? []]}
          onClose={() => setEditRoles(false)}
          onSaved={() => {
            void refetch();
            void roles.refetch();
            onChanged();
          }}
        />
      )}
      {editLimits && data && (
        <PeopleLimitsDialog
          userIds={[user.id]}
          label={u.name}
          own={data.ownLimits}
          usage={data.usage}
          onClose={() => setEditLimits(false)}
          onSaved={() => {
            void refetch();
            onChanged();
          }}
        />
      )}
    </Dialog>
  );
}

// ---------- workspaces ----------

function Workspaces() {
  const { data, refetch } = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: () =>
      adminApi<{ workspaces: { id: string; name: string; icon: string; createdAt: string; members: number; pages: number; storage: number; owners: string | null }[] }>('/workspaces'),
  });
  const remove = async (w: { id: string; name: string }) => {
    const ok = await confirmDialog({ title: `Delete “${w.name}”?`, message: 'All its pages, files and whiteboards are deleted for everyone. This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await adminApi(`/workspaces/${w.id}`, { method: 'DELETE' });
      toast('Workspace deleted');
      void refetch();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <>
      <Heading title="Workspaces" description="Every workspace on this server." />
      {!data && <Spinner />}
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="bg-hover/50 text-start text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 font-medium">Owners</th>
              <th className="px-3 py-2 font-medium">Members</th>
              <th className="px-3 py-2 font-medium">Pages</th>
              <th className="px-3 py-2 font-medium">Storage</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(data?.workspaces ?? []).map((w) => (
              <tr key={w.id} className="border-t border-line">
                <td className="px-3 py-2">
                  <span className="me-1.5">{w.icon}</span>
                  {w.name}
                  <div className="text-xs text-muted">Created {when(w.createdAt)}</div>
                </td>
                <td className="px-3 py-2 text-muted">{w.owners ?? '—'}</td>
                <td className="px-3 py-2 text-muted">{w.members}</td>
                <td className="px-3 py-2 text-muted">{w.pages}</td>
                <td className="px-3 py-2 text-muted">{bytes(w.storage)}</td>
                <td className="px-3 py-2 text-end">
                  <Button size="sm" variant="ghost" onClick={() => remove(w)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- AI ----------

type Provider = 'anthropic' | 'openai' | 'gemini';
const PROVIDER_NAMES: Record<Provider, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI or compatible', gemini: 'Google Gemini' };
const DEFAULT_MODELS: Record<Provider, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-5', gemini: 'gemini-2.5-pro' };

interface Settings {
  allowSignups: boolean;
  passwordFromEnv: boolean;
  ai: { provider: Provider; model: string; baseUrl: string | null; keyHint: string | null; allowOwn: boolean } | null;
}

function useSettings() {
  return useQuery({ queryKey: ['admin', 'settings'], queryFn: () => adminApi<Settings>('/settings') });
}

function AiSettings() {
  const { data, refetch } = useSettings();
  const ai = data?.ai ?? null;
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(DEFAULT_MODELS.anthropic);
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [allowOwn, setAllowOwn] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!ai) return;
    setProvider(ai.provider);
    setModel(ai.model);
    setBaseUrl(ai.baseUrl ?? '');
    setAllowOwn(ai.allowOwn);
  }, [ai?.provider, ai?.model, ai?.baseUrl, ai?.allowOwn]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    return run('save', async () => {
      const same = ai?.provider === provider;
      await adminApi('/settings/ai', { method: 'PUT', body: { provider, model, baseUrl: provider === 'anthropic' ? null : baseUrl || null, key: key ? key : same ? undefined : '', allowOwn } });
      setKey('');
      toast('AI connection saved');
      await refetch();
    });
  };

  const field = 'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-accent';

  return (
    <>
      <Heading
        title="AI for everyone"
        description="Give everyone on this server the AI assistant through one connection. Without one, people can still add their own API key in the app."
      />
      {!data ? (
        <Spinner />
      ) : (
        <form onSubmit={save} className="max-w-xl space-y-4">
          {ai ? (
            <div className="rounded-lg bg-green-500/10 px-3 py-2 text-sm">
              Everyone can use <b>{ai.model}</b> ({PROVIDER_NAMES[ai.provider]}){ai.keyHint ? ` with the key ${ai.keyHint}` : ''}.
            </div>
          ) : (
            <div className="rounded-lg bg-hover/60 px-3 py-2 text-sm text-muted">Not set up — people use their own API keys.</div>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Provider</span>
            <select
              value={provider}
              onChange={(e) => {
                const p = e.target.value as Provider;
                setProvider(p);
                setModels([]);
                setModel(ai?.provider === p ? ai.model : DEFAULT_MODELS[p]);
                setBaseUrl(ai?.provider === p ? (ai.baseUrl ?? '') : '');
              }}
              className={field}
            >
              {(Object.keys(PROVIDER_NAMES) as Provider[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_NAMES[p]}
                </option>
              ))}
            </select>
          </label>
          {provider === 'openai' && (
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Address (empty for OpenAI; or e.g. https://openrouter.ai/api/v1, http://ollama:11434/v1)</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className={field} />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-muted">API key</span>
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={ai?.provider === provider && ai.keyHint ? `Saved: ${ai.keyHint} — type to replace` : 'Paste the key'}
              className={field}
            />
          </label>
          <label className="block">
            <span className="mb-1 flex text-xs text-muted">
              <span className="flex-1">Model</span>
              <button
                type="button"
                disabled={busy === 'models'}
                onClick={() =>
                  run('models', async () => {
                    const r = await adminApi<{ models: string[] }>('/ai/models', { method: 'POST', body: { provider, baseUrl: baseUrl || null, key: key || undefined } });
                    setModels(r.models);
                    toast(`${r.models.length} models available`);
                  })
                }
                className="text-accent hover:underline disabled:opacity-50"
              >
                {busy === 'models' ? 'Loading…' : 'List available models'}
              </button>
            </span>
            <input list="admin-ai-models" value={model} onChange={(e) => setModel(e.target.value)} className={field} />
            <datalist id="admin-ai-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          {ai && (
            <label className="flex items-start gap-3 rounded-lg border border-line p-3">
              <input type="checkbox" checked={allowOwn} onChange={(e) => setAllowOwn(e.target.checked)} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">Let people use their own API key instead</span>
                <span className="block text-xs text-muted">When off, everyone uses this connection and the app hides the option to add a key.</span>
              </span>
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!model.trim()}>
              {ai ? 'Save' : 'Turn on AI for everyone'}
            </Button>
            {ai && (
              <>
                <Button
                  type="button"
                  loading={busy === 'test'}
                  onClick={() =>
                    run('test', async () => {
                      const r = await adminApi<{ answer: string }>('/ai/test', { method: 'POST' });
                      toast(`It works — the model replied “${r.answer.trim().slice(0, 60)}”`);
                    })
                  }
                >
                  Test it
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirmDialog({ title: 'Stop offering AI to everyone?', message: 'People can still use their own API keys.', confirmLabel: 'Turn off', danger: true }))) return;
                    await run('remove', async () => {
                      await adminApi('/settings/ai', { method: 'DELETE' });
                      toast('Turned off');
                      await refetch();
                    });
                  }}
                >
                  Turn off
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted">The key is stored encrypted and never sent to people's browsers. Requests from everyone are billed to this key.</p>
        </form>
      )}
    </>
  );
}

// ---------- sign-ups & security ----------

function Security() {
  const { data, refetch } = useSettings();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleSignups = async (allowSignups: boolean) => {
    try {
      await adminApi('/settings/signups', { method: 'PUT', body: { allowSignups } });
      toast(allowSignups ? 'Anyone can now create an account' : 'New accounts now need an invitation');
      await refetch();
    } catch (err) {
      toastError(err);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await adminApi('/password', { method: 'PUT', body: { current, next } });
      setCurrent('');
      setNext('');
      toast('Admin password changed');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Heading title="Sign-ups & security" />
      {!data ? (
        <Spinner />
      ) : (
        <div className="max-w-xl space-y-8">
          <label className="flex items-start gap-3 rounded-lg border border-line p-3">
            <input type="checkbox" checked={data.allowSignups} onChange={(e) => toggleSignups(e.target.checked)} className="mt-1" />
            <span>
              <span className="block text-sm font-medium">Anyone can create an account</span>
              <span className="block text-xs text-muted">When off, only people invited to a workspace (and accounts you make here) can sign up.</span>
            </span>
          </label>

          <form onSubmit={changePassword} className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound size={15} /> Admin password
            </h3>
            {data.passwordFromEnv ? (
              <p className="text-sm text-muted">The password is set with ADMIN_PASSWORD in the server's settings. Change it there.</p>
            ) : (
              <>
                <Input type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
                <Input type="password" autoComplete="new-password" placeholder="New password (at least 10 characters)" value={next} onChange={(e) => setNext(e.target.value)} />
                <Button type="submit" variant="primary" loading={busy} disabled={!current || next.length < 10}>
                  Change password
                </Button>
              </>
            )}
          </form>

          <p className="text-xs text-muted">
            This panel runs on its own port. Keep that port private — by default the Docker setup only opens it on the server itself (use an SSH tunnel or
            a VPN to reach it from elsewhere).
          </p>
        </div>
      )}
    </>
  );
}
