import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';
import clsx from 'clsx';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { ChevronRight, ExternalLink, Globe, Link2, ListTree, MousePointerClick, RefreshCw, Settings2, Sigma } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { PageIcon } from '../app/PageIcon';
import { EmojiPicker } from '../components/EmojiPicker';
import { type Anchor, Popover, toastError } from '../components/ui';
import { api, pageTitle } from '../lib/api';
import { useDirectory } from '../lib/directory';
import { SyncedBlockView } from './SyncedBlock';

// More blocks: callouts, a table of contents, breadcrumbs, maths (KaTeX), web bookmarks and embeds,
// buttons that add content, columns and synced blocks.

/** Keeps keyboard and mouse events in a block's own controls away from the surrounding editor. */
function Controls({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const events = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'mousedown'];
    events.forEach((n) => el.addEventListener(n, stop));
    return () => events.forEach((n) => el.removeEventListener(n, stop));
  }, []);
  return (
    <div ref={ref} contentEditable={false} className={className}>
      {children}
    </div>
  );
}

// ---------- callout ----------

export const CALLOUT_COLORS: Record<string, string> = {
  gray: 'var(--hover)',
  blue: 'rgba(76, 137, 255, 0.14)',
  green: 'rgba(61, 195, 120, 0.14)',
  yellow: 'rgba(255, 206, 54, 0.2)',
  red: 'rgba(239, 68, 68, 0.13)',
  purple: 'rgba(156, 112, 255, 0.15)',
};

function CalloutIcon({ emoji, color, editable, onChange }: { emoji: string; color: string; editable: boolean; onChange: (p: { emoji?: string; color?: string }) => void }) {
  const [emojiAt, setEmojiAt] = useState<Anchor | null>(null);
  const [colorAt, setColorAt] = useState<Anchor | null>(null);
  return (
    <span contentEditable={false} className="group/callout flex shrink-0 flex-col items-center select-none">
      <button type="button" onClick={(e) => editable && setEmojiAt(e.currentTarget.getBoundingClientRect())} className="flex size-7 items-center justify-center rounded text-lg hover:bg-active" title="Change icon">
        {emoji || '💡'}
      </button>
      {editable && (
        <button
          type="button"
          onClick={(e) => setColorAt(e.currentTarget.getBoundingClientRect())}
          className="mt-0.5 size-3 rounded-full border border-line opacity-0 group-hover/callout:opacity-100"
          style={{ background: CALLOUT_COLORS[color] ?? CALLOUT_COLORS.gray }}
          title="Background colour"
        />
      )}
      <EmojiPicker anchor={emojiAt} onClose={() => setEmojiAt(null)} onPick={(e) => onChange({ emoji: e })} />
      <Popover anchor={colorAt} onClose={() => setColorAt(null)} className="flex gap-1.5 p-2">
        {Object.entries(CALLOUT_COLORS).map(([key, bg]) => (
          <button
            key={key}
            title={key}
            onClick={() => {
              onChange({ color: key });
              setColorAt(null);
            }}
            className={clsx('size-6 rounded border border-line', color === key && 'ring-2 ring-accent')}
            style={{ background: bg }}
          />
        ))}
      </Popover>
    </span>
  );
}

export const CalloutBlock = createReactBlockSpec(
  { type: 'callout', propSchema: { emoji: { default: '💡' }, color: { default: 'gray' } }, content: 'inline' },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="my-0.5 flex w-full items-start gap-2 rounded-lg px-3 py-2.5" style={{ background: CALLOUT_COLORS[block.props.color] ?? CALLOUT_COLORS.gray }}>
        <CalloutIcon emoji={block.props.emoji} color={block.props.color} editable={editor.isEditable} onChange={(p) => editor.updateBlock(block, { props: p })} />
        <div ref={contentRef} className="min-w-0 flex-1 pt-0.5" />
      </div>
    ),
  },
);

// ---------- table of contents and breadcrumbs ----------

interface Heading {
  id: string;
  level: number;
  text: string;
}

function headingsOf(blocks: any[], out: Heading[] = []): Heading[] {
  for (const b of blocks) {
    if (b.type === 'heading') {
      const text = Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : c.type === 'link' ? c.content?.map((x: any) => x.text).join('') : '')).join('') : '';
      out.push({ id: b.id, level: Number(b.props?.level ?? 1), text: text.trim() });
    }
    if (b.children?.length) headingsOf(b.children, out);
  }
  return out;
}

function TableOfContents({ editor }: { editor: any }) {
  const [headings, setHeadings] = useState<Heading[]>(() => headingsOf(editor.document));
  useEffect(() => editor.onChange(() => setHeadings(headingsOf(editor.document))), [editor]);
  const go = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.classList.add('block-flash');
    setTimeout(() => el?.classList.remove('block-flash'), 1500);
  };
  return (
    <Controls className="w-full rounded-lg border border-line/70 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-faint">
        <ListTree size={13} /> Contents
      </div>
      {headings.length ? (
        headings.map((h) => (
          <button key={h.id} onClick={() => go(h.id)} className="block w-full truncate rounded px-1 py-0.5 text-start text-sm text-muted hover:bg-hover hover:text-fg" style={{ paddingLeft: 4 + (h.level - 1) * 16 }}>
            {h.text || 'Untitled heading'}
          </button>
        ))
      ) : (
        <p className="px-1 text-sm text-faint">Add headings to the page and they’ll be listed here.</p>
      )}
    </Controls>
  );
}

export const TocBlock = createReactBlockSpec({ type: 'toc', propSchema: {}, content: 'none' }, { render: ({ editor }) => <TableOfContents editor={editor} /> });

function Breadcrumbs() {
  const dir = useDirectory();
  const { pageId } = useParams();
  const pages = dir?.pages ?? [];
  const trail: typeof pages = [];
  for (let p = pages.find((x) => x.id === pageId); p; p = pages.find((x) => x.id === p!.parentId)) trail.unshift(p);
  return (
    <Controls className="flex w-full flex-wrap items-center gap-1 text-sm text-muted">
      {trail.map((p, i) => (
        <span key={p.id} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={13} className="text-faint" />}
          <button onClick={() => dir?.navigate(`/w/${dir.workspaceId}/p/${p.id}`)} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover hover:text-fg">
            <PageIcon page={p} size={14} />
            <span className="max-w-[200px] truncate">{pageTitle(p)}</span>
          </button>
        </span>
      ))}
    </Controls>
  );
}

export const BreadcrumbsBlock = createReactBlockSpec({ type: 'breadcrumbs', propSchema: {}, content: 'none' }, { render: () => <Breadcrumbs /> });

// ---------- maths ----------

function renderTex(latex: string, display: boolean) {
  try {
    return { html: katex.renderToString(latex || '\\text{…}', { displayMode: display, throwOnError: true, output: 'html' }), error: null };
  } catch (err) {
    return { html: '', error: err instanceof Error ? err.message.replace(/^KaTeX parse error: /, '') : 'Invalid formula' };
  }
}

function TexEditor({ latex, onChange, onClose, anchor, display }: { latex: string; onChange: (v: string) => void; onClose: () => void; anchor: Anchor | null; display: boolean }) {
  const [value, setValue] = useState(latex);
  useEffect(() => setValue(latex), [latex, anchor]);
  const preview = renderTex(value, display);
  return (
    <Popover anchor={anchor} onClose={() => (onChange(value), onClose())} className="w-[min(420px,90vw)] p-2">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !display)) {
            e.preventDefault();
            onChange(value);
            onClose();
          }
        }}
        rows={display ? 3 : 1}
        spellCheck={false}
        placeholder={display ? 'e.g. \\int_0^1 x^2 \\, dx = \\frac{1}{3}' : 'e.g. E = mc^2'}
        className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
      />
      <div className="mt-1 text-xs">{preview.error ? <span className="text-red-500">{preview.error}</span> : <span className="text-muted">{display ? 'Ctrl+Enter to finish' : 'Enter to finish'} · LaTeX</span>}</div>
    </Popover>
  );
}

function MathBlockView({ latex, editable, onChange }: { latex: string; editable: boolean; onChange: (v: string) => void }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { html, error } = renderTex(latex, true);
  return (
    <Controls className="w-full">
      <div
        ref={ref}
        onClick={() => editable && setAnchor(ref.current!.getBoundingClientRect())}
        className={clsx('min-h-10 w-full overflow-x-auto rounded-md px-3 py-2 text-center', editable && 'cursor-pointer hover:bg-hover')}
      >
        {!latex ? (
          <span className="flex items-center justify-center gap-1.5 text-sm text-faint">
            <Sigma size={15} /> Click to add a formula
          </span>
        ) : error ? (
          <span className="text-sm text-red-500">{error}</span>
        ) : (
          <span dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
      <TexEditor latex={latex} display anchor={anchor} onClose={() => setAnchor(null)} onChange={(v) => v !== latex && onChange(v)} />
    </Controls>
  );
}

export const MathBlock = createReactBlockSpec(
  { type: 'math', propSchema: { latex: { default: '' } }, content: 'none' },
  { render: ({ block, editor }) => <MathBlockView latex={block.props.latex} editable={editor.isEditable} onChange={(latex) => editor.updateBlock(block, { props: { latex } })} /> },
);

function InlineMathView({ latex, editable, onChange }: { latex: string; editable: boolean; onChange: (v: string) => void }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  // A new formula opens for typing straight away.
  useEffect(() => {
    if (!latex && editable && ref.current) setAnchor(ref.current.getBoundingClientRect());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { html, error } = renderTex(latex, false);
  return (
    <span ref={ref} contentEditable={false} onClick={() => editable && setAnchor(ref.current!.getBoundingClientRect())} className={clsx('rounded px-0.5', editable && 'cursor-pointer hover:bg-hover')}>
      {!latex ? <span className="text-faint">√x</span> : error ? <span className="text-red-500">{latex}</span> : <span dangerouslySetInnerHTML={{ __html: html }} />}
      <TexEditor latex={latex} display={false} anchor={anchor} onClose={() => setAnchor(null)} onChange={(v) => v !== latex && onChange(v)} />
    </span>
  );
}

export const InlineMath = createReactInlineContentSpec(
  { type: 'inlineMath', propSchema: { latex: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <InlineMathView latex={inlineContent.props.latex} editable={editor.isEditable} onChange={(latex) => updateInlineContent({ type: 'inlineMath', props: { latex } })} />
    ),
  },
);

// ---------- web bookmarks and embeds ----------

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
  icon: string;
  site: string;
}

function UrlPrompt({ placeholder, onSubmit, busy }: { placeholder: string; onSubmit: (url: string) => void; busy?: boolean }) {
  const [url, setUrl] = useState('');
  return (
    <Controls className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) onSubmit(url.trim());
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2"
      >
        <Link2 size={15} className="text-faint" />
        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <button type="submit" disabled={busy || !url.trim()} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
          {busy ? '…' : 'Add'}
        </button>
      </form>
    </Controls>
  );
}

const withScheme = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

export async function fetchPreview(url: string): Promise<LinkPreview> {
  return api<LinkPreview>(`/api/link-preview?url=${encodeURIComponent(withScheme(url))}`);
}

function BookmarkView({ block, editor }: { block: any; editor: any }) {
  const [busy, setBusy] = useState(false);
  const p = block.props as LinkPreview;
  const load = async (url: string) => {
    setBusy(true);
    try {
      const preview = await fetchPreview(url);
      editor.updateBlock(block, { props: { ...preview } });
    } catch {
      // No preview (offline, or the site refused): keep the link anyway.
      editor.updateBlock(block, { props: { url: withScheme(url), title: withScheme(url), description: '', image: '', icon: '', site: '' } });
    } finally {
      setBusy(false);
    }
  };
  if (!p.url) return editor.isEditable ? <UrlPrompt placeholder="Paste a link to make a bookmark…" onSubmit={load} busy={busy} /> : null;
  return (
    <Controls className="w-full">
      <a href={p.url} target="_blank" rel="noreferrer noopener" className="group flex w-full overflow-hidden rounded-lg border border-line hover:bg-hover">
        <div className="min-w-0 flex-1 px-3 py-2.5">
          <div className="truncate text-sm font-medium">{p.title || p.url}</div>
          {p.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{p.description}</div>}
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
            {p.icon ? <img src={p.icon} alt="" className="size-3.5" onError={(e) => (e.currentTarget.style.display = 'none')} /> : <Globe size={12} />}
            <span className="truncate">{p.site || new URL(p.url).hostname}</span>
          </div>
        </div>
        {p.image && <img src={p.image} alt="" className="hidden h-[88px] w-[160px] shrink-0 object-cover sm:block" onError={(e) => (e.currentTarget.style.display = 'none')} />}
        {editor.isEditable && (
          <button
            onClick={(e) => {
              e.preventDefault();
              load(p.url);
            }}
            title="Refresh preview"
            className="m-1 self-start rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-active"
          >
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          </button>
        )}
      </a>
    </Controls>
  );
}

export const BookmarkBlock = createReactBlockSpec(
  { type: 'bookmark', propSchema: { url: { default: '' }, title: { default: '' }, description: { default: '' }, image: { default: '' }, icon: { default: '' }, site: { default: '' } }, content: 'none' },
  { render: ({ block, editor }) => <BookmarkView block={block} editor={editor} /> },
);

/** The address that shows a link inside the page, for sites that allow it (YouTube, Vimeo, Loom, Figma, Maps…). */
export function embedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(withScheme(raw.trim()));
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const id = u.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(u.pathname)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
  if (host === 'vimeo.com') return /^\/(\d+)/.test(u.pathname) ? `https://player.vimeo.com/video/${u.pathname.split('/')[1]}` : null;
  if (host === 'loom.com') return u.pathname.startsWith('/share/') ? `https://www.loom.com/embed/${u.pathname.split('/')[2]}` : null;
  if (host === 'figma.com') return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(u.toString())}`;
  if (host === 'open.spotify.com') return `https://open.spotify.com/embed${u.pathname}`;
  if (host === 'codepen.io') return u.toString().replace('/pen/', '/embed/');
  if (host === 'google.com' && u.pathname.startsWith('/maps')) return `https://maps.google.com/maps?q=${encodeURIComponent(u.searchParams.get('q') ?? u.pathname.split('/place/')[1]?.split('/')[0] ?? '')}&output=embed`;
  if (host === 'docs.google.com') return u.toString().replace(/\/(edit|view)(\?.*)?$/, '/preview');
  if (host === 'drive.google.com' && u.pathname.includes('/file/d/')) return u.toString().replace(/\/view.*$/, '/preview');
  if (host === 'miro.com' && u.pathname.startsWith('/app/board/')) return `https://miro.com/app/live-embed/${u.pathname.split('/')[3]}/`;
  if (host === 'calendar.google.com' && u.pathname.includes('/embed')) return u.toString();
  if (host === 'airtable.com' && u.pathname.startsWith('/embed/')) return u.toString();
  return null;
}

function EmbedView({ block, editor }: { block: any; editor: any }) {
  const url: string = block.props.url;
  const src = url ? embedUrl(url) : null;
  if (!url) {
    return editor.isEditable ? (
      <UrlPrompt
        placeholder="Paste a YouTube, Vimeo, Loom, Figma, Google Maps/Docs, Spotify… link"
        onSubmit={(u) => {
          if (!embedUrl(u)) return toastError(new Error('That site can’t be shown inside a page — try a bookmark instead'));
          editor.updateBlock(block, { props: { url: withScheme(u) } });
        }}
      />
    ) : null;
  }
  return (
    <Controls className="w-full">
      {src ? (
        <div className="overflow-hidden rounded-lg border border-line bg-hover">
          <iframe
            src={src}
            title="Embedded content"
            className="w-full"
            style={{ height: Number(block.props.height) || 360 }}
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
            loading="lazy"
          />
          <a href={url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-fg">
            <ExternalLink size={11} /> <span className="truncate">{url}</span>
          </a>
        </div>
      ) : (
        <a href={url} target="_blank" rel="noreferrer noopener" className="text-sm text-accent underline">
          {url}
        </a>
      )}
    </Controls>
  );
}

export const EmbedBlock = createReactBlockSpec(
  { type: 'embed', propSchema: { url: { default: '' }, height: { default: '360' } }, content: 'none' },
  { render: ({ block, editor }) => <EmbedView block={block} editor={editor} /> },
);

// ---------- buttons ----------

const localDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** "@today" and "@tomorrow" in a button's text become date chips (so the new to-dos show on Today). */
function withDates(blocks: any[]): any[] {
  return blocks.map((b) => ({
    ...b,
    content: Array.isArray(b.content)
      ? b.content.flatMap((c: any) => {
          if (c.type !== 'text' || !/@(today|tomorrow)/.test(c.text)) return [c];
          return c.text.split(/(@today|@tomorrow)/).filter(Boolean).map((part: string) =>
            part === '@today' || part === '@tomorrow' ? { type: 'dateMention', props: { date: localDay(part === '@today' ? 0 : 1) } } : { ...c, text: part },
          );
        })
      : b.content,
    children: b.children?.length ? withDates(b.children) : b.children,
  }));
}

function ButtonView({ block, editor }: { block: any; editor: any }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const { label, action, markdown, url } = block.props;
  const run = () => {
    if (action === 'link') {
      if (url) window.open(withScheme(url), '_blank', 'noopener');
      return;
    }
    if (!editor.isEditable) return;
    if (!markdown.trim()) return setAnchor(document.activeElement?.getBoundingClientRect() ?? null);
    const blocks = withDates(editor.tryParseMarkdownToBlocks(markdown));
    if (blocks.length) editor.insertBlocks(blocks, block, 'after');
  };
  return (
    <Controls className="group flex w-full items-center gap-1">
      <button onClick={run} className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-hover">
        <MousePointerClick size={14} className="text-accent" />
        {label || 'Button'}
      </button>
      {editor.isEditable && (
        <button onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} title="Set up the button" className="rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg">
          <Settings2 size={14} />
        </button>
      )}
      <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-[min(380px,90vw)] space-y-2 p-3">
        <label className="block text-xs text-muted">
          Button text
          <input
            defaultValue={label}
            onBlur={(e) => editor.updateBlock(block, { props: { label: e.target.value } })}
            className="mt-1 h-8 w-full rounded-md border border-line bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
          />
        </label>
        <label className="block text-xs text-muted">
          When clicked
          <select value={action} onChange={(e) => editor.updateBlock(block, { props: { action: e.target.value } })} className="mt-1 h-8 w-full rounded-md border border-line bg-bg px-2 text-sm text-fg">
            <option value="insert">Add these blocks below it</option>
            <option value="link">Open a link</option>
          </select>
        </label>
        {action === 'link' ? (
          <input defaultValue={url} placeholder="https://…" onBlur={(e) => editor.updateBlock(block, { props: { url: e.target.value } })} className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent" />
        ) : (
          <>
            <textarea
              defaultValue={markdown}
              rows={5}
              placeholder={'- [ ] Water the plants @today\n- [ ] Review notes'}
              onBlur={(e) => editor.updateBlock(block, { props: { markdown: e.target.value } })}
              className="w-full rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
            />
            <p className="text-xs text-faint">Markdown: “- [ ]” to-dos, “#” headings, lists… @today and @tomorrow become dates.</p>
          </>
        )}
      </Popover>
    </Controls>
  );
}

export const ButtonBlock = createReactBlockSpec(
  { type: 'button', propSchema: { label: { default: 'New to-do' }, action: { default: 'insert' }, markdown: { default: '- [ ] @today' }, url: { default: '' } }, content: 'none' },
  { render: ({ block, editor }) => <ButtonView block={block} editor={editor} /> },
);

// ---------- columns ----------
// A column list holds columns side by side; each column holds ordinary blocks (as its nested blocks).
// Laid out with CSS (see styles.css); the blocks themselves show nothing.

export const ColumnListBlock = createReactBlockSpec({ type: 'columnList', propSchema: {}, content: 'none' }, { render: () => <div className="h-0" contentEditable={false} /> });
export const ColumnBlock = createReactBlockSpec({ type: 'column', propSchema: {}, content: 'none' }, { render: () => <div className="h-0" contentEditable={false} /> });

// ---------- synced blocks ----------

export const SyncedBlock = createReactBlockSpec(
  { type: 'synced', propSchema: { pageId: { default: '' }, syncId: { default: '' } }, content: 'none' },
  { render: ({ block, editor }) => <SyncedBlockView pageId={block.props.pageId} syncId={block.props.syncId} editable={editor.isEditable} onSet={(props) => editor.updateBlock(block, { props })} /> },
);
