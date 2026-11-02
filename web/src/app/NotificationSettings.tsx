import clsx from 'clsx';
import { BellRing } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button, toast } from '../components/ui';
import { askNotifyPermission, type MessageLevel, notifyPermission, notifySettings, notifySupported, type NotifySettings, saveNotifySettings, showNotification } from '../lib/appNotify';
import { isNativeApp } from '../lib/native';

// Settings → Notifications: whether this device shows system notifications, and for what. Kept on the
// device (each phone or computer chooses for itself).

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={clsx('relative h-6 w-10 rounded-full transition-colors disabled:opacity-40', on ? 'bg-accent' : 'bg-line')}
    >
      <span className={clsx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', on ? 'start-[18px]' : 'start-0.5')} />
    </button>
  );
}

export function NotificationsTab() {
  const [s, setS] = useState<NotifySettings>(notifySettings);
  const [perm, setPerm] = useState<'granted' | 'denied' | 'prompt' | null>(null);
  const supported = notifySupported();
  useEffect(() => {
    void notifyPermission().then(setPerm);
  }, []);
  const set = (patch: Partial<NotifySettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveNotifySettings(next);
  };
  const enable = async (on: boolean) => {
    if (on && perm !== 'granted') {
      const ok = await askNotifyPermission();
      setPerm(ok ? 'granted' : 'denied');
      if (!ok) {
        toast(isNativeApp() ? 'Notifications are blocked — allow them for this app in the system settings' : 'Notifications are blocked — allow them for this site in the browser');
        return;
      }
    }
    set({ enabled: on });
  };
  const off = !s.enabled;

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-base font-semibold">Notifications on this device</h3>
        <p className="mt-1 text-sm text-muted">
          System notifications for new messages, mentions, meeting invitations and tasks, as they happen — while the app is open or running in the background.
          {!isNativeApp() && ' In a browser, the tab needs to stay open.'}
        </p>
      </section>
      {!supported ? (
        <p className="rounded-lg bg-hover p-3 text-sm text-muted">This browser can't show notifications. The Windows and Android apps can.</p>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line px-4">
          <Row title="Show notifications" hint={perm === 'denied' ? 'Blocked by the system — allow them in its settings first' : undefined}>
            <Switch on={s.enabled && perm === 'granted'} onChange={(v) => void enable(v)} />
          </Row>
          <Row title="Chat messages" hint="Mentions of you count as messages too">
            <select value={s.messages} disabled={off} onChange={(e) => set({ messages: e.target.value as MessageLevel })} className="h-8 rounded-md border border-line bg-surface px-2 text-sm disabled:opacity-40">
              <option value="all">All messages</option>
              <option value="mentions">Only when I'm mentioned</option>
              <option value="off">None</option>
            </select>
          </Row>
          <Row title="Meetings" hint="Invitations and meetings starting">
            <Switch on={s.meetings} disabled={off} onChange={(v) => set({ meetings: v })} />
          </Row>
          <Row title="Tasks" hint="When someone gives you a task">
            <Switch on={s.tasks} disabled={off} onChange={(v) => set({ tasks: v })} />
          </Row>
          <Row title="Everything else under the bell" hint="Comments, shares, invitations to workspaces…">
            <Switch on={s.other} disabled={off} onChange={(v) => set({ other: v })} />
          </Row>
          <Row title="Sound">
            <Switch on={s.sound} disabled={off} onChange={(v) => set({ sound: v })} />
          </Row>
          <Row title="Quiet while I'm using the app" hint="Only notify when the app isn't in front">
            <Switch on={s.quietWhenOpen} disabled={off} onChange={(v) => set({ quietWhenOpen: v })} />
          </Row>
        </div>
      )}
      {supported && s.enabled && perm === 'granted' && (
        <Button onClick={() => showNotification('Notifications are on', "This is how they'll look.", null, !s.sound)}>
          <BellRing size={14} /> Send a test notification
        </Button>
      )}
    </div>
  );
}
