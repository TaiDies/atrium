import clsx from 'clsx';
import { FlipHorizontal2, Pause, Play, RotateCcw, RotateCw, Scissors, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, toast, toastError } from '../components/ui';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';
import { refreshFiles } from '../notes/api';

// A quick video editor: keep just a part (trim), take the sound out, turn or flip it. The video is
// made on the server (ffmpeg), so it works the same on a phone; saving replaces it or adds a copy.

interface EditFile {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
}

const clock = (s: number) => {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
};

export default function VideoEditor({ file, onDone }: { file: EditFile; onDone: (saved: boolean) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mute, setMute] = useState(false);
  const [rotate, setRotate] = useState<0 | 90 | 180 | 270>(0);
  const [flip, setFlip] = useState(false);
  const [busy, setBusy] = useState<'replace' | 'copy' | null>(null);

  // Playing stays inside the part being kept.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const tick = () => {
      setNow(v.currentTime);
      if (end > 0 && v.currentTime >= end) {
        v.pause();
        v.currentTime = start;
      }
    };
    v.addEventListener('timeupdate', tick);
    return () => v.removeEventListener('timeupdate', tick);
  }, [start, end]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
      void v.play();
    } else v.pause();
  };

  // Dragging a handle (or the playhead) along the bar.
  const dragging = useRef<'start' | 'end' | 'head' | null>(null);
  const timeAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const onDown = (what: 'start' | 'end' | 'head') => (e: React.PointerEvent) => {
    e.stopPropagation();
    bar.current?.setPointerCapture(e.pointerId);
    dragging.current = what;
    onMove(e);
  };
  const onMove = (e: React.PointerEvent) => {
    const what = dragging.current;
    if (!what || !duration) return;
    const t = timeAt(e.clientX);
    const v = video.current!;
    if (what === 'start') {
      const s = Math.min(t, end - 0.2);
      setStart(s);
      v.currentTime = s;
    } else if (what === 'end') {
      const en = Math.max(t, start + 0.2);
      setEnd(en);
      v.currentTime = en;
    } else v.currentTime = Math.min(Math.max(t, start), end);
  };

  const trimmed = duration > 0 && (start > 0.05 || end < duration - 0.05);
  const changed = trimmed || mute || rotate !== 0 || flip;

  const save = async (asCopy: boolean) => {
    video.current?.pause();
    setBusy(asCopy ? 'copy' : 'replace');
    try {
      const res = await api<{ name: string }>(`/api/files/${file.id}/video-edit`, {
        method: 'POST',
        body: { start: trimmed ? Math.round(start * 100) / 100 : 0, end: trimmed ? Math.round(end * 100) / 100 : null, mute, rotate, flip, asCopy },
      });
      toast(asCopy ? `Saved a copy, “${res.name}”, in Files` : 'Saved');
      queryClient.invalidateQueries({ queryKey: ['file-info', file.id] });
      void refreshFiles(file.workspaceId);
      onDone(!asCopy);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : '0%');
  const side = rotate === 90 || rotate === 270;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-bg px-2 py-1.5">
        <span className="flex items-center gap-1.5 px-2 text-sm font-medium">
          <Scissors size={15} /> Edit video
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onDone(false)} disabled={!!busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save(true)} loading={busy === 'copy'} disabled={!!busy || !changed}>
          Save as copy
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save(false)} loading={busy === 'replace'} disabled={!!busy || !changed} title="Replaces the video everywhere it's used">
          Save
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <video
          ref={video}
          src={file.url}
          muted={mute}
          playsInline
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration || 0;
            setDuration(d);
            setEnd(d);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={toggle}
          className="max-h-full max-w-full rounded transition-transform"
          style={{ transform: `rotate(${rotate}deg) scaleX(${flip ? -1 : 1})${side ? ' scale(0.6)' : ''}` }}
        />
      </div>

      <div className="shrink-0 space-y-2.5 border-t border-line bg-bg px-3 py-3">
        <div className="flex items-center gap-3">
          <button onClick={toggle} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white" aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <div ref={bar} className="relative h-10 min-w-0 flex-1 touch-none select-none" onPointerDown={onDown('head')} onPointerMove={onMove} onPointerUp={() => (dragging.current = null)}>
            <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-line" />
            <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-accent/60" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
            <div className="absolute top-0 bottom-0 w-0.5 bg-fg" style={{ left: pct(now) }} />
            <span
              onPointerDown={onDown('start')}
              className="absolute top-1/2 h-8 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded bg-accent shadow"
              style={{ left: pct(start) }}
              title="Start"
            />
            <span
              onPointerDown={onDown('end')}
              className="absolute top-1/2 h-8 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded bg-accent shadow"
              style={{ left: pct(end) }}
              title="End"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="tabular-nums text-muted">
            {clock(start)} – {clock(end)} <span className="text-faint">({clock(end - start)} kept)</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => setStart(Math.min(now, end - 0.2))}>
            Start here
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEnd(Math.max(now, start + 0.2))}>
            End here
          </Button>
          <span className="flex-1" />
          <button
            onClick={() => setMute(!mute)}
            className={clsx('flex h-8 items-center gap-1.5 rounded-md px-2.5', mute ? 'bg-active font-medium' : 'text-muted hover:bg-hover hover:text-fg')}
          >
            {mute ? <VolumeX size={15} /> : <Volume2 size={15} />} {mute ? 'No sound' : 'Sound on'}
          </button>
          <IconButton label="Turn left" onClick={() => setRotate((r) => (((r + 270) % 360) as 0 | 90 | 180 | 270))}>
            <RotateCcw size={16} />
          </IconButton>
          <IconButton label="Turn right" onClick={() => setRotate((r) => (((r + 90) % 360) as 0 | 90 | 180 | 270))}>
            <RotateCw size={16} />
          </IconButton>
          <IconButton label="Flip left to right" onClick={() => setFlip(!flip)} active={flip}>
            <FlipHorizontal2 size={16} />
          </IconButton>
        </div>
        {busy && <p className="text-xs text-muted">Making the video… a long one can take a minute.</p>}
      </div>
    </div>
  );
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={clsx('flex size-8 items-center justify-center rounded-md hover:bg-hover hover:text-fg', active ? 'bg-active text-fg' : 'text-muted')}
    >
      {children}
    </button>
  );
}
