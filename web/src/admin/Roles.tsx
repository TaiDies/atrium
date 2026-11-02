import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, confirmDialog, Dialog, Input, Spinner, toast, toastError } from '../components/ui';
import { adminApi } from './api';
import { LIMIT_INFO, type LimitKey, type Limits, limitText } from './LimitsAndMail';

// Roles: a role has permissions (and, if you like, limits that are more generous than the defaults);
// people get roles and with them the permissions. "Everyone" applies to every account — take a
// permission away from it and give it back through a role to allow it for only some people.

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  limits: Limits;
  isDefault: boolean;
  people: number;
}
interface PermissionInfo {
  key: string;
  label: string;
  help: string;
}

export function useRoles() {
  return useQuery({ queryKey: ['admin', 'roles'], queryFn: () => adminApi<{ roles: Role[]; permissions: PermissionInfo[] }>('/roles') });
}

function RoleEditor({ role, permissions, onDone }: { role: Role | null; permissions: PermissionInfo[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  // Limits: '' = this role says nothing; 'unlimited'; or a number.
  const [limits, setLimits] = useState<Record<LimitKey, string>>(() =>
    Object.fromEntries(LIMIT_INFO.map(({ key }) => {
      const v = role?.limits?.[key];
      return [key, v === undefined ? '' : v === null ? 'unlimited' : String(v)];
    })) as Record<LimitKey, string>,
  );
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const lim: Limits = {};
      for (const { key } of LIMIT_INFO) {
        const v = limits[key].trim();
        if (v === 'unlimited') lim[key] = null;
        else if (v !== '' && Number.isFinite(Number(v))) lim[key] = Math.max(0, Math.round(Number(v)));
      }
      const body = { name: name.trim(), description, permissions: [...perms], limits: lim };
      if (role) await adminApi(`/roles/${role.id}`, { method: 'PUT', body });
      else await adminApi('/roles', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
      toast('Role saved');
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onDone} title={role ? `Role: ${role.name}` : 'New role'} width={620} maxHeight="88vh">
      <div className="space-y-4 px-5 pb-5">
        {!role?.isDefault && <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Staff" autoFocus />}
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it's for (optional)" />
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Permissions</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {permissions.map((p) => (
              <label key={p.key} className={clsx('flex cursor-pointer gap-2.5 rounded-lg border p-2.5 text-sm', perms.has(p.key) ? 'border-accent bg-accent/5' : 'border-line')}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={perms.has(p.key)}
                  onChange={(e) => {
                    const next = new Set(perms);
                    if (e.target.checked) next.add(p.key);
                    else next.delete(p.key);
                    setPerms(next);
                  }}
                />
                <span>
                  <span className="block font-medium">{p.label}</span>
                  <span className="block text-xs text-muted">{p.help}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Limits (optional)</h3>
          <p className="mb-2 text-xs text-faint">Leave empty to use the server's defaults. Someone with several roles gets the most generous; limits set on a person still win.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {LIMIT_INFO.map((l) => (
              <label key={l.key} className="block text-sm">
                <span className="mb-0.5 block text-xs text-muted">
                  {l.label} ({l.unit})
                </span>
                <div className="flex gap-1.5">
                  <Input
                    value={limits[l.key] === 'unlimited' ? '' : limits[l.key]}
                    disabled={limits[l.key] === 'unlimited'}
                    onChange={(e) => setLimits({ ...limits, [l.key]: e.target.value.replace(/[^\d]/g, '') })}
                    placeholder="Default"
                    inputMode="numeric"
                    className="h-8 flex-1"
                  />
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input type="checkbox" checked={limits[l.key] === 'unlimited'} onChange={(e) => setLimits({ ...limits, [l.key]: e.target.checked ? 'unlimited' : '' })} />
                    No limit
                  </label>
                </div>
              </label>
            ))}
          </div>
        </section>
        <div className="flex justify-end gap-2">
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!role?.isDefault && !name.trim()}>
            Save role
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function RolesTab() {
  const roles = useRoles();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  if (!roles.data) return <Spinner />;
  const { permissions } = roles.data;
  const label = (k: string) => permissions.find((p) => p.key === k)?.label ?? k;
  const remove = async (r: Role) => {
    if (!(await confirmDialog({ title: `Delete the role “${r.name}”?`, message: `${r.people} ${r.people === 1 ? 'person loses' : 'people lose'} what it gives them.`, confirmLabel: 'Delete', danger: true }))) return;
    await adminApi(`/roles/${r.id}`, { method: 'DELETE' }).catch(toastError);
    void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
  };
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-muted">
          A role gives permissions (and optionally limits) to the people who have it. <b>Everyone</b> applies to all accounts; other roles add to it. Give roles to people in <b>Accounts</b>.
        </p>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> New role
        </Button>
      </div>
      {roles.data.roles.map((r) => (
        <div key={r.id} className="rounded-xl border border-line p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={17} className={r.isDefault ? 'text-muted' : 'text-accent'} />
            <span className="font-semibold">{r.name}</span>
            <span className="text-xs text-faint">{r.isDefault ? 'every account' : `${r.people} ${r.people === 1 ? 'person' : 'people'}`}</span>
            <span className="flex-1" />
            <Button size="sm" onClick={() => setEditing(r)}>
              Edit
            </Button>
            {!r.isDefault && (
              <button onClick={() => void remove(r)} title="Delete role" className="rounded p-1.5 text-faint hover:bg-hover hover:text-red-500">
                <Trash2 size={15} />
              </button>
            )}
          </div>
          {r.description && <p className="mt-1 text-sm text-muted">{r.description}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {r.permissions.length === 0 && <span className="text-xs text-faint">No permissions</span>}
            {r.permissions.map((p) => (
              <span key={p} className="rounded-md bg-accent/10 px-2 py-0.5 text-xs text-accent">
                {label(p)}
              </span>
            ))}
            {Object.entries(r.limits ?? {}).map(([k, v]) => (
              <span key={k} className="rounded-md bg-hover px-2 py-0.5 text-xs text-muted">
                {LIMIT_INFO.find((l) => l.key === k)?.label}: {limitText(k as LimitKey, v ?? null)}
              </span>
            ))}
          </div>
        </div>
      ))}
      {editing && <RoleEditor role={editing === 'new' ? null : editing} permissions={permissions} onDone={() => setEditing(null)} />}
    </div>
  );
}

/** Giving roles to (or taking them from) one or more people. */
export function AssignRolesDialog({ userIds, label, current, onClose, onSaved }: { userIds: string[]; label: string; current: string[][]; onClose: () => void; onSaved: () => void }) {
  const roles = useRoles();
  // Per role: everyone picked has it, nobody has it, or some do ('mixed' until changed).
  const [state, setState] = useState<Record<string, 'on' | 'off' | 'mixed'>>({});
  useEffect(() => {
    if (!roles.data) return;
    const s: Record<string, 'on' | 'off' | 'mixed'> = {};
    for (const r of roles.data.roles.filter((x) => !x.isDefault)) {
      const n = current.filter((ids) => ids.includes(r.id)).length;
      s[r.id] = n === 0 ? 'off' : n === current.length ? 'on' : 'mixed';
    }
    setState(s);
  }, [roles.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const add = Object.entries(state).filter(([, v]) => v === 'on').map(([k]) => k);
      const remove = Object.entries(state).filter(([, v]) => v === 'off').map(([k]) => k);
      await adminApi('/users/roles', { method: 'PUT', body: { userIds, add, remove } });
      toast(`Roles saved for ${label}`);
      onSaved();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const extra = roles.data?.roles.filter((r) => !r.isDefault) ?? [];
  return (
    <Dialog open onClose={onClose} title={`Roles for ${label}`} width={460}>
      <div className="space-y-3 px-5 pb-5">
        <p className="text-sm text-muted">Everyone always has the Everyone role. Tick the roles {userIds.length === 1 ? 'this person' : 'these people'} should have.</p>
        {extra.length === 0 && <p className="text-sm text-faint">No roles yet — make one in the Roles tab.</p>}
        {extra.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line p-2.5 text-sm">
            <input
              type="checkbox"
              checked={state[r.id] === 'on'}
              ref={(el) => {
                if (el) el.indeterminate = state[r.id] === 'mixed';
              }}
              onChange={(e) => setState({ ...state, [r.id]: e.target.checked ? 'on' : 'off' })}
            />
            <span className="flex-1">
              <span className="block font-medium">{r.name}</span>
              {r.description && <span className="block text-xs text-muted">{r.description}</span>}
            </span>
          </label>
        ))}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
