import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Mail } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Input } from '../components/ui';
import { APP_NAME, type User } from '../lib/api';
import { forgetServer, isNativeApp, loadNative, nativeInfo } from '../lib/native';
import { keys, queryClient } from '../lib/queries';

interface AuthOptions {
  emailCodes: boolean;
  requireEmailVerification: boolean;
  appName: string;
  /** False when the admin allows new accounts only for invited email addresses. */
  signups?: boolean;
}

/** POST that keeps the whole error body (some errors carry `verify: true`). */
async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; verify?: boolean } }> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

type Step = { kind: 'form' } | { kind: 'name'; email: string } | { kind: 'code'; email: string; reason: 'login' | 'signup' | 'verify' };

/**
 * Signing in and up: with a password, or — when the server has email set up — with a 6-digit code sent
 * by email (no password needed). Servers can also require new accounts to confirm their email.
 */
export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const navigate = useNavigate();
  const options = useQuery({ queryKey: ['auth-options'], queryFn: () => fetch('/api/auth/options').then((r) => r.json() as Promise<AuthOptions>), staleTime: 60_000 });
  const codes = !!options.data?.emailCodes;
  const [method, setMethod] = useState<'password' | 'code'>('password');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const signup = mode === 'signup';

  useEffect(() => {
    setStep({ kind: 'form' });
    setError('');
  }, [mode]);

  const finish = async (user: User) => {
    // In the apps, pick up the new session for live editing.
    await loadNative();
    queryClient.clear();
    queryClient.setQueryData(keys.me, user);
    navigate('/', { replace: true });
  };

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setNotice('');
    setLoading(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const sendCode = (email: string, purpose: 'login' | 'signup' | 'verify', name?: string) =>
    run(async () => {
      const r = await post<{ sent: boolean; newAccount: boolean }>('/api/auth/email/start', { email, purpose, name });
      if (!r.ok) throw new Error(r.data.error ?? 'Could not send the code');
      if (!r.data.sent && r.data.newAccount) return setStep({ kind: 'name', email });
      setCode('');
      setStep({ kind: 'code', email, reason: purpose === 'signup' || r.data.newAccount ? 'signup' : purpose });
      setNotice(`We sent a 6-digit code to ${email}.`);
    });

  const submitForm = (e: FormEvent) => {
    e.preventDefault();
    if (method === 'code') return sendCode(form.email, signup ? 'signup' : 'login', signup ? form.name : undefined);
    run(async () => {
      const r = await post<{ user: User; email: string }>(signup ? '/api/auth/signup' : '/api/auth/login', signup ? form : { email: form.email, password: form.password });
      if (r.data.verify) {
        // The account needs its email confirmed first; a code is on its way.
        setCode('');
        setStep({ kind: 'code', email: form.email, reason: 'verify' });
        setNotice(`Confirm your email: we sent a 6-digit code to ${form.email}.`);
        return;
      }
      if (!r.ok) throw new Error(r.data.error ?? 'Something went wrong');
      finish(r.data.user);
    });
  };

  const submitCode = (value = code) =>
    run(async () => {
      if (step.kind !== 'code') return;
      const r = await post<{ user: User }>('/api/auth/email/verify', { email: step.email, code: value });
      if (!r.ok) throw new Error(r.data.error ?? 'That code isn’t right');
      finish(r.data.user);
    });

  const field = (name: keyof typeof form) => ({
    value: form[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [name]: e.target.value }),
  });

  const appName = options.data?.appName && options.data.appName !== 'Workspace' ? options.data.appName : APP_NAME;

  return (
    <div className="flex min-h-full items-center justify-center bg-sidebar px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/logo.svg" alt="" className="mb-4 size-12" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {step.kind === 'code' ? 'Check your email' : signup ? `Create your ${appName} account` : `Welcome back`}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            {step.kind === 'code'
              ? 'Enter the code to continue.'
              : signup
                ? 'Docs, boards and real-time collaboration for your team.'
                : `Sign in to continue to ${appName}.`}
          </p>
        </div>

        <div className="shadow-pop rounded-xl bg-surface p-6">
          {step.kind === 'form' && (
            <form onSubmit={submitForm} className="space-y-3">
              {signup && options.data && !codes && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-muted">
                  This server can’t send email, so it can’t check that an address is yours. Invitations sent to an address go to whoever signs up with it.
                </p>
              )}
              {codes && (
                <div className="mb-1 grid grid-cols-2 rounded-lg border border-line p-0.5 text-sm">
                  {(['password', 'code'] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setMethod(m)} className={clsx('h-8 rounded-md', method === m ? 'bg-active font-medium' : 'text-muted hover:text-fg')}>
                      {m === 'password' ? 'Password' : 'Email me a code'}
                    </button>
                  ))}
                </div>
              )}
              {signup && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Name</span>
                  <Input {...field('name')} autoComplete="name" placeholder="Ada Lovelace" required autoFocus />
                </label>
              )}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Email</span>
                <Input {...field('email')} type="email" autoComplete="email" placeholder="you@company.com" required autoFocus={!signup} />
              </label>
              {method === 'password' && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Password</span>
                  <Input
                    {...field('password')}
                    type="password"
                    autoComplete={signup ? 'new-password' : 'current-password'}
                    placeholder={signup ? 'At least 8 characters' : '••••••••'}
                    minLength={signup ? 8 : undefined}
                    required
                  />
                </label>
              )}
              {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={loading}>
                {method === 'code' ? (
                  <>
                    <Mail size={15} /> Send me a code
                  </>
                ) : signup ? (
                  'Create account'
                ) : (
                  'Sign in'
                )}
              </Button>
              {options.data?.requireEmailVerification && signup && method === 'password' && (
                <p className="text-center text-xs text-muted">You'll confirm your email with a code.</p>
              )}
              {options.data?.signups === false && signup && (
                <p className="text-center text-xs text-muted">New accounts on this server are by invitation. Use the email address you were invited with.</p>
              )}
            </form>
          )}

          {step.kind === 'name' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendCode(step.email, 'signup', form.name);
              }}
              className="space-y-3"
            >
              <p className="text-sm text-muted">
                There's no account for <b className="text-fg">{step.email}</b> yet. What should we call you?
              </p>
              <Input {...field('name')} autoComplete="name" placeholder="Your name" required autoFocus />
              {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={loading}>
                Create account and send code
              </Button>
              <BackLink onClick={() => setStep({ kind: 'form' })} />
            </form>
          )}

          {step.kind === 'code' && (
            <CodeForm
              notice={notice}
              error={error}
              loading={loading}
              code={code}
              setCode={setCode}
              onSubmit={submitCode}
              onResend={() => sendCode(step.email, step.reason, step.reason === 'signup' ? form.name : undefined)}
              onBack={() => setStep({ kind: 'form' })}
            />
          )}
        </div>

        {isNativeApp() && step.kind === 'form' && (
          <p className="mt-4 text-center text-xs text-muted">
            Server: {nativeInfo()?.server}{' '}
            <button
              type="button"
              onClick={async () => {
                await forgetServer();
                location.replace('/');
              }}
              className="text-accent hover:underline"
            >
              Change
            </button>
          </p>
        )}
        {step.kind === 'form' && (
          <p className="mt-5 text-center text-sm text-muted">
            {signup ? 'Already have an account?' : "Don't have an account?"}{' '}
            <Link to={signup ? '/login' : '/signup'} className="font-medium text-accent hover:underline">
              {signup ? 'Sign in' : 'Sign up'}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mx-auto flex items-center gap-1 text-xs text-muted hover:text-fg">
      <ArrowLeft size={13} /> Back
    </button>
  );
}

function CodeForm({
  notice,
  error,
  loading,
  code,
  setCode,
  onSubmit,
  onResend,
  onBack,
}: {
  notice: string;
  error: string;
  loading: boolean;
  code: string;
  setCode: (c: string) => void;
  onSubmit: (code?: string) => void;
  onResend: () => void;
  onBack: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-3"
    >
      {notice && <p className="text-sm text-muted">{notice}</p>}
      <input
        ref={input}
        value={code}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 6);
          setCode(v);
          if (v.length === 6) onSubmit(v); // a full code (often filled in by the phone) signs in straight away
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        aria-label="6-digit code"
        className="h-14 w-full rounded-lg border border-line bg-bg text-center font-mono text-2xl tracking-[0.4em] outline-none focus:border-accent"
      />
      {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={code.length !== 6}>
        Continue
      </Button>
      <div className="flex items-center justify-between">
        <BackLink onClick={onBack} />
        <button type="button" onClick={onResend} className="text-xs text-accent hover:underline" disabled={loading}>
          Send a new code
        </button>
      </div>
    </form>
  );
}
