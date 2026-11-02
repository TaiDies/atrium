import clsx from 'clsx';
import { CalendarClock, MessagesSquare, Plus, Video } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApp } from '../app/context';
import { Button, IconButton, Spinner } from '../components/ui';
import { usePhone } from '../lib/device';
import { SidebarIcon } from '../notifications/Notifications';
import { meetingState, type MeetingSummary, useMeetings } from '../chat/chatApi';
import { ScheduleDialog } from '../chat/ScheduleDialog';

// Meetings: what's on now, what's coming up (each with its link ready), and past meetings with their
// kept chats and tasks.

const when = (m: MeetingSummary) => {
  const at = m.endedAt ?? m.startsAt;
  if (!at) return '';
  return new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function MeetingsPage() {
  const { workspace, sidebarOpen, toggleSidebar } = useApp();
  const phone = usePhone();
  const meetings = useMeetings(workspace.id);
  const [scheduling, setScheduling] = useState(false);
  const all = meetings.data ?? [];
  const live = all.filter((m) => meetingState(m) === 'live');
  const soon = all.filter((m) => meetingState(m) === 'scheduled').sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
  const past = all.filter((m) => meetingState(m) === 'ended');

  const section = (title: string, items: MeetingSummary[]) =>
    items.length > 0 && (
      <section className="mb-6">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
        <div className="divide-y divide-line rounded-xl border border-line">
          {items.map((m) => {
            const state = meetingState(m);
            return (
              <Link key={m.code} to={`/w/${workspace.id}/meet/${m.code}`} className="flex items-center gap-3 px-3 py-2.5 no-underline hover:bg-hover">
                <span className={clsx('flex size-9 shrink-0 items-center justify-center rounded-lg', state === 'live' ? 'bg-green-500/15 text-green-600' : state === 'ended' ? 'bg-hover text-muted' : 'bg-accent/10 text-accent')}>
                  {state === 'ended' ? <MessagesSquare size={17} /> : <Video size={17} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-fg" data-no-translate>
                    {m.title}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {state === 'live' ? 'Happening now' : when(m)} · {m.isHost ? 'you host' : `host: ${m.hostName ?? '—'}`} · {m.people} {m.people === 1 ? 'person' : 'people'}
                  </span>
                </span>
                {state !== 'ended' && <span className={clsx('rounded-md px-2.5 py-1 text-xs font-medium', state === 'live' ? 'bg-green-600 text-white' : 'bg-hover text-fg')}>{state === 'live' ? 'Join' : 'Open'}</span>}
              </Link>
            );
          })}
        </div>
      </section>
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        {!sidebarOpen && !phone && (
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        )}
        <h1 className="flex flex-1 items-center gap-2 text-lg font-semibold">
          <Video size={19} className="text-muted" /> Meetings
        </h1>
        <Link to={`/w/${workspace.id}/chat`} className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-hover">
          <MessagesSquare size={15} /> Chat
        </Link>
        <Button variant="primary" onClick={() => setScheduling(true)}>
          <Plus size={15} /> New meeting
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-8">
        <div className="mx-auto max-w-3xl">
          {meetings.isPending && <Spinner />}
          {meetings.data && all.length === 0 && (
            <div className="py-16 text-center text-sm text-muted">
              <CalendarClock size={28} className="mx-auto mb-3 text-faint" />
              No meetings yet. Schedule one — the link is ready straight away — or start one now.
            </div>
          )}
          {section('Happening now', live)}
          {section('Coming up', soon)}
          {section('Past', past)}
        </div>
      </div>
      {scheduling && <ScheduleDialog open onClose={() => setScheduling(false)} />}
    </div>
  );
}
