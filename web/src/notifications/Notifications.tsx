import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bell, BellRing, CalendarClock, Check, CheckCheck, ListTodo, Mail, Menu as MenuIcon, Share2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { type Anchor, IconButton, Popover, toast, toastError } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { keys, queryClient } from '../lib/queries';

// The bell: invitations to answer, event reminders, the day's tasks and messages (an invitation was
// accepted, a page was shared…). Checked every minute; can also show desktop alerts.

export interface NotificationItem {
  key: string;
  kind: 'invitation' | 'reminder' | 'tasks' | 'message';
  type?: string;
  title: string;
  body: string;
  link: string | null;
  at: string;
  read: boolean;
  workspaceId?: string;
  inviteId?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The person's own date and time, which reminders and "today" are worked out from. */
export function localNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const notificationsKey = ['notifications'] as const;

export function useNotifications() {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: () => api<{ items: NotificationItem[]; unread: number }>(`/api/notifications?now=${encodeURIComponent(localNow())}`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

const markRead = async (keys: string[]) => {
  if (keys.length) await api('/api/notifications/read', { method: 'POST', body: { keys } });
};

// ---------- desktop alerts ----------

const ALERTS_KEY = 'af-desktop-alerts';
const SHOWN_KEY = 'af-alerted';

const alertsOn = () => {
  try {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem(ALERTS_KEY) !== 'off';
  } catch {
    return false;
  }
};

/** Shows a desktop alert once for each new unread reminder, invitation or message. */
function useDesktopAlerts(items: NotificationItem[] | undefined) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!items || !alertsOn()) return;
    let shown: string[] = [];
    try {
      shown = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '[]');
    } catch {}
    const seen = new Set(shown);
    const fresh = items.filter((i) => !i.read && i.kind !== 'tasks' && !seen.has(i.key));
    for (const i of fresh.slice(0, 3)) {
      try {
        const n = new Notification(i.title, { body: i.body, tag: i.key });
        n.onclick = () => {
          window.focus();
          if (i.link) navigate(i.link);
        };
      } catch {
        // some browsers only allow alerts from a service worker
      }
    }
    if (fresh.length) {
      try {
        localStorage.setItem(SHOWN_KEY, JSON.stringify([...fresh.map((i) => i.key), ...shown].slice(0, 300)));
      } catch {}
    }
  }, [items, navigate]);
}

// ---------- the bell ----------

const ICONS = {
  invitation: <Mail size={16} />,
  reminder: <CalendarClock size={16} />,
  tasks: <ListTodo size={16} />,
  message: <Share2 size={16} />,
};

function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function NotificationBell() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const { data } = useNotifications();
  useDesktopAlerts(data?.items);
  const unread = data?.unread ?? 0;
  return (
    <>
      <IconButton
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        title={unread ? `${unread} new notification${unread === 1 ? '' : 's'}` : 'Notifications'}
        className="relative"
      >
        {unread ? <BellRing size={17} /> : <Bell size={17} />}
        {unread > 0 && (
          <span className="absolute -top-0.5 -end-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </IconButton>
      <Popover anchor={anchor} onClose={() => setAnchor(null)} align="start">
        <NotificationList items={data?.items ?? []} close={() => setAnchor(null)} />
      </Popover>
    </>
  );
}

/** The menu icon for opening the sidebar, with a dot when something new is under the bell. */
export function SidebarIcon() {
  const { data } = useNotifications();
  return (
    <span className="relative flex">
      <MenuIcon size={17} />
      {!!data?.unread && <span className="absolute -top-1 -end-1 size-2 rounded-full bg-red-500" />}
    </span>
  );
}

const MENTIONS = new Set(['mention', 'comment', 'assigned', 'page-shared']);
const tabOf = (i: NotificationItem) => (i.type === 'page-edited' ? 'updates' : i.type && MENTIONS.has(i.type) ? 'mentions' : 'other');

function NotificationList({ items: all, close }: { items: NotificationItem[]; close: () => void }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | 'mentions' | 'updates'>('all');
  const items = tab === 'all' ? all.filter((i) => tabOf(i) !== 'updates' || !i.read) : all.filter((i) => tabOf(i) === tab);
  const count = (t: 'mentions' | 'updates') => all.filter((i) => tabOf(i) === t && !i.read).length;
  const [permission, setPermission] = useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const [alerts, setAlerts] = useState(alertsOn);
  const unreadKeys = items.filter((i) => !i.read && i.kind !== 'invitation').map((i) => i.key);

  const read = useMutation({
    mutationFn: markRead,
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationsKey }),
  });

  const open = (i: NotificationItem) => {
    if (!i.read) read.mutate([i.key]);
    if (i.link) {
      navigate(i.link);
      close();
    }
  };

  const enableAlerts = async () => {
    try {
      localStorage.setItem(ALERTS_KEY, 'on');
    } catch {}
    if (permission === 'granted') return setAlerts(true);
    const result = await Notification.requestPermission();
    setPermission(result);
    setAlerts(result === 'granted');
    if (result !== 'granted') toast('Alerts are blocked for this site in your browser settings');
  };
  const disableAlerts = () => {
    try {
      localStorage.setItem(ALERTS_KEY, 'off');
    } catch {}
    setAlerts(false);
  };

  return (
    <div className="flex max-h-[min(560px,80vh)] w-[min(380px,calc(100vw-24px))] flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex-1 text-sm font-semibold">Notifications</div>
        {unreadKeys.length > 0 && (
          <button onClick={() => read.mutate(unreadKeys)} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg">
            <CheckCheck size={14} /> Mark all read
          </button>
        )}
      </div>
      <div className="flex gap-1 border-b border-line px-2 py-1.5">
        {(['all', 'mentions', 'updates'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={clsx('rounded-md px-2 py-0.5 text-xs capitalize', tab === t ? 'bg-active font-medium' : 'text-muted hover:bg-hover')}>
            {t}
            {t !== 'all' && count(t) > 0 && <span className="ms-1 rounded-full bg-accent px-1.5 text-[10px] text-white">{count(t)}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted">
            {tab === 'updates' ? 'Changes to pages you follow show here. Pages you make, edit or comment on are followed for you.' : tab === 'mentions' ? 'Mentions, comments and things assigned to you show here.' : "You're all caught up."}
          </div>
        )}
        {items.map((i) =>
          i.kind === 'invitation' ? (
            <InvitationRow key={i.key} item={i} close={close} />
          ) : (
            <button
              key={i.key}
              onClick={() => open(i)}
              className={clsx('flex w-full gap-3 border-b border-line/60 px-3 py-2.5 text-start hover:bg-hover', !i.read && 'bg-accent/5')}
            >
              <span className={clsx('mt-0.5 shrink-0', i.read ? 'text-faint' : 'text-accent')}>{ICONS[i.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className={clsx('block text-sm', !i.read && 'font-medium')}>{i.title}</span>
                {i.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{i.body}</span>}
                <span className="mt-0.5 block text-[11px] text-faint">{i.kind === 'tasks' ? 'Today' : timeAgo(i.at)}</span>
              </span>
              {!i.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />}
            </button>
          ),
        )}
      </div>
      {permission !== 'unsupported' && (
        <div className="border-t border-line px-3 py-2 text-xs text-muted">
          {alerts ? (
            <span>
              Desktop alerts are on.{' '}
              <button onClick={disableAlerts} className="text-accent hover:underline">
                Turn off
              </button>
            </span>
          ) : permission === 'denied' ? (
            <span>Desktop alerts are blocked in your browser settings.</span>
          ) : (
            <button onClick={enableAlerts} className="text-accent hover:underline">
              Show desktop alerts for reminders and invitations
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function InvitationRow({ item, close }: { item: NotificationItem; close: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  // Accepting needs a confirmed email on servers that send email: a code is sent and typed in here.
  const [confirm, setConfirm] = useState<{ email: string; code: string; sending: boolean } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const answer = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'decline');
    try {
      if (accept) {
        const { workspaceId } = await api<{ workspaceId: string }>(`/api/invitations/${item.inviteId}/accept`, { method: 'POST' });
        await queryClient.invalidateQueries({ queryKey: keys.workspaces });
        toast('You joined the workspace');
        close();
        navigate(`/w/${workspaceId}`);
      } else {
        await api(`/api/invitations/${item.inviteId}/decline`, { method: 'POST' });
        toast('Invitation declined');
      }
      await queryClient.invalidateQueries({ queryKey: notificationsKey });
    } catch (err) {
      if (accept && err instanceof ApiError && err.data?.verify && typeof err.data.email === 'string') {
        await sendCode(err.data.email);
        return;
      }
      toastError(err);
      await queryClient.invalidateQueries({ queryKey: notificationsKey });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const sendCode = async (address: string) => {
    setConfirm({ email: address, code: '', sending: true });
    try {
      await api('/api/auth/email/start', { method: 'POST', body: { email: address, purpose: 'verify' } });
      toast(`We sent a code to ${address}`);
    } catch (err) {
      toastError(err);
    } finally {
      if (mounted.current) setConfirm((c) => (c ? { ...c, sending: false } : c));
    }
  };

  const confirmAndAccept = async () => {
    if (!confirm) return;
    setBusy('accept');
    try {
      await api('/api/auth/email/verify', { method: 'POST', body: { email: confirm.email, code: confirm.code.trim() } });
      setConfirm(null);
    } catch (err) {
      toastError(err);
      if (mounted.current) setBusy(null);
      return;
    }
    await answer(true);
  };

  return (
    <div className="flex gap-3 border-b border-line/60 bg-accent/5 px-3 py-2.5">
      <span className="mt-0.5 shrink-0 text-accent">{ICONS.invitation}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{item.title}</div>
        <div className="mt-0.5 text-xs text-muted">{item.body}</div>
        {confirm && (
          <div className="mt-2 space-y-1.5">
            <div className="text-xs text-muted">To join, confirm your email: enter the 6-digit code we sent to {confirm.email}.</div>
            <div className="flex gap-2">
              <input
                autoFocus
                inputMode="numeric"
                maxLength={6}
                value={confirm.code}
                onChange={(e) => setConfirm({ ...confirm, code: e.target.value.replace(/\D/g, '') })}
                onKeyDown={(e) => e.key === 'Enter' && confirm.code.length === 6 && void confirmAndAccept()}
                placeholder="123456"
                className="h-7 w-24 rounded-md border border-line bg-bg px-2 text-xs tracking-widest outline-none focus:border-accent"
              />
              <button
                disabled={confirm.code.length !== 6 || !!busy}
                onClick={() => void confirmAndAccept()}
                className="flex h-7 items-center rounded-md bg-accent px-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                Confirm & join
              </button>
              <button disabled={confirm.sending} onClick={() => void sendCode(confirm.email)} className="h-7 px-1.5 text-xs text-muted hover:text-fg disabled:opacity-60">
                Send again
              </button>
            </div>
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <button
            disabled={!!busy}
            onClick={() => answer(true)}
            className="flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            <Check size={13} /> {busy === 'accept' ? 'Joining…' : 'Accept'}
          </button>
          <button
            disabled={!!busy}
            onClick={() => answer(false)}
            className="flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-xs hover:bg-hover disabled:opacity-60"
          >
            <X size={13} /> {busy === 'decline' ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
    </div>
  );
}
