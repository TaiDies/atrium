import { listenLive } from './live';
import { queryClient } from './queries';

// System notifications — in the Windows and Android apps (Tauri's notification plugin) and in browsers
// (the Notification API): new chat messages, mentions, meeting invitations, tasks given to you and
// everything else under the bell, as it happens. What's shown is set per device (Settings →
// Notifications). They only arrive while the app is running (even in the background); there's no push
// service.

export type MessageLevel = 'all' | 'mentions' | 'off';
export interface NotifySettings {
  enabled: boolean;
  messages: MessageLevel;
  meetings: boolean;
  tasks: boolean;
  other: boolean;
  sound: boolean;
  /** Not while you're looking at the app. */
  quietWhenOpen: boolean;
}

const KEY = 'af:notify-settings';
const DEFAULTS: NotifySettings = { enabled: false, messages: 'all', meetings: true, tasks: true, other: true, sound: true, quietWhenOpen: true };

export function notifySettings(): NotifySettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}
export function saveNotifySettings(s: NotifySettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private window: settings last until the app closes
  }
}

interface Tauri {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
  transformCallback(cb: (raw: unknown) => void, once?: boolean): number;
}
const tauri = (globalThis as { __TAURI_INTERNALS__?: Tauri }).__TAURI_INTERNALS__;

/** Whether this device can show notifications at all. */
export const notifySupported = () => !!tauri || (typeof window !== 'undefined' && 'Notification' in window);

/** 'granted', 'denied' or 'prompt'. */
export async function notifyPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  if (tauri) {
    const r = await tauri.invoke('plugin:notification|is_permission_granted').catch(() => null);
    return r === true ? 'granted' : r === false ? 'denied' : 'prompt';
  }
  if (!('Notification' in window)) return 'denied';
  return Notification.permission === 'default' ? 'prompt' : Notification.permission;
}

export async function askNotifyPermission(): Promise<boolean> {
  if (tauri) {
    const r = await tauri.invoke('plugin:notification|request_permission').catch(() => 'denied');
    return r === 'granted';
  }
  if (!('Notification' in window)) return false;
  return (await Notification.requestPermission()) === 'granted';
}

let goTo: ((link: string) => void) | null = null;
let lastLink: { link: string; at: number } | null = null;

/** Shows one notification (whatever the settings say — callers check them). */
export function showNotification(title: string, body: string, link: string | null, silent = false) {
  if (link) lastLink = { link, at: Date.now() };
  if (tauri) {
    void tauri.invoke('plugin:notification|notify', { options: { title, body, silent, autoCancel: true, extra: link ? { link } : {} } }).catch(() => {});
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, silent, tag: link ?? undefined });
  n.onclick = () => {
    window.focus();
    if (link) goTo?.(link);
    n.close();
  };
}

const looking = () => document.visibilityState === 'visible' && document.hasFocus();

function category(kind: string): keyof Pick<NotifySettings, 'meetings' | 'tasks' | 'other'> | 'mention' {
  if (kind === 'meeting') return 'meetings';
  if (kind === 'assigned') return 'tasks';
  if (kind === 'mention') return 'mention';
  return 'other';
}

/** A message's text with its tokens read out. */
const plain = (body: string) =>
  body
    .replace(/<@[0-9a-f-]{36}>/gi, '@…')
    .replace(/<page:[^>]+>/g, '📄')
    .replace(/<date:[^>]+>/g, '📅')
    .replace(/<task:[^>]+>/g, '☑')
    .replace(/<meeting:[^>]+>/g, '🎥 meeting')
    .slice(0, 200);

let started = false;

/** Starts showing notifications for what arrives on the live channel. */
export function startAppNotifications(opts: { userId: string; workspaceId: () => string | undefined; navigate: (link: string) => void }) {
  goTo = opts.navigate;
  if (started) return;
  started = true;

  // Android: tapping a notification opens the app — then go where it points.
  if (tauri) {
    const id = tauri.transformCallback((raw) => {
      const r = raw as { message?: { notification?: { extra?: { link?: string } } }; notification?: { extra?: { link?: string } } };
      const link = r?.message?.notification?.extra?.link ?? r?.notification?.extra?.link;
      if (link) goTo?.(link);
    });
    void tauri
      .invoke('plugin:notification|register_listener', { event: 'actionPerformed', handler: { toJSON: () => `__CHANNEL__:${id}` } })
      .catch(() => {});
  }
  // Windows: clicking a notification brings the app to the front — then open what it was about.
  window.addEventListener('focus', () => {
    if (lastLink && Date.now() - lastLink.at < 60_000 && location.pathname !== lastLink.link) {
      const l = lastLink.link;
      lastLink = null;
      if (tauri) goTo?.(l);
    }
  });

  listenLive((m) => {
    const s = notifySettings();
    if (!s.enabled) return;
    if (s.quietWhenOpen && looking()) return;
    if (m.t === 'notify') {
      const cat = category(String(m.kind));
      const on = cat === 'mention' ? s.messages !== 'off' : s[cat];
      if (on) showNotification(String(m.title), String(m.body ?? ''), (m.link as string | null) ?? null, !s.sound);
    } else if (m.t === 'message') {
      // Mentions arrive as their own notification; this is for every other message.
      const msg = m.message as { userId: string | null; kind: string; body: string; chatId: string };
      if (s.messages !== 'all' || msg.kind !== 'text' || msg.userId === opts.userId) return;
      if (msg.body.includes(`<@${opts.userId}>`)) return;
      const ws = opts.workspaceId();
      if (looking() && location.pathname.endsWith(`/chat/${msg.chatId}`)) return;
      const chats = queryClient.getQueryData<{ id: string; name: string; kind: string }[]>(['chats', ws]) ?? [];
      const chat = chats.find((c) => c.id === msg.chatId);
      const members = queryClient.getQueryData<{ members: { id: string; name: string }[] }>(['members', ws]);
      const who = members?.members.find((p) => p.id === msg.userId)?.name ?? 'New message';
      const title = chat && chat.kind !== 'direct' ? `${who} in ${chat.name}` : who;
      showNotification(title, plain(msg.body), ws ? `/w/${ws}/chat/${msg.chatId}` : null, !s.sound);
    }
  });
}
