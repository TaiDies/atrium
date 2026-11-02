import { PenTool } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../lib/theme';
import { useBoardPreview } from './api';

/** A picture of a whiteboard's contents, drawn once it scrolls into view. */
export function BoardThumbnail({ boardId, empty, className }: { boardId: string; empty?: boolean; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const { resolved } = useTheme();
  const preview = useBoardPreview(boardId, visible && !empty);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const data = preview.data;
    if (!data || !data.elements.length) return setSvg(null);
    let cancelled = false;
    (async () => {
      const { exportToSvg } = await import('@excalidraw/excalidraw');
      // Images are fetched for the thumbnail too.
      const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {};
      for (const f of Object.values(data.files)) {
        try {
          const blob = await (await fetch(f.url, { credentials: 'same-origin' })).blob();
          files[f.id] = { id: f.id, mimeType: f.mimeType, created: f.created, dataURL: await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(blob); }) };
        } catch {}
      }
      const el = await exportToSvg({
        elements: data.elements as never,
        appState: { exportBackground: false, exportWithDarkMode: resolved === 'dark', viewBackgroundColor: 'transparent' } as never,
        files: files as never,
        exportPadding: 16,
      });
      el.setAttribute('width', '100%');
      el.setAttribute('height', '100%');
      el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      if (!cancelled) setSvg(el.outerHTML);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [preview.data, resolved]);

  return (
    <div ref={box} className={className}>
      {svg ? (
        <div className="size-full p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="flex size-full items-center justify-center text-faint">
          <PenTool size={26} />
        </div>
      )}
    </div>
  );
}
