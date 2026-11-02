import { ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '../components/ui';

// Choosing which part of a picture shows as a page cover, when its shape doesn't match the cover's.

/** The width ÷ height of a page cover on this screen. */
export function coverAspect(): number {
  const width = document.getElementById('app-main')?.clientWidth || window.innerWidth;
  const height = Math.min(280, Math.max(140, window.innerHeight * 0.28));
  return width / height;
}

/** Loads a picture file to read its size and draw it. */
export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That picture could not be opened'));
    img.src = URL.createObjectURL(file);
  });
}

interface Crop {
  x: number;
  y: number;
  w: number;
}

/**
 * Shows the picture with a frame of the cover's shape: drag the frame (or the picture) to choose
 * the part, and zoom to frame more or less of it. `onDone` gets the cropped picture, or the original.
 */
export function CoverCropDialog({
  file,
  image,
  aspect,
  onDone,
  onCancel,
}: {
  file: File;
  image: HTMLImageElement;
  aspect: number;
  /** The picture to upload, and (for animated GIFs, which aren't cut) the part to show. */
  onDone: (file: File, area?: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
}) {
  const animated = file.type === 'image/gif';
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  const maxW = Math.min(W, H * aspect);
  const minW = Math.max(40, maxW / 6);
  const [crop, setCrop] = useState<Crop>(() => ({ x: (W - maxW) / 2, y: (H - maxW / aspect) / 2, w: maxW }));
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; start: Crop } | null>(null);

  // The picture is shown scaled to fit the dialog.
  const viewW = Math.min(620, window.innerWidth - 64);
  const scale = Math.min(viewW / W, 380 / H);
  const shownW = W * scale;
  const shownH = H * scale;
  const h = crop.w / aspect;

  const clamp = (c: Crop): Crop => {
    const w = Math.max(minW, Math.min(maxW, c.w));
    return { w, x: Math.max(0, Math.min(W - w, c.x)), y: Math.max(0, Math.min(H - w / aspect, c.y)) };
  };

  useEffect(() => () => URL.revokeObjectURL(image.src), [image]);

  const zoom = (factor: number) =>
    setCrop((c) => {
      // Zoom around the frame's centre.
      const w = Math.max(minW, Math.min(maxW, c.w / factor));
      const cx = c.x + c.w / 2;
      const cy = c.y + c.w / aspect / 2;
      return clamp({ w, x: cx - w / 2, y: cy - w / aspect / 2 });
    });

  const done = async () => {
    if (animated) return onDone(file, { x: crop.x / W, y: crop.y / H, w: crop.w / W, h: h / H });
    setBusy(true);
    const outW = Math.round(Math.min(crop.w, 2400));
    const outH = Math.round(outW / aspect);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d')!.drawImage(image, crop.x, crop.y, crop.w, h, 0, 0, outW, outH);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
    setBusy(false);
    if (!blob) return onDone(file);
    const base = file.name.replace(/\.[^.]+$/, '') || 'cover';
    onDone(new File([blob], `${base}-cover.${type === 'image/png' ? 'png' : 'jpg'}`, { type }));
  };

  return (
    <Dialog open onClose={onCancel} title="Choose the part to show" width={Math.max(380, shownW + 48)}>
      <div className="px-5 pb-5">
        <p className="mb-3 text-sm text-muted">
          This picture is a different shape from the cover. Drag the frame to choose what shows, and zoom to show more or less.
          {animated && ' The GIF keeps moving.'}
        </p>
        <div
          ref={box}
          className="relative mx-auto touch-none overflow-hidden rounded-md bg-black select-none"
          style={{ width: shownW, height: shownH }}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, start: crop };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            setCrop(clamp({ ...d.start, x: d.start.x + (e.clientX - d.px) / scale, y: d.start.y + (e.clientY - d.py) / scale }));
          }}
          onPointerUp={() => (drag.current = null)}
          onWheel={(e) => zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)}
        >
          <img src={image.src} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" />
          <div
            className="absolute cursor-move rounded-sm border-2 border-white"
            style={{ left: crop.x * scale, top: crop.y * scale, width: crop.w * scale, height: h * scale, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => zoom(1 / 1.2)} className="rounded p-1 text-muted hover:bg-hover" title="Show more">
            <ZoomOut size={16} />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(((maxW - crop.w) / (maxW - minW || 1)) * 100)}
            onChange={(e) => {
              const w = maxW - (Number(e.target.value) / 100) * (maxW - minW);
              setCrop((c) => clamp({ w, x: c.x + (c.w - w) / 2, y: c.y + (c.w - w) / aspect / 2 }));
            }}
            className="flex-1"
            aria-label="Zoom"
          />
          <button onClick={() => zoom(1.2)} className="rounded p-1 text-muted hover:bg-hover" title="Show less (zoom in)">
            <ZoomIn size={16} />
          </button>
        </div>
        <div className="mt-4 flex justify-between gap-2">
          <Button variant="ghost" onClick={() => onDone(file)}>
            Use the whole picture
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={done}>
              Use this part
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
