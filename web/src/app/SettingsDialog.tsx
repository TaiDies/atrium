import { ApiTab } from './ApiSettings';
import { NotificationsTab } from './NotificationSettings';
import { language, LANGUAGES, setLanguage } from '../i18n';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bell, Building2, KeyRound, Monitor, Moon, Palette, Sun, User as UserIcon, Users, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { EmojiPicker } from '../components/EmojiPicker';
import { type Anchor, Avatar, Button, confirmDialog, Dialog, IconButton, Input, toast, toastError } from '../components/ui';
import { api, type Role, type User } from '../lib/api';
import { forgetServer, isNativeApp, loadNative, nativeInfo } from '../lib/native';
import { keys, queryClient, useMembers } from '../lib/queries';
import { ACCENT_PRESETS, COLOR_THEMES, DENSITIES, FONTS, PAGE_WIDTHS, TEXT_SIZES, useTheme, CUSTOM_COLORS, type CustomColors, setCustomColor, setCustomColors } from '../lib/theme';
import { type SettingsTab, useApp } from './context';
import { ExportContents } from './ExportDialog';
import { WorkspaceIcon } from './Sidebar';

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'account', label: 'My account', icon: <UserIcon size={15} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={15} /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell size={15} /> },
  { id: 'workspace', label: 'Workspace', icon: <Building2 size={15} /> },
  { id: 'members', label: 'Members', icon: <Users size={15} /> },
  { id: 'api', label: 'API & webhooks', icon: <KeyRound size={15} /> },
];

export function SettingsDialog({ tab, onTabChange, onClose }: { tab: SettingsTab | null; onTabChange: (t: SettingsTab) => void; onClose: () => void }) {
  return (
    <Dialog open={!!tab} onClose={onClose} width={860} top="4vh" maxHeight="92vh" className="h-[640px] max-sm:h-[92vh]">
      <div className="flex h-full flex-col sm:flex-row">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-sidebar p-2 sm:block sm:w-[200px] sm:border-e sm:border-b-0">
          <div className="hidden px-2 pt-2 pb-3 text-xs font-medium text-faint sm:block">Settings</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              className={clsx(
                'flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-start text-sm whitespace-nowrap sm:w-full',
                tab === t.id ? 'bg-active font-medium' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 overflow-y-auto p-5 sm:p-8">
          <IconButton onClick={onClose} className="absolute top-3 end-3" aria-label="Close">
            <X size={16} />
          </IconButton>
          {tab === 'account' && <AccountTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'workspace' && <WorkspaceTab onClose={onClose} />}
          {tab === 'members' && <MembersTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'api' && <ApiTab />}
        </div>
      </div>
    </Dialog>
  );
}

function Heading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
    </div>
  );
}

function Row({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function AccountTab() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { user: updated } = await api<{ user: User }>('/api/auth/me', { method: 'PATCH', body: { name } });
      queryClient.setQueryData(keys.me, updated);
      toast('Name updated');
    } catch (err) {
      toastError(err);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/auth/password', { method: 'POST', body: pw });
      setPw({ currentPassword: '', newPassword: '' });
      toast('Password changed');
    } catch (err) {
      toastError(err);
    }
  };

  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    await loadNative();
    queryClient.clear();
    queryClient.setQueryData(keys.me, null);
    navigate('/login', { replace: true });
  };

  return (
    <div>
      <Heading title="My account" />
      <div className="mb-6 flex items-center gap-4">
        <Avatar name={user.name} color={user.color} size={56} />
        <div>
          <div className="font-medium">{user.name}</div>
          <div className="text-sm text-muted">{user.email}</div>
        </div>
      </div>
      <form onSubmit={saveName}>
        <Row label="Display name" description="Shown to collaborators on cursors and avatars.">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="w-56" required />
            <Button type="submit" disabled={name.trim() === user.name}>
              Save
            </Button>
          </div>
        </Row>
      </form>
      <form onSubmit={changePassword}>
        <Row label="Password" description="Use at least 8 characters.">
          <div className="flex flex-col gap-2 sm:w-56">
            <Input
              type="password"
              placeholder="Current password"
              autoComplete="current-password"
              value={pw.currentPassword}
              onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
              required
            />
            <Input
              type="password"
              placeholder="New password"
              autoComplete="new-password"
              minLength={8}
              value={pw.newPassword}
              onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
              required
            />
            <Button type="submit">Change password</Button>
          </div>
        </Row>
      </form>
      <UsageRow />
      <DigestRow />
      <Row label="Sign out" description={isNativeApp() ? "Sign out on this device." : "Sign out of this browser."}>
        <Button onClick={signOut}>Sign out</Button>
      </Row>
      {isNativeApp() && (
        <Row label="Server" description={nativeInfo()?.server ?? ''}>
          <Button
            onClick={async () => {
              await forgetServer();
              location.replace('/');
            }}
          >
            Change server
          </Button>
        </Row>
      )}
    </div>
  );
}

function AppearanceTab() {
  const t = useTheme();
  const options = [
    { id: 'light' as const, label: 'Light', icon: <Sun size={18} /> },
    { id: 'dark' as const, label: 'Dark', icon: <Moon size={18} /> },
    { id: 'system' as const, label: 'System', icon: <Monitor size={18} /> },
  ];
  return (
    <div>
      <Heading title="Appearance" description="Choose how the app looks — saved with your account, on every device." />
      <ThemeSection title="Language">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              data-no-translate
              onClick={() => l.code !== language().code && setLanguage(l.code)}
              className={clsx('rounded-lg border px-3 py-2.5 text-sm', l.code === language().code ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-line hover:bg-hover')}
            >
              {l.name}
            </button>
          ))}
        </div>
      </ThemeSection>
      <ThemeSection title="Mode">
        <div className="grid grid-cols-3 gap-3">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => t.setPref(o.id)}
              className={clsx(
                'flex flex-col items-center gap-2 rounded-xl border p-4 text-sm font-medium transition-colors',
                t.pref === o.id ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover',
              )}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>
      </ThemeSection>
      <ThemeSection title="Theme">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {COLOR_THEMES.map((c) => (
            <button
              key={c.id}
              onClick={() => t.setColor(c.id)}
              className={clsx(
                'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-start text-sm transition-colors',
                t.color === c.id ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover',
              )}
            >
              <span
                className="relative size-4 shrink-0 overflow-hidden rounded-full ring-1 ring-line"
                style={{ background: c.surface ? `linear-gradient(135deg, ${c.surface[0]} 50%, ${c.surface[1]} 50%)` : c.swatch }}
              >
                {c.surface && <span className="absolute inset-[4px] rounded-full" style={{ background: c.swatch }} />}
              </span>
              <span className="truncate">{c.label}</span>
            </button>
          ))}
        </div>
      </ThemeSection>
      <ThemeSection title="Accent color" description="Overrides the theme's accent on buttons, links and highlights.">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => t.set('accent', '')}
            className={clsx('h-8 rounded-full border px-3 text-xs', !t.accent ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover')}
          >
            Theme
          </button>
          {ACCENT_PRESETS.map((hex) => (
            <button
              key={hex}
              onClick={() => t.set('accent', hex)}
              aria-label={`Accent ${hex}`}
              className={clsx('size-8 rounded-full ring-offset-2 ring-offset-surface', t.accent === hex ? 'ring-2 ring-fg' : 'hover:ring-2 hover:ring-line')}
              style={{ background: hex }}
            />
          ))}
          <label
            className={clsx(
              'relative flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-line ring-offset-2 ring-offset-surface',
              t.accent && !ACCENT_PRESETS.includes(t.accent) && 'ring-2 ring-fg',
            )}
            title="Pick any color"
            style={{ background: t.accent && !ACCENT_PRESETS.includes(t.accent) ? t.accent : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}
          >
            <input
              type="color"
              value={t.accent || '#7c5cff'}
              onChange={(e) => t.set('accent', e.target.value.toLowerCase())}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      </ThemeSection>
      <ThemeSection title="Font">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FONTS.map((f) => (
            <button
              key={f.id}
              onClick={() => t.setFont(f.id)}
              className={clsx('rounded-lg border px-3 py-3 text-center transition-colors', t.font === f.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}
            >
              <span className="block text-2xl" style={{ fontFamily: f.sample }}>
                Ag
              </span>
              <span className="text-xs text-muted">{f.label}</span>
            </button>
          ))}
        </div>
      </ThemeSection>
      <ThemeSection title="Text size">
        <Segmented value={t.size} options={TEXT_SIZES} onChange={(v) => t.set('size', v)} />
      </ThemeSection>
      <ThemeSection title="Page width" description="How wide documents are on large screens.">
        <Segmented value={t.width} options={PAGE_WIDTHS} onChange={(v) => t.set('width', v)} />
      </ThemeSection>
      <ThemeSection title="Spacing" description="Compact puts blocks in documents closer together.">
        <Segmented value={t.density} options={DENSITIES} onChange={(v) => t.set('density', v)} />
      </ThemeSection>
      <CustomColorsSection mode={t.resolved} colors={t.colors[t.resolved]} all={t.colors} />
      <Button variant="ghost" onClick={t.reset}>
        Reset to defaults
      </Button>
    </div>
  );
}

/** Every colour of the app, one by one, for the mode in use (light and dark are kept apart). */
function CustomColorsSection({ mode, colors, all }: { mode: 'light' | 'dark'; colors: Record<string, string>; all: CustomColors }) {
  const current = (key: string) => {
    if (colors[key]) return colors[key];
    // The theme's own colour, as a starting point for the picker.
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--${key}`).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
    return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '#888888';
  };
  const count = Object.keys(colors).length;
  return (
    <ThemeSection
      title="Your own colours"
      description={`Change any colour of the app. These apply in ${mode} mode; switch to ${mode === 'dark' ? 'light' : 'dark'} mode to set those separately.`}
    >
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {CUSTOM_COLORS.map((c) => (
          <label key={c.key} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover" title={c.hint}>
            <input
              type="color"
              value={current(c.key)}
              onChange={(e) => setCustomColor(mode, c.key, e.target.value)}
              className="size-7 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{c.label}</span>
              <span className="block truncate text-[11px] text-faint">{colors[c.key] ? colors[c.key] : 'From the theme'}</span>
            </span>
            {colors[c.key] && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setCustomColor(mode, c.key, '');
                }}
                className="rounded px-1.5 text-xs text-muted hover:text-fg"
              >
                Reset
              </button>
            )}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {count > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setCustomColors({ ...all, [mode]: {} })}>
            Reset {mode} colours
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(all));
              toast('Your colours were copied — paste them on another device or send them to someone');
            } catch {
              toast('Could not copy', 'error');
            }
          }}
        >
          Copy my colours
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              const v = JSON.parse(await navigator.clipboard.readText());
              if (!v || typeof v !== 'object' || (!v.light && !v.dark)) throw new Error();
              setCustomColors({ light: v.light ?? {}, dark: v.dark ?? {} });
              toast('Colours applied');
            } catch {
              toast('Copy someone’s colours first (Copy my colours), then paste them here', 'error');
            }
          }}
        >
          Paste colours
        </Button>
      </div>
    </ThemeSection>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex max-w-full rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={clsx('h-8 rounded-md px-3 text-sm whitespace-nowrap transition-colors', value === o.id ? 'bg-active font-medium' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ThemeSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <div className={clsx('text-sm font-medium', description ? 'mb-0.5' : 'mb-2')}>{title}</div>
      {description && <div className="mb-2 text-xs text-muted">{description}</div>}
      {children}
    </div>
  );
}

function WorkspaceTab({ onClose }: { onClose: () => void }) {
  const { workspace, user } = useApp();
  const navigate = useNavigate();
  const isOwner = workspace.role === 'owner';
  const [name, setName] = useState(workspace.name);
  const [picker, setPicker] = useState<Anchor | null>(null);

  useEffect(() => setName(workspace.name), [workspace.name]);

  const save = async (patch: { name?: string; icon?: string }) => {
    try {
      await api(`/api/workspaces/${workspace.id}`, { method: 'PATCH', body: patch });
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      toast('Workspace updated');
    } catch (err) {
      toastError(err);
    }
  };

  const leaveOrDelete = async () => {
    const ok = await confirmDialog(
      isOwner
        ? { title: `Delete “${workspace.name}”?`, message: 'All pages, boards and files in this workspace will be permanently deleted for everyone.', confirmLabel: 'Delete workspace', danger: true }
        : { title: `Leave “${workspace.name}”?`, message: "You'll lose access until someone invites you again.", confirmLabel: 'Leave', danger: true },
    );
    if (!ok) return;
    try {
      if (isOwner) await api(`/api/workspaces/${workspace.id}`, { method: 'DELETE' });
      else await api(`/api/workspaces/${workspace.id}/members/${user.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      onClose();
      navigate('/', { replace: true });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div>
      <Heading title="Workspace" description={isOwner ? undefined : 'Only workspace owners can change these settings.'} />
      <Row label="Icon">
        <button
          disabled={!isOwner}
          onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}
          className="rounded-md p-1 hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
        >
          <WorkspaceIcon workspace={workspace} size={36} />
        </button>
      </Row>
      <Row label="Name">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save({ name });
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} className="w-56" required />
          {isOwner && (
            <Button type="submit" disabled={name.trim() === workspace.name}>
              Save
            </Button>
          )}
        </form>
      </Row>
      {isOwner && (
        <Row label="Export workspace" description={<ExportContents />}>
          <a
            href={`/api/workspaces/${workspace.id}/export`}
            download
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-hover"
          >
            Export everything
          </a>
        </Row>
      )}
      <Row
        label={isOwner ? 'Delete workspace' : 'Leave workspace'}
        description={isOwner ? 'Permanently delete this workspace and everything in it.' : 'Remove yourself from this workspace.'}
      >
        <Button variant="danger" onClick={leaveOrDelete}>
          {isOwner ? 'Delete workspace' : 'Leave workspace'}
        </Button>
      </Row>
      <EmojiPicker anchor={picker} onClose={() => setPicker(null)} onPick={(icon) => save({ icon })} onRemove={() => save({ icon: '' })} />
    </div>
  );
}

function MembersTab() {
  const { workspace, user } = useApp();
  const members = useMembers(workspace.id);
  const isOwner = workspace.role === 'owner';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [inviting, setInviting] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: keys.members(workspace.id) });
    queryClient.invalidateQueries({ queryKey: keys.workspaces });
  };

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setInviting(true);
    try {
      const { hasAccount } = await api<{ status: 'invited'; hasAccount: boolean }>(`/api/workspaces/${workspace.id}/members`, {
        method: 'POST',
        body: { email, role },
      });
      toast(hasAccount ? `Invitation sent — ${email} joins once they accept it` : `Invitation saved — ${email} can accept it after signing up`);
      setEmail('');
      refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (userId: string, next: Role) => {
    try {
      await api(`/api/workspaces/${workspace.id}/members/${userId}`, { method: 'PATCH', body: { role: next } });
      refresh();
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async (userId: string, name: string) => {
    if (!(await confirmDialog({ title: `Remove ${name}?`, message: 'They will lose access to every page in this workspace.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api(`/api/workspaces/${workspace.id}/members/${userId}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      toastError(err);
    }
  };

  const revoke = async (inviteEmail: string) => {
    try {
      await api(`/api/workspaces/${workspace.id}/invites/${encodeURIComponent(inviteEmail)}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div>
      <Heading title="Members" description="Unlimited members — invite as many people as you like." />
      {isOwner && (
        <form onSubmit={invite} className="mb-6 flex gap-2">
          <Input type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="h-9 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
          >
            <option value="member">Member</option>
            <option value="owner">Owner</option>
          </select>
          <Button type="submit" variant="primary" loading={inviting}>
            Invite
          </Button>
        </form>
      )}

      <div className="text-xs font-medium text-faint">
        {members.data?.members.length ?? 0} {members.data?.members.length === 1 ? 'member' : 'members'}
      </div>
      <div className="mt-2 divide-y divide-line">
        {members.data?.members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 py-3">
            <Avatar name={m.name} color={m.color} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {m.name} {m.id === user.id && <span className="font-normal text-faint">(you)</span>}
              </div>
              <div className="truncate text-xs text-muted">{m.email}</div>
            </div>
            {isOwner ? (
              <select
                value={m.role}
                onChange={(e) => changeRole(m.id, e.target.value as Role)}
                className="h-8 rounded-md border border-line bg-bg px-2 text-sm outline-none"
              >
                <option value="owner">Owner</option>
                <option value="member">Member</option>
              </select>
            ) : (
              <span className="text-sm text-muted capitalize">{m.role}</span>
            )}
            {isOwner && m.id !== user.id && (
              <IconButton onClick={() => remove(m.id, m.name)} title="Remove" className="hover:text-danger">
                <X size={15} />
              </IconButton>
            )}
          </div>
        ))}
      </div>

      {!!members.data?.invites.length && (
        <>
          <div className="mt-6 text-xs font-medium text-faint">Pending invites</div>
          <div className="mt-2 divide-y divide-line">
            {members.data.invites.map((i) => (
              <div key={i.email} className="flex items-center gap-3 py-3">
                <span className="flex size-8 items-center justify-center rounded-full border border-dashed border-faint text-xs text-muted">?</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{i.email}</div>
                  <div className="text-xs text-muted">Waiting for them to accept · joins as {i.role}</div>
                </div>
                {isOwner && (
                  <Button size="sm" variant="ghost" onClick={() => revoke(i.email)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** What this person uses of the limits the administrator set (or "no limit" where there isn't one). */
function UsageRow() {
  const { data } = useQuery({
    queryKey: ['my-usage'],
    queryFn: () =>
      api<{
        limits: Record<'workspaces' | 'storageMb' | 'uploadMb' | 'members' | 'aiTokensPerDay' | 'aiTokensPerMonth', number | null>;
        usage: { workspaces: number; storageBytes: number; aiTokensToday: number; aiTokensMonth: number; owned: { id: string; name: string; people: number }[] };
      }>('/api/auth/me/usage'),
  });
  if (!data) return null;
  const { limits, usage } = data;
  const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : n < 10 ? `${n.toFixed(1)} MB` : `${Math.round(n)} MB`);
  const used = usage.storageBytes / 1024 / 1024;
  const of = (amount: string, limit: number | null, unit: (n: number) => string = String) => (limit === null ? `${amount} · no limit` : `${amount} of ${unit(limit)}`);
  const share = (n: number, limit: number | null) => (limit === null ? null : limit ? n / limit : 1);
  const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const lines: { label: string; text: string; share: number | null }[] = [
    { label: 'Storage', text: of(mb(used), limits.storageMb, mb), share: share(used, limits.storageMb) },
    { label: 'Workspaces you own', text: of(String(usage.workspaces), limits.workspaces), share: share(usage.workspaces, limits.workspaces) },
    ...(usage.owned ?? []).map((w) => ({
      label: `People in ${w.name || 'Untitled'}`,
      text: of(String(w.people), limits.members),
      share: share(w.people, limits.members),
    })),
    ...(usage.owned?.length ? [] : [{ label: 'People per workspace', text: limits.members === null ? 'No limit' : `Up to ${limits.members}`, share: null }]),
    { label: 'AI tokens today', text: of(tok(usage.aiTokensToday), limits.aiTokensPerDay, tok), share: share(usage.aiTokensToday, limits.aiTokensPerDay) },
    { label: 'AI tokens this month', text: of(tok(usage.aiTokensMonth), limits.aiTokensPerMonth, tok), share: share(usage.aiTokensMonth, limits.aiTokensPerMonth) },
    { label: 'Largest file', text: limits.uploadMb === null ? 'Server maximum' : `Up to ${mb(limits.uploadMb)}`, share: null },
  ];
  return (
    <Row label="Usage" description="Your limits on this server (set by its administrator) and how much you've used.">
      <div className="space-y-2 sm:w-64">
        {lines.map((l) => (
          <div key={l.label}>
            <div className="flex justify-between text-sm">
              <span className="text-muted">{l.label}</span>
              <span>{l.text}</span>
            </div>
            {l.share !== null && (
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
                <div className={l.share >= 0.9 ? 'h-full bg-red-500' : 'h-full bg-accent'} style={{ width: `${Math.min(100, l.share * 100)}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </Row>
  );
}

/** The daily email summary: on or off, and when. */
function DigestRow() {
  const key = ['digest'];
  const state = useQuery({ queryKey: key, queryFn: () => api<{ digest: boolean; hour: number; mailEnabled: boolean }>('/api/auth/me/digest') });
  const d = state.data;
  if (!d) return null;
  const save = async (digest: boolean, hour: number) => {
    try {
      await api('/api/auth/me/digest', { method: 'PUT', body: { digest, hour } });
      queryClient.setQueryData(key, { ...d, digest, hour });
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="text-sm font-medium">Daily email</div>
      <p className="mb-2 text-xs text-muted">
        {d.mailEnabled ? 'A short email each morning with what’s due, what’s overdue, and mentions and comments waiting for you.' : 'Email isn’t set up on this server yet (the admin can add it in the admin panel).'}
      </p>
      <div className="flex items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!d.mailEnabled} checked={d.digest} onChange={(e) => save(e.target.checked, d.hour)} /> Send it to me
        </label>
        <select disabled={!d.digest} value={d.hour} onChange={(e) => save(true, Number(e.target.value))} className="h-8 rounded-md border border-line bg-bg px-1.5 text-sm">
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              at {String(h).padStart(2, '0')}:00
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
