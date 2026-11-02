import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, confirmDialog, Dialog, Input, Spinner, toast, toastError } from '../components/ui';
import { adminApi, bytes } from './api';

// Admin panel: limits per person (or for everyone), and the email (SMTP) settings.

export type LimitKey = 'workspaces' | 'storageMb' | 'uploadMb' | 'members' | 'aiTokensPerDay' | 'aiTokensPerMonth';
export type Limits = Partial<Record<LimitKey, number | null>>;
export type Effective = Record<LimitKey, number | null>;

export const LIMIT_INFO: { key: LimitKey; label: string; unit: string; help: string }[] = [
  { key: 'workspaces', label: 'Workspaces they can own', unit: 'workspaces', help: 'Workspaces they create or own (being invited into others is not counted).' },
  { key: 'storageMb', label: 'Storage', unit: 'MB', help: 'Everything they upload — files, images, attachments and imports — added together.' },
  { key: 'uploadMb', label: 'Largest file', unit: 'MB', help: 'The biggest single upload (the server-wide MAX_UPLOAD_MB also applies).' },
  { key: 'members', label: 'People per workspace', unit: 'people', help: 'Members plus pending invitations, in workspaces they own.' },
  { key: 'aiTokensPerDay', label: 'AI tokens a day', unit: 'tokens', help: 'Tokens are what AI models charge for: the question, what it reads and the answer. A short question is a few hundred; a plan from long files can be tens of thousands. Only counted on the server’s AI connection, not with someone’s own key.' },
  { key: 'aiTokensPerMonth', label: 'AI tokens a month', unit: 'tokens', help: 'The same, for the calendar month (resets on the 1st).' },
];

/** 1234567 → 1.2M, 45000 → 45k. */
export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const limitText = (key: LimitKey, v: number | null) =>
  v === null ? 'Unlimited' : key === 'storageMb' || key === 'uploadMb' ? bytes(v * 1024 * 1024) : key.startsWith('aiTokens') ? `${tokens(v)} tokens` : String(v);

/** One limit's choice: unlimited, a number, or (for a person) the server's default. */
type Choice = { mode: 'unlimited' | 'value' | 'default' | 'keep'; value: string };

function LimitField({ info, choice, onChange, allowDefault, allowKeep, defaultValue }: { info: (typeof LIMIT_INFO)[number]; choice: Choice; onChange: (c: Choice) => void; allowDefault: boolean; allowKeep?: boolean; defaultValue?: number | null }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{info.label}</div>
          <div className="text-xs text-muted">{info.help}</div>
        </div>
        <select
          value={choice.mode}
          onChange={(e) => onChange({ ...choice, mode: e.target.value as Choice['mode'] })}
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm"
        >
          {allowKeep && <option value="keep">Don't change</option>}
          {allowDefault && <option value="default">Default ({defaultValue === undefined ? '—' : limitText(info.key, defaultValue)})</option>}
          <option value="unlimited">Unlimited</option>
          <option value="value">Limit to…</option>
        </select>
        {choice.mode === 'value' && (
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              value={choice.value}
              onChange={(e) => onChange({ ...choice, value: e.target.value })}
              className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-sm"
            />
            <span className="text-xs text-muted">{info.unit}</span>
          </span>
        )}
      </div>
    </div>
  );
}

const toChoice = (own: Limits, key: LimitKey, personal: boolean): Choice =>
  personal && !(key in own) ? { mode: 'default', value: '' } : own[key] === null || own[key] === undefined ? { mode: 'unlimited', value: '' } : { mode: 'value', value: String(own[key]) };

function readChoices(choices: Record<LimitKey, Choice>) {
  const out: Record<string, number | null | 'default'> = {};
  for (const { key, label } of LIMIT_INFO) {
    const c = choices[key];
    if (c.mode === 'keep') continue;
    if (c.mode === 'default') out[key] = 'default';
    else if (c.mode === 'unlimited') out[key] = null;
    else {
      const n = Number(c.value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`Enter a whole number for “${label}”`);
      out[key] = n;
    }
  }
  return out;
}

// ---------- defaults (the Limits tab) ----------

export function LimitsTab() {
  const { data, refetch } = useQuery({ queryKey: ['admin', 'limits'], queryFn: () => adminApi<{ defaults: Limits }>('/settings/limits') });
  const [choices, setChoices] = useState<Record<LimitKey, Choice> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setChoices(Object.fromEntries(LIMIT_INFO.map(({ key }) => [key, toChoice(data.defaults, key, false)])) as Record<LimitKey, Choice>);
  }, [data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!choices) return;
    setBusy(true);
    try {
      await adminApi('/settings/limits', { method: 'PUT', body: { defaults: readChoices(choices) } });
      toast('Default limits saved');
      await refetch();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-5">
        <h2 className="text-xl font-semibold">Limits</h2>
        <p className="mt-1 text-sm text-muted">
          The limits everyone gets. To give some people different limits, select them in <b>Accounts</b> and choose <b>Set limits</b>.
        </p>
      </div>
      {!choices ? (
        <Spinner />
      ) : (
        <form onSubmit={save} className="max-w-2xl space-y-2">
          {LIMIT_INFO.map((info) => (
            <LimitField key={info.key} info={info} choice={choices[info.key]} onChange={(c) => setChoices({ ...choices, [info.key]: c })} allowDefault={false} />
          ))}
          <div className="pt-2">
            <Button type="submit" variant="primary" loading={busy}>
              Save defaults
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

// ---------- for some people ----------

/** Sets limits for one or more people. With one person, shows their current limits and usage. */
export function PeopleLimitsDialog({
  userIds,
  label,
  own,
  usage,
  onClose,
  onSaved,
}: {
  userIds: string[];
  label: string;
  own?: Limits;
  usage?: { workspaces: number; storageBytes: number; aiTokensToday: number; aiTokensMonth: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const single = userIds.length === 1 && own !== undefined;
  const defaults = useQuery({ queryKey: ['admin', 'limits'], queryFn: () => adminApi<{ defaults: Limits }>('/settings/limits') });
  const [choices, setChoices] = useState<Record<LimitKey, Choice>>(
    () => Object.fromEntries(LIMIT_INFO.map(({ key }) => [key, single ? toChoice(own!, key, true) : { mode: 'keep', value: '' }])) as Record<LimitKey, Choice>,
  );
  const [busy, setBusy] = useState(false);
  const used: Partial<Record<LimitKey, string>> = usage ? { workspaces: String(usage.workspaces), storageMb: bytes(usage.storageBytes), aiTokensPerDay: `${tokens(usage.aiTokensToday)} today`, aiTokensPerMonth: `${tokens(usage.aiTokensMonth)} this month` } : {};

  const save = async () => {
    setBusy(true);
    try {
      const limits = readChoices(choices);
      if (!Object.keys(limits).length) return onClose();
      await adminApi('/users/limits', { method: 'PUT', body: { userIds, limits } });
      toast(`Limits saved for ${label}`);
      onSaved();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} width={600} top="6vh" maxHeight="88vh">
      <div className="space-y-2 overflow-y-auto p-5">
        <h3 className="text-lg font-semibold">Limits for {label}</h3>
        <p className="pb-1 text-sm text-muted">
          {single ? '“Default” follows the limits set in the Limits tab.' : 'Only the limits you change are applied; the rest stay as each person has them.'}
        </p>
        {LIMIT_INFO.map((info) => (
          <div key={info.key}>
            <LimitField
              info={info}
              choice={choices[info.key]}
              onChange={(c) => setChoices({ ...choices, [info.key]: c })}
              allowDefault
              allowKeep={!single}
              defaultValue={defaults.data ? (defaults.data.defaults[info.key] ?? null) : undefined}
            />
            {used[info.key] && <div className="mt-0.5 px-1 text-xs text-faint">Using now: {used[info.key]}</div>}
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------- email ----------

interface MailState {
  mail: { host: string; port: number; secure: boolean; user: string; from: string; hasPassword: boolean } | null;
  fromEnvironment: boolean;
  requireEmailVerification: boolean;
}

const PRESETS: { label: string; host: string; port: number; secure: boolean }[] = [
  { label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true },
  { label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false },
  { label: 'Zoho', host: 'smtp.zoho.com', port: 465, secure: true },
  { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
  { label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, secure: false },
];

export function MailTab() {
  const { data, refetch } = useQuery({ queryKey: ['admin', 'mail'], queryFn: () => adminApi<MailState>('/settings/mail') });
  const [form, setForm] = useState({ host: '', port: '587', secure: false, user: '', password: '', from: '' });
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (data?.mail) setForm({ host: data.mail.host, port: String(data.mail.port), secure: data.mail.secure, user: data.mail.user, password: '', from: data.mail.from });
  }, [data?.mail]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const save = (e: FormEvent) => {
    e.preventDefault();
    return run('save', async () => {
      await adminApi('/settings/mail', {
        method: 'PUT',
        body: { host: form.host, port: Number(form.port), secure: form.secure, user: form.user, from: form.from, password: form.password ? form.password : data?.mail?.hasPassword ? undefined : '' },
      });
      setForm((f) => ({ ...f, password: '' }));
      toast('Connected to the mail server and saved');
      await refetch();
    });
  };

  const field = 'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-accent';

  return (
    <>
      <div className="mb-5">
        <h2 className="text-xl font-semibold">Email</h2>
        <p className="mt-1 text-sm text-muted">Used for sign-in codes, confirming new accounts and invitation emails. Any SMTP mail service works.</p>
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <div className="max-w-xl space-y-8">
          <div className={clsx('rounded-lg px-3 py-2 text-sm', data.mail || data.fromEnvironment ? 'bg-green-500/10' : 'bg-hover/60 text-muted')}>
            {data.mail
              ? `Sending through ${data.mail.host}${data.mail.from ? ` as ${data.mail.from}` : ''}.`
              : data.fromEnvironment
                ? "Using the SMTP settings from the server's .env. Saving here takes over from them."
                : 'Not set up — sign-in codes and invitation emails are off.'}
          </div>

          <form onSubmit={save} className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, host: p.host, port: String(p.port), secure: p.secure }))}
                  className={clsx('rounded-md border px-2 py-0.5 text-xs', form.host === p.host ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg')}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Mail server (SMTP host)</span>
                <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.example.com" className={field} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Port</span>
                <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className={field} />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Security</span>
              <select value={form.secure ? 'tls' : 'starttls'} onChange={(e) => setForm({ ...form, secure: e.target.value === 'tls' })} className={field}>
                <option value="starttls">STARTTLS (usually port 587)</option>
                <option value="tls">SSL/TLS (usually port 465)</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Username</span>
              <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} autoComplete="off" placeholder="you@example.com" className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Password{form.host === 'smtp.gmail.com' ? ' (for Gmail, an app password)' : ''}</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="new-password"
                placeholder={data.mail?.hasPassword ? 'Saved — type to replace' : ''}
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Send as (from address)</span>
              <input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="Workspace <no-reply@example.com>" className={field} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!form.host || !form.port}>
                Check and save
              </Button>
              {data.mail && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirmDialog({ title: 'Remove the email settings?', message: "The server falls back to the .env settings, if there are any.", confirmLabel: 'Remove', danger: true }))) return;
                    await run('remove', async () => {
                      await adminApi('/settings/mail', { method: 'DELETE' });
                      toast('Email settings removed');
                      await refetch();
                    });
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">The password is stored encrypted and never shown again.</p>
          </form>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Send a test email</h3>
            <div className="flex gap-2">
              <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
              <Button
                loading={busy === 'test'}
                disabled={!testTo}
                onClick={() =>
                  run('test', async () => {
                    await adminApi('/mail/test', { method: 'POST', body: { to: testTo } });
                    toast(`Test email sent to ${testTo}`);
                  })
                }
              >
                Send
              </Button>
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-line p-3">
            <input
              type="checkbox"
              checked={data.requireEmailVerification}
              onChange={(e) =>
                run('verify', async () => {
                  await adminApi('/settings/verification', { method: 'PUT', body: { required: e.target.checked } });
                  await refetch();
                })
              }
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium">New accounts must confirm their email</span>
              <span className="block text-xs text-muted">They get a 6-digit code by email before they can use the app (only while email is set up).</span>
            </span>
          </label>
        </div>
      )}
    </>
  );
}
