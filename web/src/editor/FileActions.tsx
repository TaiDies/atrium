import { publicOrigin } from '../lib/native';
import { AudioLines, BookmarkCheck, Download, ExternalLink, FileText, Link2, Sparkles } from 'lucide-react';
import { type Anchor, Menu, MenuDivider, MenuItem, toast } from '../components/ui';
import { type RefObject, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { downloadUrl, viewerUrl } from '../lib/api';
import { useOpenFile } from '../lib/openFile';
import { positionLabel, useFilePositions } from '../lib/filePosition';

interface Target {
  key: string;
  top: number;
  right: number;
  url: string;
  name: string;
  /** Not for pictures: they have no place to stop at. */
  showPlace: boolean;
}

const SELECTOR = ['file', 'image', 'video', 'audio'].map((t) => `[data-content-type="${t}"]`).join(',');

function urlOf(el: Element): string | null {
  const direct = el.getAttribute('data-url');
  if (direct) return direct;
  const media = el.querySelector('img[src], video[src], audio[src], a[href]');
  return media?.getAttribute('src') ?? media?.getAttribute('href') ?? null;
}

/**
 * Always-visible "Open" and "Download" buttons next to every attachment in a document. They float in
 * an overlay beside the editor (not inside it), so they work on touch screens where there is no
 * right-click, and the editor never treats them as content.
 */
export function FileActions({
  container,
  onAskAi,
  onTranscribe,
}: {
  container: RefObject<HTMLDivElement | null>;
  onAskAi?: (blockId: string) => void;
  /** With an AI connection: turn an audio or video attachment into text below it. */
  onTranscribe?: (blockId: string, url: string) => void;
}) {
  const [targets, setTargets] = useState<Target[]>([]);
  // Right-clicking an attachment (or, with AI, a task) shows the app's menu instead of the browser's.
  const [context, setContext] = useState<{ at: Anchor; blockId: string | null; file: { url: string; name: string } | null; media: boolean } | null>(null);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const onContext = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const fileBlock = target?.closest?.(SELECTOR);
      const taskBlock = target?.closest?.('[data-content-type="event"]');
      const block = (fileBlock ?? taskBlock)?.closest('[data-id]');
      if (!fileBlock && !(taskBlock && onAskAi)) return;
      const url = fileBlock ? urlOf(fileBlock) : null;
      if (fileBlock && (!url || url.startsWith('blob:'))) return;
      e.preventDefault();
      const name = fileBlock ? fileBlock.getAttribute('data-name') || decodeURIComponent(url!.split('/').pop() ?? 'file') : '';
      const type = fileBlock?.getAttribute('data-content-type');
      const media = type === 'audio' || type === 'video' || /\.(mp3|m4a|wav|ogg|oga|webm|mp4|mov|flac|aac)$/i.test(name);
      setContext({ at: { x: e.clientX, y: e.clientY }, blockId: block?.getAttribute('data-id') ?? null, file: url ? { url, name } : null, media });
    };
    root.addEventListener('contextmenu', onContext);
    return () => root.removeEventListener('contextmenu', onContext);
  }, [container, onAskAi]);
  const navigate = useNavigate();
  const openFile = useOpenFile();

  // Clicking a file attachment opens it in the app's viewer, in this tab (Back returns to the page).
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const name = (e.target as Element | null)?.closest?.('.bn-file-name-with-icon');
      const block = name?.closest('[data-content-type="file"]');
      if (!name || !block || e.button !== 0) return;
      const url = urlOf(block);
      if (!url || url.startsWith('blob:')) return;
      e.preventDefault();
      e.stopPropagation();
      const label = block.getAttribute('data-name') || decodeURIComponent(url.split('/').pop() ?? 'file');
      openFile(url, label, e.ctrlKey || e.metaKey);
    };
    root.addEventListener('click', onClick, true);
    return () => root.removeEventListener('click', onClick, true);
  }, [container, openFile]);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const box = root.getBoundingClientRect();
        const next: Target[] = [];
        root.querySelectorAll(SELECTOR).forEach((el, i) => {
          const url = urlOf(el);
          if (!url || url.startsWith('blob:')) return;
          const rect = el.getBoundingClientRect();
          if (rect.height === 0) return;
          next.push({
            key: `${i}:${url}`,
            top: rect.top - box.top + 4,
            right: Math.max(4, box.right - rect.right + 4),
            url,
            name: el.getAttribute('data-name') || decodeURIComponent(url.split('/').pop() ?? 'file'),
            showPlace: el.getAttribute('data-content-type') !== 'image',
          });
        });
        setTargets((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      }, 60);
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-url', 'src', 'href', 'style'] });
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [container]);

  const places = useFilePositions(targets.filter((t) => t.showPlace).map((t) => t.url));

  const menu = (
    <Menu anchor={context?.at ?? null} onClose={() => setContext(null)}>
      {context?.file && (
        <>
          <MenuItem icon={<FileText size={15} />} label="Open" onClick={() => openFile(context.file!.url, context.file!.name)} />
          <MenuItem icon={<ExternalLink size={15} />} label="Open in a new tab" onClick={() => openFile(context.file!.url, context.file!.name, true)} />
          <MenuItem
            icon={<Download size={15} />}
            label="Download"
            onClick={() => {
              const a = document.createElement('a');
              a.href = downloadUrl(context.file!.url);
              a.download = context.file!.name;
              a.click();
            }}
          />
          <MenuItem
            icon={<Link2 size={15} />}
            label="Copy link"
            onClick={() => void navigator.clipboard.writeText(new URL(viewerUrl(context.file!.url, context.file!.name), publicOrigin()).toString()).then(() => toast('Link copied'))}
          />
        </>
      )}
      {onTranscribe && context?.blockId && context.file && context.media && (
        <>
          <MenuDivider />
          <MenuItem icon={<AudioLines size={15} />} label="Transcribe into text below" onClick={() => onTranscribe(context.blockId!, context.file!.url)} />
        </>
      )}
      {onAskAi && context?.blockId && (
        <>
          {context.file && !context.media && <MenuDivider />}
          <MenuItem icon={<Sparkles size={15} />} label={context.file ? 'Ask AI about this file' : 'Ask AI about this task'} onClick={() => onAskAi(context.blockId!)} />
        </>
      )}
    </Menu>
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {menu}
      {targets.map((t) => (
        <div key={t.key} className="pointer-events-auto absolute flex items-center gap-1" style={{ top: t.top, right: t.right }}>
          {t.showPlace && places.data && positionLabel(places.data(t.url)) && (
            <span className="flex h-8 items-center gap-1 rounded-md border border-line bg-surface/95 px-2 text-xs font-medium text-accent shadow-sm backdrop-blur sm:h-7" title="Where you stopped">
              <BookmarkCheck size={12} /> {positionLabel(places.data(t.url))}
            </span>
          )}
          <a
            href={viewerUrl(t.url, t.name)}
            target="_blank"
            rel="noreferrer"
            className="flex size-8 items-center justify-center rounded-md border border-line bg-surface/95 text-muted shadow-sm backdrop-blur hover:text-fg sm:size-7"
            title="Open in a new tab"
            aria-label={`Open ${t.name} in a new tab`}
          >
            <ExternalLink size={14} />
          </a>
          <a
            href={downloadUrl(t.url)}
            download={t.name}
            className="flex size-8 items-center justify-center rounded-md border border-line bg-surface/95 text-muted shadow-sm backdrop-blur hover:text-fg sm:size-7"
            title="Download"
            aria-label={`Download ${t.name}`}
          >
            <Download size={14} />
          </a>
        </div>
      ))}
    </div>
  );
}
