import clsx from 'clsx';
import { Maximize2, Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Avatar, toast, toastError } from '../components/ui';
import { usePhone } from '../lib/device';
import { queryClient } from '../lib/queries';
import type { MeetingDetail } from '../chat/chatApi';
import { Call, type CallState, chooseDevice, chosenDevice, type DeviceKind, type RemotePeer, type Slot } from './call';

// The call you're in, for the whole app: it keeps going when you open other pages. On the meeting's
// own page it fills the screen (MeetingRoom); elsewhere it's a small window you can drag around, or on a
// phone a bar at the top that takes you back. Leaving the Android app turns it into a picture-in-picture
// pop-up. The sound plays from here (so it never stops), and this works out who's talking.

export type Focus = { peer: string; slot: 'cam' | 'screen' } | null;

interface ActiveCall {
  detail: MeetingDetail;
  state: CallState | null;
  /** Peer ids (and 'me') talking right now. */
  speaking: Set<string>;
  focus: Focus;
  setFocus: (f: Focus) => void;
  toggle: (slot: Slot) => Promise<void>;
  /** Switches microphone or camera, or (for 'speaker') where the call's sound plays. */
  useDevice: (kind: DeviceKind, id: string) => Promise<void>;
  speaker: string;
  leave: () => void;
}

interface CallApi {
  active: ActiveCall | null;
  join: (detail: MeetingDetail, userId: string) => void;
}

const Ctx = createContext<CallApi>({ active: null, join: () => {} });
export const useCall = () => useContext(Ctx);

// ---------- sounds (made on the spot, no files) ----------

let audio: AudioContext | null = null;
const ctx = () => (audio ??= new AudioContext());

/** A short two-note chime: up for on, down for off; lower for the camera than the microphone. */
export function chime(slot: Slot, on: boolean) {
  try {
    const a = ctx();
    const base = slot === 'mic' ? 660 : slot === 'cam' ? 520 : 440;
    const notes = on ? [base, base * 1.33] : [base * 1.33, base];
    notes.forEach((f, i) => {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = a.currentTime + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + 0.13);
    });
  } catch {
    // no sound available
  }
}

/** Who's talking: the loudness of each microphone, checked a few times a second. */
function useSpeaking(streams: [string, MediaStream | undefined][]) {
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const key = streams.map(([id, s]) => `${id}:${s?.id ?? ''}`).join();
  useEffect(() => {
    const live = streams.filter((x): x is [string, MediaStream] => !!x[1]);
    if (!live.length) {
      setSpeaking(new Set());
      return;
    }
    let a: AudioContext;
    try {
      a = ctx();
    } catch {
      return;
    }
    const meters = live.map(([id, s]) => {
      const src = a.createMediaStreamSource(s);
      const an = a.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      return { id, src, an, buf: new Uint8Array(an.fftSize), last: 0 };
    });
    const timer = setInterval(() => {
      const now = performance.now();
      const next = new Set<string>();
      for (const m of meters) {
        m.an.getByteTimeDomainData(m.buf);
        let sum = 0;
        for (const v of m.buf) sum += (v - 128) ** 2;
        if (Math.sqrt(sum / m.buf.length) > 6) m.last = now;
        // Stays lit briefly after a word, so the border doesn't flicker.
        if (now - m.last < 450) next.add(m.id);
      }
      setSpeaking((old) => (old.size === next.size && [...next].every((x) => old.has(x)) ? old : next));
    }, 120);
    return () => {
      clearInterval(timer);
      for (const m of meters) m.src.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return speaking;
}

function Sound({ stream, speaker }: { stream: MediaStream; speaker: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    const el = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    void el?.setSinkId?.(speaker).catch(() => {});
  }, [speaker]);
  return <audio ref={ref} autoPlay />;
}

export function MediaView({ stream, className, mirror = false }: { stream: MediaStream; className?: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={clsx(className, mirror && '-scale-x-100')} />;
}

/** What may be heard and seen from someone (the host's rules win over what they turned on). */
export function visible(detail: MeetingDetail, state: CallState | null, p: RemotePeer) {
  const may = state?.perms[p.userId] ?? detail.perms[p.userId] ?? detail.meeting.defaults;
  return {
    mic: p.media.mic && may.talk ? p.streams.mic : undefined,
    cam: p.media.cam && may.camera ? p.streams.cam : undefined,
    screen: p.media.screen && may.screen ? p.streams.screen : undefined,
    may,
  };
}

declare global {
  interface Window {
    __afPip?: (on: boolean) => void;
    AfAndroid?: { setBars?: (c: string, light: boolean) => void; leave?: () => void; setInCall?: (on: boolean) => void };
  }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [state, setState] = useState<CallState | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const call = useRef<Call | null>(null);

  const leave = useCallback(() => {
    call.current?.leave();
    call.current = null;
    setDetail(null);
    setState(null);
    setFocus(null);
    window.AfAndroid?.setInCall?.(false);
    void queryClient.invalidateQueries({ queryKey: ['meeting'] });
  }, []);

  const join = useCallback(
    (d: MeetingDetail, userId: string) => {
      if (call.current && detail?.meeting.code === d.meeting.code) return;
      call.current?.leave();
      const c = new Call(d.meeting.code, userId, d.iceServers, setState);
      call.current = c;
      setDetail(d);
      setFocus(null);
      c.join();
      window.AfAndroid?.setInCall?.(true);
    },
    [detail],
  );

  // Keep the meeting's details fresh (permissions, tasks) while in the call.
  useEffect(() => {
    if (!detail) return;
    const code = detail.meeting.code;
    return queryClient.getQueryCache().subscribe(() => {
      const fresh = queryClient.getQueryData<MeetingDetail>(['meeting', code]);
      if (fresh && fresh !== detail) setDetail(fresh);
    });
  }, [detail]);

  useEffect(() => {
    if (state?.ended) {
      toast('The meeting has ended');
      leave();
    }
  }, [state?.ended, leave]);

  const toggle = useCallback(async (slot: Slot) => {
    const c = call.current;
    if (!c) return;
    const on = !c.state.media[slot];
    try {
      await c.set(slot, on);
      chime(slot, on);
    } catch (err) {
      toastError(err instanceof Error && err.name === 'NotAllowedError' ? new Error('Permission to use it was refused') : err);
    }
  }, []);

  const [speaker, setSpeaker] = useState(() => chosenDevice('speaker'));
  const useDevice = useCallback(async (kind: DeviceKind, id: string) => {
    if (kind === 'speaker') {
      chooseDevice('speaker', id);
      setSpeaker(id);
      return;
    }
    try {
      await call.current?.useDevice(kind, id);
    } catch (err) {
      toastError(err);
    }
  }, []);

  const peers = state?.peers ?? [];
  const heard = detail ? peers.map((p) => [p.id, visible(detail, state, p).mic] as [string, MediaStream | undefined]) : [];
  const speaking = useSpeaking([['me', state?.media.mic ? state.local.mic : undefined], ...heard]);

  const active = useMemo<ActiveCall | null>(
    () => (detail ? { detail, state, speaking, focus, setFocus, toggle, useDevice, speaker, leave } : null),
    [detail, state, speaking, focus, toggle, useDevice, speaker, leave],
  );

  return (
    <Ctx.Provider value={{ active, join }}>
      {children}
      {/* The call's sound, wherever you are in the app. */}
      {heard.map(([id, s]) => s && <Sound key={id} stream={s} speaker={speaker} />)}
      {active && <CallOverlay call={active} />}
    </Ctx.Provider>
  );
}

// ---------- away from the meeting's page ----------

/** The best thing to show small: what's focused, else a shared screen, else whoever's talking. */
export function mainView(call: ActiveCall) {
  const { detail, state, focus, speaking } = call;
  const peers = state?.peers ?? [];
  if (focus) {
    if (focus.peer === 'me') {
      const s = focus.slot === 'screen' ? state?.local.screen : state?.local.cam;
      if (s) return { stream: s, label: 'You', mirror: focus.slot === 'cam' };
    }
    const p = peers.find((x) => x.id === focus.peer);
    const v = p && visible(detail, state, p);
    const s = v && (focus.slot === 'screen' ? v.screen : v.cam);
    if (p && s) return { stream: s, label: p.name, mirror: false };
  }
  for (const p of peers) {
    const v = visible(detail, state, p);
    if (v.screen) return { stream: v.screen, label: `${p.name} — screen`, mirror: false };
  }
  const talker = peers.find((p) => speaking.has(p.id) && visible(detail, state, p).cam) ?? peers.find((p) => visible(detail, state, p).cam);
  if (talker) return { stream: visible(detail, state, talker).cam!, label: talker.name, mirror: false };
  if (state?.media.cam && state.local.cam) return { stream: state.local.cam, label: 'You', mirror: true };
  return null;
}

function CallOverlay({ call }: { call: ActiveCall }) {
  const location = useLocation();
  const navigate = useNavigate();
  const phone = usePhone();
  const [pip, setPip] = useState(false);
  const { detail, state } = call;
  const href = `/w/${detail.meeting.workspaceId}/meet/${detail.meeting.code}`;
  const onPage = location.pathname === href;
  const media = state?.media ?? { mic: false, cam: false, screen: false };

  // Android picture-in-picture: the app tells us when it shrinks into (or comes back from) the pop-up.
  useEffect(() => {
    window.__afPip = (on) => setPip(on);
    return () => {
      window.__afPip = undefined;
    };
  }, []);

  if (pip) return <PipView call={call} />;
  if (onPage) return null;
  const back = () => navigate(href);

  // On a phone, the bar at the top (CallBar) takes you back instead.
  if (phone) return null;
  return <FloatingCall call={call} media={media} onBack={back} />;
}

/** On a phone, away from the meeting's page: a bar at the top of the app that takes you back. */
export function CallBar() {
  const { active } = useCall();
  const location = useLocation();
  const navigate = useNavigate();
  const phone = usePhone();
  if (!active || !phone) return null;
  const href = `/w/${active.detail.meeting.workspaceId}/meet/${active.detail.meeting.code}`;
  if (location.pathname === href) return null;
  return (
    <button onClick={() => navigate(href)} className="flex shrink-0 items-center gap-2 bg-green-600 px-4 py-2 text-start text-sm text-white">
      <span className="size-2 animate-pulse rounded-full bg-white" />
      <span className="min-w-0 flex-1 truncate">
        In a call · <span data-no-translate>{active.detail.meeting.title}</span>
      </span>
      <span className="font-medium">Return</span>
    </button>
  );
}

function PipView({ call }: { call: ActiveCall }) {
  const view = mainView(call);
  const peers = call.state?.peers ?? [];
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-neutral-950">
      {view ? (
        <MediaView stream={view.stream} mirror={view.mirror} className="size-full object-contain" />
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2 p-2">
          {peers.slice(0, 4).map((p) => (
            <span key={p.id} className={clsx('rounded-full', call.speaking.has(p.id) && 'ring-2 ring-green-400')}>
              <Avatar name={p.name} color="#6b7280" size={40} />
            </span>
          ))}
          {!peers.length && <span className="text-xs text-white/70">Waiting for others…</span>}
        </div>
      )}
      {!call.state?.media.mic && (
        <span className="absolute start-1 bottom-1 rounded bg-black/60 p-0.5 text-red-400">
          <MicOff size={12} />
        </span>
      )}
    </div>
  );
}

const POS_KEY = 'af:call-window';

function FloatingCall({ call, media, onBack }: { call: ActiveCall; media: { mic: boolean; cam: boolean; screen: boolean }; onBack: () => void }) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null');
      if (saved && typeof saved.x === 'number') return saved;
    } catch {
      // ignore
    }
    return { x: window.innerWidth - 340, y: window.innerHeight - 260 };
  });
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = mainView(call);
  const peers = call.state?.peers ?? [];

  const clamp = (x: number, y: number) => {
    const w = box.current?.offsetWidth ?? 320;
    const h = box.current?.offsetHeight ?? 220;
    return { x: Math.min(Math.max(8, x), window.innerWidth - w - 8), y: Math.min(Math.max(8, y), window.innerHeight - h - 8) };
  };
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p.x, p.y));
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={box} className="fixed z-[60] w-80 overflow-hidden rounded-xl border border-white/10 bg-neutral-950 text-white shadow-2xl af-ltr" style={{ left: pos.x, top: pos.y }}>
      <div
        className="flex cursor-grab touch-none items-center gap-2 px-3 py-1.5 text-xs select-none active:cursor-grabbing"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onPointerMove={(e) => {
          if (drag.current) setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
        }}
        onPointerUp={() => {
          drag.current = null;
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(pos));
          } catch {
            // ignore
          }
        }}
      >
        <span className="size-2 rounded-full bg-green-500" />
        <span className="min-w-0 flex-1 truncate font-medium" data-no-translate>
          {call.detail.meeting.title}
        </span>
        <span className="text-white/50">{peers.length + 1}</span>
      </div>
      <button onClick={onBack} className="relative block aspect-video w-full bg-black" title="Back to the meeting">
        {view ? (
          <MediaView stream={view.stream} mirror={view.mirror} className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center gap-2">
            {peers.slice(0, 5).map((p) => (
              <span key={p.id} className={clsx('rounded-full transition-shadow', call.speaking.has(p.id) && 'ring-2 ring-green-400 ring-offset-2 ring-offset-black')}>
                <Avatar name={p.name} color="#6b7280" size={36} />
              </span>
            ))}
            {!peers.length && <span className="text-xs text-white/60">Waiting for others to join…</span>}
          </span>
        )}
        {view && <span className="absolute start-2 bottom-2 rounded bg-black/60 px-1.5 text-[11px]" data-no-translate>{view.label}</span>}
      </button>
      <div className="flex items-center justify-center gap-1.5 px-2 py-2">
        <MiniTool on={media.mic} onClick={() => void call.toggle('mic')} title={media.mic ? 'Mute' : 'Unmute'}>
          {media.mic ? <Mic size={15} /> : <MicOff size={15} />}
        </MiniTool>
        <MiniTool on={media.cam} onClick={() => void call.toggle('cam')} title={media.cam ? 'Turn camera off' : 'Turn camera on'}>
          {media.cam ? <Video size={15} /> : <VideoOff size={15} />}
        </MiniTool>
        <MiniTool on={false} onClick={onBack} title="Back to the meeting">
          <Maximize2 size={15} />
        </MiniTool>
        <button onClick={call.leave} title="Leave" className="flex h-8 items-center gap-1 rounded-full bg-red-600 px-3 text-xs font-medium hover:bg-red-700">
          <PhoneOff size={14} /> Leave
        </button>
      </div>
    </div>
  );
}

function MiniTool({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} className={clsx('flex size-8 items-center justify-center rounded-full', on ? 'bg-white/90 text-neutral-900' : 'bg-white/10 hover:bg-white/20')}>
      {children}
    </button>
  );
}
