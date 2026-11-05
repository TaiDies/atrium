import clsx from 'clsx';
import { Crop, FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner, toast, toastError } from '../components/ui';
import { uploadFile } from '../lib/api';
import { refreshFiles } from '../notes/api';
import { downloadBlob, saveContent } from '../office/shared';
import { queryClient } from '../lib/queries';

// A quick picture editor: crop (free or to a shape), turn, flip, brightness / contrast / saturation,
// and make it smaller. Everything happens in the browser; saving replaces the file or adds a copy.

interface EditFile {
  id: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  url: string;
}

/** A crop, as fractions of the turned picture. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Edits {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  crop: Box;
  brightness: number;
  contrast: number;
  saturation: number;
  /** The size to save at, as a share of the cropped picture (1 = full size). */
  scale: number;
}

const START: Edits = { rotate: 0, flipH: false, flipV: false, crop: { x: 0, y: 0, w: 1, h: 1 }, brightness: 100, contrast: 100, saturation: 100, scale: 1 };
const RATIOS: { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: 'Square', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The picture turned and flipped, at full size, with the colour changes. */
function turned(img: HTMLImageElement, e: Edits): HTMLCanvasElement {
  const side = e.rotate === 90 || e.rotate === 270;
  const c = document.createElement('canvas');
  c.width = side ? img.naturalHeight : img.naturalWidth;
  c.height = side ? img.naturalWidth : img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.filter = `brightness(${e.brightness}%) contrast(${e.contrast}%) saturate(${e.saturation}%)`;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((e.rotate * Math.PI) / 180);
  ctx.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return c;
}

/** The finished picture: turned, cropped and resized. */
function finished(img: HTMLImageElement, e: Edits): HTMLCanvasElement {
  const full = turned(img, e);
  const sx = Math.round(e.crop.x * full.width);
  const sy = Math.round(e.crop.y * full.height);
  const sw = Math.max(1, Math.round(e.crop.w * full.width));
  const sh = Math.max(1, Math.round(e.crop.h * full.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * e.scale));
  out.height = Math.max(1, Math.round(sh * e.scale));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

/** Saves as the same kind of picture when the browser can write it, otherwise as PNG. */
function outputType(file: EditFile) {
  if (file.mimeType === 'image/jpeg' || /\.jpe?g$/i.test(file.name)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (file.mimeType === 'image/webp' || /\.webp$/i.test(file.name)) return { mime: 'image/webp', ext: 'webp' };
  return { mime: 'image/png', ext: 'png' };
}

export default function ImageEditor({ file, onDone }: { file: EditFile; onDone: (saved: boolean) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [edits, setEdits] = useState<Edits>(START);
  const [history, setHistory] = useState<Edits[]>([]);
  const [tool, setTool] = useState<'crop' | 'adjust'>('crop');
  const [ratio, setRatio] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => toastError(new Error("This picture couldn't be opened for editing"));
    i.src = `${file.url}${file.url.includes('?') ? '&' : '?'}edit=${Date.now()}`;
  }, [file.url]);

  /** Changes something, remembering how it was so it can be undone. */
  const change = (patch: Partial<Edits> | ((e: Edits) => Partial<Edits>), remember = true) => {
    setEdits((e) => {
      if (remember) setHistory((h) => [...h.slice(-30), e]);
      return { ...e, ...(typeof patch === 'function' ? patch(e) : patch) };
    });
  };
  const undo = () => {
    const last = history.at(-1);
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    setEdits(last);
  };

  // The whole turned picture, drawn to fit the screen; the crop is drawn over it.
  const full = useMemo(() => (img ? turned(img, { ...edits, crop: START.crop, scale: 1 }) : null), [img, edits.rotate, edits.flipH, edits.flipV, edits.brightness, edits.contrast, edits.saturation]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = stage.current;
    if (!el || !full) return;
    const fit = () => {
      const s = Math.min(el.clientWidth / full.width, el.clientHeight / full.height, 1);
      setBox({ w: Math.round(full.width * s), h: Math.round(full.height * s) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [full]);
  useEffect(() => {
    const c = preview.current;
    if (!c || !full || !box.w) return;
    c.width = box.w;
    c.height = box.h;
    c.getContext('2d')!.drawImage(full, 0, 0, box.w, box.h);
  }, [full, box]);

  // Dragging the crop: inside moves it, a corner resizes it (keeping the chosen shape).
  const drag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number; start: Box } | null>(null);
  const onDown = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: edits.crop };
    setHistory((h) => [...h.slice(-30), edits]);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !box.w || !full) return;
    const dx = (e.clientX - d.x) / box.w;
    const dy = (e.clientY - d.y) / box.h;
    const s = d.start;
    let next: Box;
    if (d.mode === 'move') next = { ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) };
    else {
      const left = d.mode === 'nw' || d.mode === 'sw';
      const top = d.mode === 'nw' || d.mode === 'ne';
      let x1 = left ? clamp(s.x + dx, 0, s.x + s.w - 0.03) : s.x;
      let x2 = left ? s.x + s.w : clamp(s.x + s.w + dx, s.x + 0.03, 1);
      let y1 = top ? clamp(s.y + dy, 0, s.y + s.h - 0.03) : s.y;
      let y2 = top ? s.y + s.h : clamp(s.y + s.h + dy, s.y + 0.03, 1);
      if (ratio) {
        // The shape in fractions of this picture, whose sides differ.
        const r = ratio * (full.height / full.width);
        const w = x2 - x1;
        const h = Math.min(w / r, top ? y2 : 1 - y1);
        const w2 = h * r;
        if (left) x1 = x2 - w2;
        else x2 = x1 + w2;
        if (top) y1 = y2 - h;
        else y2 = y1 + h;
      }
      next = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    setEdits((ed) => ({ ...ed, crop: next }));
  };
  const onUp = () => (drag.current = null);

  /** Picks a shape: the largest crop of that shape in the middle of the picture. */
  const pickRatio = (value: number | null) => {
    setRatio(value);
    if (!value || !full) return;
    const r = value * (full.height / full.width);
    const w = r > 1 ? 1 : r;
    const h = r > 1 ? 1 / r : 1;
    change({ crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } });
  };

  const turn = (by: 90 | -90) =>
    change((e) => ({ rotate: (((e.rotate + by) % 360) + 360) % 360 as Edits['rotate'], crop: START.crop }));

  const outSize = img && full ? { w: Math.round(edits.crop.w * full.width * edits.scale), h: Math.round(edits.crop.h * full.height * edits.scale) } : null;
  const changed = JSON.stringify(edits) !== JSON.stringify(START);

  const render = async () => {
    const { mime, ext } = outputType(file);
    const canvas = finished(img!, edits);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
    if (!blob) throw new Error("The picture couldn't be saved");
    return { blob, name: `${file.name.replace(/\.[^.]+$/, '')}.${ext}` };
  };

  const save = async (how: 'replace' | 'copy' | 'download') => {
    if (!img) return;
    setBusy(how);
    try {
      const { blob, name } = await render();
      if (how === 'download') downloadBlob(blob, name);
      else if (how === 'copy') {
        const copyName = name.replace(/(\.[^.]+)$/, ' (edited)$1');
        await uploadFile(file.workspaceId, new File([blob], copyName, { type: blob.type }));
        toast(`Saved a copy, “${copyName}”, in Files`);
      } else {
        await saveContent(file.id, blob, name !== file.name ? name : undefined);
        toast('Saved');
      }
      if (how !== 'download') {
        queryClient.invalidateQueries({ queryKey: ['file-info', file.id] });
        void refreshFiles(file.workspaceId);
        onDone(how === 'replace');
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  if (!img) return <Spinner />;
  const c = edits.crop;
  const handle = 'absolute size-4 rounded-full border-2 border-white bg-accent shadow';

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-bg px-2 py-1.5">
        <ToolTab active={tool === 'crop'} onClick={() => setTool('crop')} icon={<Crop size={15} />} label="Crop & turn" />
        <ToolTab active={tool === 'adjust'} onClick={() => setTool('adjust')} icon={<SlidersHorizontal size={15} />} label="Adjust" />
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Undo" onClick={undo} disabled={!history.length}>
          <Undo2 size={16} />
        </IconButton>
        <Button size="sm" variant="ghost" onClick={() => change(START)} disabled={!changed}>
          Reset
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save('download')} loading={busy === 'download'} disabled={!!busy}>
          Download
        </Button>
        <Button size="sm" onClick={() => void save('copy')} loading={busy === 'copy'} disabled={!!busy || !changed}>
          Save as copy
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save('replace')} loading={busy === 'replace'} disabled={!!busy || !changed} title="Replaces the picture everywhere it's used">
          Save
        </Button>
      </div>

      <div ref={stage} className="relative flex min-h-0 flex-1 items-center justify-center p-4" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="relative touch-none select-none" style={{ width: box.w, height: box.h }}>
          <canvas ref={preview} className="block" style={{ width: box.w, height: box.h }} />
          {tool === 'crop' && (
            <div
              className="absolute cursor-move border-2 border-white"
              style={{ left: c.x * box.w, top: c.y * box.h, width: c.w * box.w, height: c.h * box.h, boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)' }}
              onPointerDown={onDown('move')}
            >
              <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                {Array.from({ length: 9 }, (_, i) => (
                  <div key={i} className="border border-white/30" />
                ))}
              </div>
              <span className={clsx(handle, '-start-2 -top-2 cursor-nwse-resize')} onPointerDown={onDown('nw')} />
              <span className={clsx(handle, '-end-2 -top-2 cursor-nesw-resize')} onPointerDown={onDown('ne')} />
              <span className={clsx(handle, '-bottom-2 -start-2 cursor-nesw-resize')} onPointerDown={onDown('sw')} />
              <span className={clsx(handle, '-end-2 -bottom-2 cursor-nwse-resize')} onPointerDown={onDown('se')} />
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-bg px-3 py-2.5">
        {tool === 'crop' ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {RATIOS.map((r) => (
                <button
                  key={r.label}
                  onClick={() => pickRatio(r.value)}
                  className={clsx('h-7 rounded-md px-2 text-xs', ratio === r.value ? 'bg-active font-medium' : 'text-muted hover:bg-hover hover:text-fg')}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <span className="mx-1 h-5 w-px bg-line" />
            <IconButton label="Turn left" onClick={() => turn(-90)}>
              <RotateCcw size={16} />
            </IconButton>
            <IconButton label="Turn right" onClick={() => turn(90)}>
              <RotateCw size={16} />
            </IconButton>
            <IconButton label="Flip left to right" onClick={() => change((e) => ({ flipH: !e.flipH }))}>
              <FlipHorizontal2 size={16} />
            </IconButton>
            <IconButton label="Flip upside down" onClick={() => change((e) => ({ flipV: !e.flipV }))}>
              <FlipVertical2 size={16} />
            </IconButton>
          </div>
        ) : (
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Slider label="Brightness" value={edits.brightness} min={30} max={200} unit="%" onChange={(v, end) => change({ brightness: v }, end)} />
            <Slider label="Contrast" value={edits.contrast} min={30} max={200} unit="%" onChange={(v, end) => change({ contrast: v }, end)} />
            <Slider label="Saturation" value={edits.saturation} min={0} max={250} unit="%" onChange={(v, end) => change({ saturation: v }, end)} />
            <Slider label="Size" value={Math.round(edits.scale * 100)} min={10} max={100} unit="%" onChange={(v, end) => change({ scale: v / 100 }, end)} />
          </div>
        )}
        {outSize && (
          <div className="mt-1.5 text-xs text-faint">
            Saves at {outSize.w} × {outSize.h} px
          </div>
        )}
      </div>
    </div>
  );
}

function ToolTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={clsx('flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm', active ? 'bg-active font-medium' : 'text-muted hover:bg-hover hover:text-fg')}>
      {icon}
      {label}
    </button>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** A slider whose moves aren't each kept for Undo: only where it's let go. */
function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number, end: boolean) => void }) {
  const started = useRef(false);
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          onChange(Number(e.target.value), !started.current);
          started.current = true;
        }}
        onPointerUp={() => (started.current = false)}
        onKeyUp={() => (started.current = false)}
        className="min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      <span className="w-12 shrink-0 text-end text-xs tabular-nums text-muted">
        {value}
        {unit}
      </span>
    </label>
  );
}
