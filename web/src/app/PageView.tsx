import clsx from 'clsx';
import { ChevronRight, Copy, FileDown, Layers, Network, LayoutTemplate, MessageSquare, Search, Type, Download, Eye, ImagePlus, Link2, MoreHorizontal, PackageOpen, RotateCcw, Share2, Smile, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { EmojiPicker, randomEmoji } from '../components/EmojiPicker';
import { type Anchor, Avatar, Button, confirmDialog, FullScreenSpinner, IconButton, Menu, MenuDivider, MenuItem, Popover, toast, toastError } from '../components/ui';
import { api, ApiError, canEdit, type PageDetail, pageTitle, uploadFile } from '../lib/api';
import { ShareDialog } from './ShareDialog';
import { rememberVisit } from './SearchDialog';
import { type Peer, useCollab, usePeers } from '../lib/collab';
import { COVERS, coverStyle, isImageCover, randomCover } from '../lib/covers';
import { invalidatePages, patchPageCache, setFavorite, updatePage, usePage } from '../lib/queries';
import { timeAgo } from '../lib/time';
import { DatabaseView } from '../database/DatabaseView';
import type { ViewType } from '../database/model';
import { useApp } from './context';
import { DocumentEditor, type EditorHandle } from './DocumentEditor';
import { ExportDialog } from './ExportDialog';
import { ancestors, copyPageLink, duplicatePage, trashPage } from './pageActions';
import { PageIcon } from './PageIcon';
import { SidebarIcon } from '../notifications/Notifications';
import { SaveTemplateDialog } from '../templates/TemplatesDialog';
import { WordCountDialog } from './WordCount';
import { CoverCropDialog, coverAspect, loadImage } from './CoverCrop';
import { HistoryDialog, PageBadges, PageSettingsItems } from './PageExtras';
import { FlashcardsDialog } from '../study/Flashcards';
import { exportPagePdf } from '../lib/pdfExport';

export function PageView() {
  const { pageId } = useParams();
  const { pages, expand } = useApp();
  const page = usePage(pageId);

  useEffect(() => {
    if (pageId) ancestors(pages, pageId).forEach((a) => expand(a.id));
  }, [pageId]);

  if (page.isPending) return <FullScreenSpinner />;
  if (page.error || !page.data) {
    const notFound = page.error instanceof ApiError && page.error.status === 404;
    return <Missing message={notFound ? "This page doesn't exist or you don't have access to it." : 'Could not load this page.'} />;
  }
  if (page.data.deletedAt) return <TrashedPageNotice page={page.data} />;
  return <PageContent key={page.data.id} page={page.data} />;
}

function PageContent({ page }: { page: PageDetail }) {
  const { workspace, user } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const editorRef = useRef<EditorHandle | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const { session, synced, status, denied } = useCollab(page.id, user, () => invalidatePages(workspace.id, page.id));
  const peers = usePeers(session?.provider);
  const [iconPicker, setIconPicker] = useState<Anchor | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // Comment notifications link here with ?comments=open.
  useEffect(() => {
    if (new URLSearchParams(location.search).get('comments') === 'open') setCommentsOpen(true);
  }, [location.search]);
  useEffect(() => rememberVisit(workspace.id, page.id), [workspace.id, page.id]);
  const isDatabase = page.type !== 'document';
  // A locked page can't be edited by accident (anyone who can edit can unlock it).
  const readOnly = !canEdit(page.access) || !!page.locked;
  const wide = isDatabase || !!page.layout?.fullWidth;

  useEffect(() => {
    if ((location.state as { focusTitle?: boolean } | null)?.focusTitle) {
      titleRef.current?.focus();
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  const focusEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const first = editor.document[0];
    if (first) editor.setTextCursorPosition(first, 'start');
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader page={page} peers={peers} status={status} editorRef={editorRef} onToggleComments={page.type === 'document' ? () => setCommentsOpen((v) => !v) : undefined} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Cover page={page} />

        <div className={clsx('mx-auto w-full px-6 sm:px-[54px]', wide ? 'max-w-none' : 'max-w-(--page-width)', !page.cover && 'pt-14')}>
          <div className="group/title relative">
            {page.icon && (
              <button
                disabled={readOnly}
                onClick={(e) => setIconPicker(e.currentTarget.getBoundingClientRect())}
                className={clsx('rounded-lg text-[64px] leading-none transition-colors', !readOnly && 'hover:bg-hover', page.cover && '-mt-10')}
              >
                {page.icon}
              </button>
            )}
            <div className="hover-reveal flex h-9 items-center gap-1 opacity-0 transition-opacity group-hover/title:opacity-100 focus-within:opacity-100">
              {!readOnly && !page.icon && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => updatePage(workspace.id, page.id, { icon: randomEmoji() }).catch(toastError)}
                >
                  <Smile size={14} /> Add icon
                </Button>
              )}
              {!readOnly && !page.cover && (
                <Button variant="ghost" size="sm" onClick={() => updatePage(workspace.id, page.id, { cover: randomCover() }).catch(toastError)}>
                  <ImagePlus size={14} /> Add cover
                </Button>
              )}
            </div>
            <TitleInput page={page} inputRef={titleRef} readOnly={readOnly} onEnter={isDatabase ? undefined : focusEditor} />
            <PageBadges page={page} />
          </div>
        </div>

        <div className={clsx('mx-auto w-full', wide ? 'max-w-none' : 'max-w-(--page-width)', page.layout?.smallText && 'page-small-text')}>
          {denied ? (
            <Missing message="You no longer have access to this page." />
          ) : !session || !synced ? (
            <div className="flex justify-center py-16 text-muted">
              <span className="inline-block size-5 animate-spin rounded-full border-2 border-current border-e-transparent" />
            </div>
          ) : isDatabase ? (
            <div className="pt-2">
              <DatabaseView doc={session.doc} pageId={page.id} pageType={page.type as ViewType} workspaceId={workspace.id} readOnly={readOnly} />
            </div>
          ) : (
            <div className="pt-2">
              <DocumentEditor
                session={session}
                user={user}
                workspaceId={workspace.id}
                parentPageId={page.id}
                editorRef={editorRef}
                readOnly={readOnly}
                commentsOpen={commentsOpen}
                onCloseComments={() => setCommentsOpen(false)}
                findable
              />
            </div>
          )}
        </div>
      </div>

      <EmojiPicker
        anchor={iconPicker}
        onClose={() => setIconPicker(null)}
        onPick={(icon) => updatePage(workspace.id, page.id, { icon }).catch(toastError)}
        onRemove={() => updatePage(workspace.id, page.id, { icon: '' }).catch(toastError)}
      />
    </div>
  );
}

function TitleInput({
  page,
  inputRef,
  onEnter,
  readOnly,
}: {
  page: PageDetail;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onEnter?: () => void;
  readOnly?: boolean;
}) {
  const { workspace } = useApp();
  const [value, setValue] = useState(page.title);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!focused.current) setValue(page.title);
  }, [page.title]);

  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current === null) return;
    const title = pending.current;
    pending.current = null;
    api(`/api/pages/${page.id}`, { method: 'PATCH', body: { title } }).catch(toastError);
  };

  useEffect(() => flush, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, inputRef]);

  return (
    <textarea
      ref={inputRef}
      rows={1}
      value={value}
      placeholder="Untitled"
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        flush();
      }}
      onChange={(e) => {
        const title = e.target.value.replace(/\n/g, '');
        setValue(title);
        patchPageCache(workspace.id, page.id, { title });
        pending.current = title;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, 500);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          flush();
          onEnter?.();
        }
      }}
      readOnly={readOnly}
      className="block w-full resize-none overflow-hidden bg-transparent pb-2 text-[30px] leading-tight font-bold tracking-tight outline-none placeholder:text-faint/60 sm:text-[40px]"
    />
  );
}

function PageHeader({
  page,
  peers,
  status,
  editorRef,
  onToggleComments,
}: {
  page: PageDetail;
  peers: Peer[];
  status: string;
  editorRef: React.RefObject<EditorHandle | null>;
  onToggleComments?: () => void;
}) {
  const { workspace, pages, sidebarOpen, toggleSidebar, canCreatePages } = useApp();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [counting, setCounting] = useState(false);
  const [history, setHistory] = useState(false);
  const [flashcards, setFlashcards] = useState(false);
  const editable = canEdit(page.access);
  const crumbs = [...ancestors(pages, page.id), pages.find((p) => p.id === page.id) ?? page];

  const exportMarkdown = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const md = `# ${pageTitle(page)}\n\n${editor.blocksToMarkdownLossy(editor.document)}`;
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pageTitle(page).replace(/[\\/:*?"<>|]/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 px-3">
      {!sidebarOpen && (
        <IconButton onClick={toggleSidebar} title="Open sidebar">
          <SidebarIcon />
        </IconButton>
      )}
      <nav className="flex min-w-0 flex-1 items-center gap-0.5 text-sm">
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <ChevronRight size={13} className="shrink-0 text-faint" />}
            <Link
              to={`/w/${workspace.id}/p/${c.id}`}
              className={clsx('flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-hover', i === crumbs.length - 1 ? 'text-fg' : 'text-muted')}
            >
              <PageIcon page={c} size={14} />
              <span className="max-w-[180px] truncate">{pageTitle(c)}</span>
            </Link>
          </span>
        ))}
      </nav>

      {status !== 'connected' && (
        <span className="flex items-center gap-1.5 text-xs text-muted" title="Changes are kept locally and synced when the connection returns">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
          {status === 'connecting' ? 'Connecting…' : 'Offline'}
        </span>
      )}

      {peers.length > 0 && (
        <div className="flex items-center -space-x-1.5" title={peers.map((p) => p.name).join(', ')}>
          {peers.slice(0, 4).map((p) => (
            <Avatar key={p.clientId} name={p.name} color={p.color} size={24} className="ring-2 ring-bg" title={`${p.name} is here`} />
          ))}
          {peers.length > 4 && (
            <span className="flex size-6 items-center justify-center rounded-full bg-active text-[10px] font-medium ring-2 ring-bg">+{peers.length - 4}</span>
          )}
        </div>
      )}

      <span className="hidden text-xs text-faint sm:inline">Edited {timeAgo(page.updatedAt)}</span>

      {page.access === 'view' && (
        <span className="flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-xs text-muted" title="You can read this page but not change it">
          <Eye size={13} /> View only
        </span>
      )}
      {page.access === 'manage' && (
        <Button size="sm" variant="ghost" onClick={() => setSharing(true)}>
          <Share2 size={14} /> <span className="hidden sm:inline">Share</span>
        </Button>
      )}
      <ShareDialog page={page} open={sharing} onClose={() => setSharing(false)} />
      {onToggleComments && (
        <IconButton onClick={onToggleComments} title="Comments">
          <MessageSquare size={16} />
        </IconButton>
      )}

      <IconButton
        onClick={() => setFavorite(workspace.id, page.id, !page.isFavorite).catch(toastError)}
        title={page.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Star size={16} className={page.isFavorite ? 'fill-amber-400 text-amber-400' : ''} />
      </IconButton>
      <IconButton onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} title="More">
        <MoreHorizontal size={17} />
      </IconButton>

      <Menu anchor={menu} onClose={() => setMenu(null)} align="end">
        {editable && canCreatePages && (
          <MenuItem
            icon={<Copy size={15} />}
            label="Duplicate"
            onClick={async () => {
              try {
                navigate(`/w/${workspace.id}/p/${await duplicatePage(workspace.id, page.id)}`);
              } catch (err) {
                toastError(err);
              }
            }}
          />
        )}
        <MenuItem icon={<Link2 size={15} />} label="Copy link" onClick={() => copyPageLink(workspace.id, page.id)} />
        <MenuDivider />
        <MenuItem icon={<Layers size={15} />} label="Flashcards & quiz" onClick={() => setFlashcards(true)} />
        <MenuItem icon={<Network size={15} />} label="Local graph" onClick={() => navigate(`/w/${workspace.id}/graph?focus=${page.id}`)} />
        <PageSettingsItems page={page} onHistory={() => setHistory(true)} />
        {editable && <MenuItem icon={<LayoutTemplate size={15} />} label="Save as template…" onClick={() => setSavingTemplate(true)} />}
        {page.type === 'document' && <MenuItem icon={<Search size={15} />} label="Find in page" hint="Ctrl+F" onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))} />}
        {page.type === 'document' && <MenuItem icon={<Type size={15} />} label="Word count" onClick={() => setCounting(true)} />}
        <MenuItem icon={<PackageOpen size={15} />} label="Export…" onClick={() => setExporting(true)} />
        {page.type === 'document' && <MenuItem icon={<Download size={15} />} label="Export as Markdown" onClick={exportMarkdown} />}
        {page.type === 'document' && (
          <MenuItem icon={<FileDown size={15} />} label="Export as PDF" onClick={() => editorRef.current && void exportPagePdf(editorRef.current, pageTitle(page), workspace.id)} />
        )}
        {editable && (
          <>
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={15} />}
              label="Move to trash"
              danger
              onClick={async () => {
                const removed = await trashPage(workspace.id, pages, page.id);
                if (removed.size) navigate(`/w/${workspace.id}`);
              }}
            />
          </>
        )}
        <MenuDivider />
        <div className="px-2 py-1.5 text-xs leading-relaxed text-faint">
          {page.updatedByName ? `Last edited by ${page.updatedByName}` : 'Last edited'} {timeAgo(page.updatedAt)}
          <br />
          Created {page.createdByName ? `by ${page.createdByName} ` : ''}
          {timeAgo(page.createdAt)}
        </div>
      </Menu>
      {exporting && <ExportDialog page={page} onClose={() => setExporting(false)} />}
      {savingTemplate && <SaveTemplateDialog page={page} open onClose={() => setSavingTemplate(false)} />}
      {counting && <WordCountDialog editor={editorRef.current} onClose={() => setCounting(false)} />}
      {history && <HistoryDialog page={page} onClose={() => setHistory(false)} />}
      {flashcards && <FlashcardsDialog pageId={page.id} pageTitle={page.title} workspaceId={workspace.id} onClose={() => setFlashcards(false)} />}
    </header>
  );
}

function Cover({ page }: { page: PageDetail }) {
  const { workspace } = useApp();
  const [picker, setPicker] = useState<Anchor | null>(null);
  const [cropping, setCropping] = useState<{ file: File; image: HTMLImageElement } | null>(null);
  const crop =
    cropping &&
    createPortal(
      <CoverCropDialog
        file={cropping.file}
        image={cropping.image}
        aspect={coverAspect()}
        onCancel={() => setCropping(null)}
        onDone={async (file, area) => {
          setCropping(null);
          try {
            const url = await uploadFile(workspace.id, file);
            const cover = area ? `${url}#crop=${[area.x, area.y, area.w, area.h].map((n) => n.toFixed(4)).join(',')}` : url;
            await updatePage(workspace.id, page.id, { cover });
          } catch (err) {
            toastError(err);
          }
        }}
      />,
      document.body,
    );
  if (!page.cover) return null;
  return (
    <div className="group relative h-[28vh] max-h-[280px] min-h-[140px] w-full" style={{ background: coverStyle(page.cover) }}>
      {crop}
      <div className={clsx('hover-reveal absolute end-4 bottom-3 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100', !canEdit(page.access) && 'hidden')}>
        <button
          onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}
          className="rounded-md bg-white/85 px-2.5 py-1 text-xs font-medium text-neutral-800 shadow-sm backdrop-blur hover:bg-white"
        >
          Change cover
        </button>
        <button
          onClick={() => updatePage(workspace.id, page.id, { cover: null }).catch(toastError)}
          className="rounded-md bg-white/85 px-2.5 py-1 text-xs font-medium text-neutral-800 shadow-sm backdrop-blur hover:bg-white"
        >
          Remove
        </button>
      </div>
      <Popover anchor={picker} onClose={() => setPicker(null)} align="end" className="w-[300px] p-2">
        <CoverUpload
          current={page.cover}
          onPick={(cover) => {
            updatePage(workspace.id, page.id, { cover }).catch(toastError);
            setPicker(null);
          }}
          onCrop={(file, image) => {
            setPicker(null);
            setCropping({ file, image });
          }}
        />
        <div className="mt-2 mb-1 text-xs font-medium text-faint">Colours</div>
        <div className="grid grid-cols-5 gap-1.5">
          {Object.entries(COVERS).map(([key, bg]) => (
            <button
              key={key}
              title={key}
              onClick={() => {
                updatePage(workspace.id, page.id, { cover: key }).catch(toastError);
                setPicker(null);
              }}
              className={clsx('h-10 rounded-md ring-offset-2 ring-offset-surface hover:ring-2 hover:ring-accent', page.cover === key && 'ring-2 ring-accent')}
              style={{ background: bg }}
            />
          ))}
        </div>
      </Popover>
    </div>
  );
}

/** A picture as a page cover: uploaded, or from a web address; and moving it up or down. */
function CoverUpload({ current, onPick, onCrop }: { current: string | null; onPick: (cover: string) => void; onCrop: (file: File, image: HTMLImageElement) => void }) {
  const { workspace } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const image = isImageCover(current);
  const [url, y = '50'] = (current ?? '').split('#y=');
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toastError(new Error('Choose a picture (PNG, JPG, WebP, GIF…)'));
    // A picture of a different shape from the cover: choose which part shows.
    {
      try {
        const image = await loadImage(file);
        const ratio = image.naturalWidth / image.naturalHeight / coverAspect();
        if (ratio < 0.85 || ratio > 1.15) return onCrop(file, image);
        URL.revokeObjectURL(image.src);
      } catch (err) {
        return toastError(err);
      }
    }
    setBusy(true);
    try {
      onPick(await uploadFile(workspace.id, file));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-faint">Picture</div>
      <Button size="sm" className="w-full" loading={busy} onClick={() => input.current?.click()}>
        <ImagePlus size={14} /> Upload an image
      </Button>
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (/^https?:\/\/\S+$/i.test(link.trim())) onPick(link.trim());
          else toastError(new Error('Paste an image address starting with http(s)://'));
        }}
        className="flex gap-1"
      >
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="…or paste an image link" className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-xs outline-none focus:border-accent" />
        <button type="submit" className="rounded-md border border-line px-2 text-xs hover:bg-hover">
          Use
        </button>
      </form>
      {image && !(current ?? '').includes('#crop=') && (
        <label className="flex items-center gap-2 text-xs text-muted">
          Position
          <input type="range" min={0} max={100} defaultValue={Number(y) || 50} onMouseUp={(e) => onPick(`${url}#y=${(e.target as HTMLInputElement).value}`)} onTouchEnd={(e) => onPick(`${url}#y=${(e.target as HTMLInputElement).value}`)} className="flex-1" />
        </label>
      )}
    </div>
  );
}

function TrashedPageNotice({ page }: { page: PageDetail }) {
  const { workspace } = useApp();
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="text-5xl">{page.icon || '🗑️'}</div>
      <div>
        <h2 className="text-lg font-semibold">“{pageTitle(page)}” is in the trash</h2>
        <p className="mt-1 text-sm text-muted">Restore it to keep editing, or delete it permanently.</p>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={async () => {
            try {
              await api(`/api/pages/${page.id}/restore`, { method: 'POST' });
              invalidatePages(workspace.id, page.id);
              toast('Page restored');
            } catch (err) {
              toastError(err);
            }
          }}
        >
          <RotateCcw size={15} /> Restore
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            const ok = await confirmDialog({ title: 'Delete permanently?', message: 'This page and its sub-pages will be gone for good.', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            try {
              await api(`/api/pages/${page.id}`, { method: 'DELETE' });
              invalidatePages(workspace.id);
              navigate(`/w/${workspace.id}`);
            } catch (err) {
              toastError(err);
            }
          }}
        >
          <Trash2 size={15} /> Delete forever
        </Button>
      </div>
    </div>
  );
}

function Missing({ message }: { message: string }) {
  const { workspace } = useApp();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-4xl">🔍</div>
      <p className="text-sm text-muted">{message}</p>
      <Link to={`/w/${workspace.id}`} className="text-sm font-medium text-accent hover:underline">
        Go to workspace home
      </Link>
    </div>
  );
}
