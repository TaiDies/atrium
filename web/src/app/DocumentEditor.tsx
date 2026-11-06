import { filterSuggestionItems } from '@blocknote/core';
import { CommentsExtension, DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { CollaborationExtension, YjsThreadStore } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { FormattingToolbarController, SideMenuController, SuggestionMenuController, ThreadsSidebar, useCreateBlockNote } from '@blocknote/react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { cascadeChecklists } from '../editor/checklistCascade';
import { embedUrl } from '../editor/extraBlocks';
import { AiFormattingToolbar, AiSelectionHost, AiSideMenu, openAiForBlocks, transcribeInto, useAiAvailable } from '../editor/AiSelection';
import { BlockSelectionExtension } from '../editor/blockSelection';
import { FileActions } from '../editor/FileActions';
import * as blockNoteLocales from '@blocknote/core/locales';
import { language } from '../i18n';
import { PhoneToolbar } from '../editor/PhoneToolbar';
import { usePhone } from '../lib/device';
import { FindBar } from '../editor/FindBar';
import { mentionItems, schema, slashItems, type AppEditor } from '../editor/schema';
import { uploadFile, type User } from '../lib/api';
import { getDirectory } from '../lib/directory';
import { publicFileUrl } from '../lib/publicDoc';
import type { CollabSession } from '../lib/collab';
import { useTheme } from '../lib/theme';

export type EditorHandle = AppEditor;

/**
 * The block editor used for pages and for database rows (card pages).
 * `parentPageId` is the page that new sub-pages created from the "/" menu belong to.
 */
/** BlockNote's built-in translation for the app's language (English is its default). */
function editorDictionary() {
  const code = language().code;
  return code === 'en' ? null : ((blockNoteLocales as Record<string, unknown>)[code] as typeof blockNoteLocales.en | undefined) ?? null;
}

/**
 * Keeps each group's items next to each other, groups in the order they first appear. The menu shows
 * a heading whenever the group changes and tracks headings by name, so a group split in two showed
 * its heading twice and left copies behind as the list changed while typing.
 */
function groupTogether<T extends { group?: string }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.group ?? '';
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].flat();
}

export function DocumentEditor({
  session,
  user,
  workspaceId,
  parentPageId,
  editorRef,
  className = 'pb-[30vh]',
  readOnly = false,
  commentsOpen = false,
  onCloseComments,
  findable = false,
}: {
  session: CollabSession;
  user: User;
  workspaceId: string;
  parentPageId: string;
  editorRef?: RefObject<EditorHandle | null>;
  className?: string;
  readOnly?: boolean;
  /** Shows every comment thread on the page in a side panel. */
  commentsOpen?: boolean;
  onCloseComments?: () => void;
  /** The page's main editor: Ctrl/⌘+F finds (and Ctrl/⌘+H replaces) in it. */
  findable?: boolean;
}) {
  const [find, setFind] = useState<{ replace: boolean } | null>(null);
  const [commentFilter, setCommentFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const { resolved } = useTheme();
  const wrapper = useRef<HTMLDivElement>(null);
  // On a page published to the web: read-only, no comments, and files come through the link.
  const publicToken = getDirectory()?.public?.token;
  const editor = useCreateBlockNote(
    {
      schema,
      // The editor's own menus and placeholders in the app's language.
      ...(editorDictionary() ? { dictionary: editorDictionary() as never } : {}),
      extensions: [
        // Tasks, files and other blocks without text show as selected when a selection covers them.
        BlockSelectionExtension,
        CollaborationExtension({
          fragment: session.doc.getXmlFragment('document-store'),
          user: { name: user.name, color: user.color },
          provider: { awareness: session.provider.awareness ?? undefined },
        }),
        // Comments live in the page's own document, so they sync and save with it.
        ...(publicToken
          ? []
          : [
              CommentsExtension({
          threadStore: new YjsThreadStore(user.id, session.doc.getMap('threads'), new DefaultThreadStoreAuth(user.id, readOnly ? 'comment' : 'editor')),
          resolveUsers: async (ids) => {
            const members = getDirectory()?.members ?? [];
            return ids.map((id) => {
              const m = members.find((x) => x.id === id);
              return { id, username: m?.name ?? (id === user.id ? user.name : 'Someone'), avatarUrl: '' };
            });
          },
        }),
            ]),
      ],
      uploadFile: (file) => uploadFile(workspaceId, file),
      ...(publicToken ? { resolveFileUrl: async (url: string) => publicFileUrl(publicToken, url) } : {}),
      // A link pasted over selected text links it; one pasted on an empty line of a video, map or
      // document site becomes an embed. Anything else (Markdown included) is pasted as usual.
      pasteHandler: ({ event, editor, defaultPasteHandler }) => {
        const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
        if (/^https?:\/\/\S+$/i.test(text)) {
          if (editor.getSelectedText()) {
            editor.createLink(text);
            return true;
          }
          const block = editor.getTextCursorPosition().block;
          if (block.type === 'paragraph' && Array.isArray(block.content) && block.content.length === 0 && embedUrl(text)) {
            editor.updateBlock(block, { type: 'embed', props: { url: text } } as never);
            return true;
          }
        }
        return defaultPasteHandler();
      },
    },
    [session],
  );

  useEffect(() => {
    if (!findable) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey || (e.key.toLowerCase() !== 'f' && e.key.toLowerCase() !== 'h')) return;
      // Leave the browser's own find alone inside dialogs and other inputs.
      if (document.querySelector('[role=dialog]')) return;
      e.preventDefault();
      setFind({ replace: e.key.toLowerCase() === 'h' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findable]);

  useEffect(() => cascadeChecklists(editor), [editor]);

  // "#block-<id>" in the address (e.g. opened from the calendar or Today): scroll to that block and flash
  // it. The document may still be loading (a card's page can take a few seconds), so keep looking.
  const { hash } = useLocation();
  useEffect(() => {
    const id = /^#block-([\w-]+)$/.exec(hash)?.[1];
    if (!id) return;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const find = () => {
      const el = wrapper.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
      if (!el) {
        if (Date.now() - started < 15_000) timer = setTimeout(find, 200);
        return;
      }
      // Open any closed toggle (toggle list or toggle heading) the block sits inside, outermost first.
      const parents: HTMLElement[] = [];
      for (let n = el.parentElement?.closest<HTMLElement>('.bn-block-outer'); n && wrapper.current?.contains(n); n = n.parentElement?.closest<HTMLElement>('.bn-block-outer')) {
        parents.unshift(n);
      }
      for (const parent of parents) {
        const button = parent.querySelector<HTMLButtonElement>(':scope > .bn-block > .bn-toggle-wrapper > .bn-toggle-button');
        if (button?.getAttribute('aria-expanded') === 'false') button.click();
      }
      // Let the rest of the document lay out first, so the block ends up where it stays.
      timer = setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('block-flash');
        timer = setTimeout(() => el.classList.remove('block-flash'), 2200);
      }, 150);
    };
    find();
    return () => clearTimeout(timer);
  }, [editor, hash]);

  useEffect(() => {
    if (!editorRef) return;
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);

  // With an AI connection, selected text gets an "AI" button in the toolbar (to rewrite, summarise…).
  const aiAvailable = useAiAvailable();
  const aiToolbar = aiAvailable && !publicToken && !readOnly && !!workspaceId;
  const phone = usePhone();

  return (
    <div ref={wrapper} className="relative">
      <BlockNoteView editor={editor} theme={resolved} className={className} slashMenu={false} editable={!readOnly && !publicToken} formattingToolbar={!publicToken && !aiToolbar} sideMenu={!publicToken && !aiToolbar}>
        {aiToolbar && <SideMenuController sideMenu={AiSideMenu} />}
        {aiToolbar && <FormattingToolbarController formattingToolbar={AiFormattingToolbar} />}
        {aiToolbar && <AiSelectionHost editor={editor} workspaceId={workspaceId} />}
        {phone && !readOnly && !publicToken && <PhoneToolbar editor={editor} wrapper={wrapper} ai={aiToolbar} />}
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) => {
            // Items whose name starts with what was typed come first ("embed" → Embed, not File).
            const q = query.trim().toLowerCase();
            const items = filterSuggestionItems(slashItems(editor, parentPageId), query);
            const ranked = q ? [...items.filter((i) => i.title.toLowerCase().startsWith(q)), ...items.filter((i) => !i.title.toLowerCase().startsWith(q))] : items;
            return groupTogether(ranked);
          }}
        />
        <SuggestionMenuController triggerCharacter="@" getItems={async (query) => groupTogether(await mentionItems(editor, parentPageId, query))} />
        {commentsOpen && (
          <aside className="fixed top-12 end-0 bottom-0 z-30 flex w-[min(360px,100vw)] flex-col border-s border-line bg-bg shadow-xl">
            <div className="flex items-center gap-1 border-b border-line px-3 py-2">
              <span className="flex-1 text-sm font-semibold">Comments</span>
              {(['open', 'resolved', 'all'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setCommentFilter(f)}
                  className={clsx('rounded-md px-2 py-0.5 text-xs capitalize', commentFilter === f ? 'bg-active font-medium' : 'text-muted hover:text-fg')}
                >
                  {f}
                </button>
              ))}
              <button onClick={onCloseComments} title="Close" className="ms-1 rounded p-1 text-muted hover:bg-hover hover:text-fg">
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <ThreadsSidebar filter={commentFilter} sort="position" />
              <p className="px-2 py-3 text-xs text-faint">Select text and choose the comment button to start a thread.</p>
            </div>
          </aside>
        )}
      </BlockNoteView>
      {!publicToken && (
        <FileActions
          container={wrapper}
          onAskAi={aiToolbar ? (blockId) => openAiForBlocks(editor, [editor.getBlock(blockId)].filter(Boolean)) : undefined}
          onTranscribe={aiToolbar ? (blockId, url) => void transcribeInto(editor, workspaceId, blockId, url) : undefined}
        />
      )}
      {find && <FindBar view={editor.prosemirrorView} replace={find.replace} editable={!readOnly && !publicToken} onClose={() => setFind(null)} />}
    </div>
  );
}
