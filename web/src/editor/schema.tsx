import { aiReady, openAiWrite } from './AiSelection';
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import { createReactBlockSpec, createReactInlineContentSpec, type DefaultReactSuggestionItem, getDefaultReactSlashMenuItems } from '@blocknote/react';
import {
  AtSign,
  Bookmark,
  CalendarCheck2,
  CalendarDays,
  CalendarPlus,
  ChevronsRight,
  Columns2,
  Columns3,
  FileText,
  Globe,
  KanbanSquare,
  ListTree,
  MessageSquareQuote,
  MousePointerClick,
  PenTool,
  Radical,
  RefreshCcw,
  Sigma,
  Table2,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { PageIcon } from '../app/PageIcon';
import { toastError } from '../components/ui';
import { pageTitle, type PageType } from '../lib/api';
import { getDirectory, useDirectory } from '../lib/directory';
import { createPage } from '../lib/queries';
import { createEvent } from '../calendar/api';
import { createWhiteboard } from '../whiteboards/api';
import { EmbeddedDatabase } from './EmbeddedDatabase';
import {
  BookmarkBlock,
  BreadcrumbsBlock,
  ButtonBlock,
  CalloutBlock,
  ColumnBlock,
  ColumnListBlock,
  EmbedBlock,
  InlineMath,
  MathBlock,
  SyncedBlock,
  TocBlock,
} from './extraBlocks';
import { DateMentionChip, EventBlockView, openOnMount, WhiteboardBlockView } from './PlannerBlocks';

/** A link to a child page, shown inside its parent document. */
const SubPageBlock = createReactBlockSpec(
  { type: 'subpage', propSchema: { pageId: { default: '' } }, content: 'none' },
  {
    render: ({ block }) => <SubPageLink pageId={block.props.pageId} />,
  },
);

/**
 * A Grid, Board or Calendar database shown inline in a document. A linked view (`linked`) shows one
 * view of an existing database, with its own filters and sorts.
 */
const DatabaseBlock = createReactBlockSpec(
  { type: 'database', propSchema: { pageId: { default: '' }, viewId: { default: '' }, linked: { default: false } }, content: 'none' },
  {
    render: ({ block, editor }) => (
      <Isolated>
        <EmbeddedDatabase
          pageId={block.props.pageId}
          linked={block.props.linked}
          viewId={block.props.viewId}
          onChange={(props) => editor.updateBlock(block, { props })}
          editable={editor.isEditable}
        />
      </Isolated>
    ),
  },
);

/** An event or task from the calendar, shown in a page. */
const EventBlock = createReactBlockSpec(
  { type: 'event', propSchema: { eventId: { default: '' } }, content: 'none' },
  {
    render: ({ block, editor }) => (
      <Isolated>
        <EventBlockView eventId={block.props.eventId} editable={editor.isEditable} />
      </Isolated>
    ),
  },
);

/** A whiteboard shown in a page (it also appears on the Whiteboards screen). */
const WhiteboardBlock = createReactBlockSpec(
  { type: 'whiteboard', propSchema: { boardId: { default: '' } }, content: 'none' },
  {
    render: ({ block }) => (
      <Isolated>
        <WhiteboardBlockView boardId={block.props.boardId} />
      </Isolated>
    ),
  },
);

/** A date in text; any block with one appears on the calendar. */
const DateMention = createReactInlineContentSpec(
  { type: 'dateMention', propSchema: { date: { default: '' }, time: { default: '' }, remind: { default: '' }, by: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <DateMentionChip
        date={inlineContent.props.date}
        time={inlineContent.props.time}
        remind={inlineContent.props.remind}
        editable={editor.isEditable}
        onChange={(patch) => {
          // A reminder goes to whoever sets it.
          const by = patch.remind !== undefined ? (patch.remind ? (getDirectory()?.user.id ?? '') : '') : inlineContent.props.by;
          updateInlineContent({ type: 'dateMention', props: { ...inlineContent.props, ...patch, by } });
        }}
      />
    ),
  },
);

/** An inline @mention of a person; they get a notification. */
const PersonMention = createReactInlineContentSpec(
  { type: 'personMention', propSchema: { userId: { default: '' }, name: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent }) => {
      const member = getDirectory()?.members.find((m) => m.id === inlineContent.props.userId);
      return (
        <span contentEditable={false} className="rounded bg-accent/10 px-1 font-medium text-accent">
          @{member?.name ?? inlineContent.props.name ?? 'someone'}
        </span>
      );
    },
  },
);

/** An inline @mention of another page. */
const PageMention = createReactInlineContentSpec(
  { type: 'pageMention', propSchema: { pageId: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent }) => <MentionChip pageId={inlineContent.props.pageId} />,
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    subpage: SubPageBlock(),
    database: DatabaseBlock(),
    event: EventBlock(),
    whiteboard: WhiteboardBlock(),
    callout: CalloutBlock(),
    toc: TocBlock(),
    breadcrumbs: BreadcrumbsBlock(),
    math: MathBlock(),
    bookmark: BookmarkBlock(),
    embed: EmbedBlock(),
    button: ButtonBlock(),
    columnList: ColumnListBlock(),
    column: ColumnBlock(),
    synced: SyncedBlock(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageMention: PageMention, dateMention: DateMention, personMention: PersonMention, inlineMath: InlineMath },
});

export type AppEditor = typeof schema.BlockNoteEditor;

function usePage(pageId: string) {
  const dir = useDirectory();
  return { dir, page: dir?.pages.find((p) => p.id === pageId) };
}

function SubPageLink({ pageId }: { pageId: string }) {
  const { dir, page } = usePage(pageId);
  return (
    <div
      contentEditable={false}
      onClick={() => page && dir?.navigate(`/w/${dir.workspaceId}/p/${page.id}`)}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 select-none ${page ? 'hover:bg-hover' : 'cursor-default'}`}
    >
      {page ? <PageIcon page={page} size={18} /> : <FileText size={18} className="text-faint" />}
      <span className={page ? 'border-b border-line font-medium' : 'text-faint italic'}>{page ? pageTitle(page) : 'Page moved to trash or deleted'}</span>
    </div>
  );
}

function MentionChip({ pageId }: { pageId: string }) {
  const { dir, page } = usePage(pageId);
  return (
    <span
      contentEditable={false}
      onClick={() => page && dir?.navigate(`/w/${dir.workspaceId}/p/${page.id}`)}
      className={`inline-flex cursor-pointer items-center gap-1 rounded px-0.5 align-baseline hover:bg-hover ${page ? '' : 'text-faint line-through'}`}
    >
      {page ? <PageIcon page={page} size={14} /> : <FileText size={14} />}
      <span className="border-b border-faint/60 font-medium">{page ? pageTitle(page) : 'Deleted page'}</span>
    </span>
  );
}

/**
 * Keeps keyboard, mouse and drag events inside an embedded block away from the
 * surrounding editor, so inputs and drag-and-drop inside it work normally.
 */
function Isolated({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const events = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'mousedown', 'dragstart', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend'];
    events.forEach((name) => el.addEventListener(name, stop));
    return () => events.forEach((name) => el.removeEventListener(name, stop));
  }, []);
  return (
    <div ref={ref} contentEditable={false} className="w-full">
      {children}
    </div>
  );
}

const PAGE_ITEMS: { type: PageType; title: string; subtext: string; icon: React.JSX.Element; aliases: string[] }[] = [
  { type: 'document', title: 'Page', subtext: 'Add a sub-page inside this page', icon: <FileText size={18} />, aliases: ['sub-page', 'subpage', 'document', 'doc'] },
  { type: 'grid', title: 'Grid', subtext: 'Add an inline database table', icon: <Table2 size={18} />, aliases: ['table', 'database', 'spreadsheet'] },
  { type: 'board', title: 'Kanban', subtext: 'Add an inline board', icon: <KanbanSquare size={18} />, aliases: ['board', 'kanban', 'tasks'] },
  { type: 'calendar', title: 'Calendar', subtext: 'Add an inline calendar', icon: <CalendarDays size={18} />, aliases: ['calendar', 'dates', 'schedule'] },
];

/** The "/" menu: BlockNote's blocks plus pages and databases. */
export function slashItems(editor: AppEditor, parentPageId: string): DefaultReactSuggestionItem[] {
  // Only workspace owners add pages; everyone can still link to existing ones.
  const pageItems: DefaultReactSuggestionItem[] = (getDirectory()?.canCreatePages ? PAGE_ITEMS : []).map((item) => ({
    title: item.title,
    subtext: item.subtext,
    icon: item.icon,
    aliases: item.aliases,
    group: 'Pages',
    onItemClick: async () => {
      const dir = getDirectory();
      if (!dir) return;
      try {
        const page = await createPage(dir.workspaceId, { parentId: parentPageId, type: item.type });
        insertOrUpdateBlockForSlashMenu(editor, { type: item.type === 'document' ? 'subpage' : 'database', props: { pageId: page.id } });
      } catch (err) {
        toastError(err);
      }
    },
  }));
  pageItems.push({
    title: 'Linked view of a database',
    subtext: 'Show one view of an existing database here',
    icon: <Table2 size={18} />,
    aliases: ['linked', 'view', 'database', 'filtered'],
    group: 'Pages',
    onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'database', props: { pageId: '', viewId: '', linked: true } } as never),
  });
  pageItems.push({
    title: 'Link to page',
    subtext: 'Mention another page',
    icon: <AtSign size={18} />,
    aliases: ['mention', 'link'],
    group: 'Pages',
    onItemClick: () => editor.getExtension(SuggestionMenu)?.openSuggestionMenu('@'),
  });
  // With an AI connection: write something at the cursor.
  const aiItems: DefaultReactSuggestionItem[] = aiReady()
    ? [
        {
          title: 'Ask AI to write',
          subtext: 'Describe what to write here: a summary, a plan, a list…',
          icon: <Sparkles size={18} />,
          aliases: ['ai', 'write', 'generate', 'assistant'],
          group: 'AI',
          onItemClick: () => openAiWrite(editor),
        },
      ]
    : [];
  return [...aiItems, ...getDefaultReactSlashMenuItems(editor), ...pageItems, ...planningItems(editor), ...moreBlockItems(editor), ...colorItems(editor)].map((item) => nestInListItems(editor, item));
}

export function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Callouts, contents, maths, bookmarks and embeds, buttons, columns and synced blocks. */
function moreBlockItems(editor: AppEditor): DefaultReactSuggestionItem[] {
  const insert = (block: object) => insertOrUpdateBlockForSlashMenu(editor, block as never);
  const columns = (n: number) => ({ type: 'columnList', children: Array.from({ length: n }, () => ({ type: 'column', children: [{ type: 'paragraph' }] })) });
  return [
    { title: 'Callout', subtext: 'Make a note stand out', icon: <MessageSquareQuote size={18} />, aliases: ['callout', 'note', 'info', 'tip', 'warning'], group: 'Basic blocks', onItemClick: () => insert({ type: 'callout' }) },
    { title: 'Table of contents', subtext: 'The headings of this page, as links', icon: <ListTree size={18} />, aliases: ['toc', 'contents', 'outline'], group: 'Advanced', onItemClick: () => insert({ type: 'toc' }) },
    { title: 'Breadcrumbs', subtext: 'Where this page sits', icon: <ChevronsRight size={18} />, aliases: ['breadcrumb', 'path'], group: 'Advanced', onItemClick: () => insert({ type: 'breadcrumbs' }) },
    { title: 'Equation', subtext: 'A maths formula (LaTeX)', icon: <Sigma size={18} />, aliases: ['math', 'equation', 'latex', 'katex', 'formula', 'tex'], group: 'Advanced', onItemClick: () => insert({ type: 'math' }) },
    {
      title: 'Inline equation',
      subtext: 'A formula inside the text',
      icon: <Radical size={18} />,
      aliases: ['inline math', 'inline equation', 'latex'],
      group: 'Advanced',
      onItemClick: () => editor.insertInlineContent([{ type: 'inlineMath', props: { latex: '' } } as never, ' ']),
    },
    { title: 'Button', subtext: 'Click to add blocks or open a link', icon: <MousePointerClick size={18} />, aliases: ['button', 'action', 'template'], group: 'Advanced', onItemClick: () => insert({ type: 'button' }) },
    { title: 'Synced block', subtext: 'The same content in several pages', icon: <RefreshCcw size={18} />, aliases: ['synced', 'sync', 'reuse', 'mirror'], group: 'Advanced', onItemClick: () => insert({ type: 'synced' }) },
    { title: '2 columns', subtext: 'Put blocks side by side', icon: <Columns2 size={18} />, aliases: ['columns', 'two columns', 'layout', 'side by side'], group: 'Layout', onItemClick: () => insert(columns(2)) },
    { title: '3 columns', subtext: 'Three blocks side by side', icon: <Columns3 size={18} />, aliases: ['columns', 'three columns', 'layout'], group: 'Layout', onItemClick: () => insert(columns(3)) },
    { title: 'Bookmark', subtext: 'A link shown as a card with a preview', icon: <Bookmark size={18} />, aliases: ['bookmark', 'link preview', 'web'], group: 'Media', onItemClick: () => insert({ type: 'bookmark' }) },
    { title: 'Embed', subtext: 'YouTube, Vimeo, Loom, Figma, Maps, Google Docs…', icon: <Globe size={18} />, aliases: ['embed', 'youtube', 'video', 'iframe', 'figma', 'map', 'loom', 'spotify'], group: 'Media', onItemClick: () => insert({ type: 'embed' }) },
  ];
}

/** "/event", "/task", "/whiteboard" and "/date": calendar items and boards that live in the page. */
function planningItems(editor: AppEditor): DefaultReactSuggestionItem[] {
  const block = (props: { type: 'event'; props: { eventId: string } } | { type: 'whiteboard'; props: { boardId: string } }) =>
    insertOrUpdateBlockForSlashMenu(editor, props as never);
  // A new event or task takes its title from the text already typed in the line, if any.
  const lineText = () => {
    const current = editor.getTextCursorPosition().block;
    return Array.isArray(current.content) ? current.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('').trim().slice(0, 200) : '';
  };
  const newEvent = async (task: boolean) => {
    const dir = getDirectory();
    if (!dir) return;
    try {
      const event = await createEvent(dir.workspaceId, { startDate: todayISO(), title: lineText(), status: task ? 'todo' : null });
      openOnMount.add(event.id);
      block({ type: 'event', props: { eventId: event.id } });
    } catch (err) {
      toastError(err);
    }
  };
  return [
    { title: 'Event', subtext: 'An event on the calendar', icon: <CalendarPlus size={18} />, aliases: ['event', 'meeting', 'calendar', 'appointment'], group: 'Planning', onItemClick: () => newEvent(false) },
    { title: 'Task', subtext: 'A dated task, which can repeat', icon: <CalendarCheck2 size={18} />, aliases: ['task', 'todo', 'reminder', 'deadline', 'repeat'], group: 'Planning', onItemClick: () => newEvent(true) },
    {
      title: 'Whiteboard',
      subtext: 'An endless canvas to draw on together',
      icon: <PenTool size={18} />,
      aliases: ['whiteboard', 'board', 'draw', 'canvas', 'diagram', 'sketch'],
      group: 'Planning',
      onItemClick: async () => {
        const dir = getDirectory();
        if (!dir) return;
        try {
          const board = await createWhiteboard(dir.workspaceId);
          block({ type: 'whiteboard', props: { boardId: board.id } });
        } catch (err) {
          toastError(err);
        }
      },
    },
    {
      title: 'Date',
      subtext: 'Put this line on the calendar',
      icon: <CalendarDays size={18} />,
      aliases: ['date', 'today', 'due', 'when'],
      group: 'Planning',
      onItemClick: () => editor.insertInlineContent([{ type: 'dateMention', props: { date: todayISO(), time: '', remind: '', by: '' } }, ' ']),
    },
  ];
}

const COLORS: [string, string][] = [
  ['gray', '#9b9a97'],
  ['brown', '#a27763'],
  ['red', '#e03e3e'],
  ['orange', '#d9730d'],
  ['yellow', '#dfab01'],
  ['green', '#4d6461'],
  ['blue', '#0b6e99'],
  ['purple', '#6940a5'],
  ['pink', '#ad1a72'],
];

/** "/red", "/yellow highlight"… colour the whole current block (text or background). */
function colorItems(editor: AppEditor): DefaultReactSuggestionItem[] {
  const set = (props: Record<string, string>) => {
    const block = editor.getTextCursorPosition().block;
    if ('textColor' in block.props || 'backgroundColor' in block.props) editor.updateBlock(block, { props } as any);
  };
  const swatch = (color: string, bg: boolean) => (
    <span
      className="flex size-[18px] items-center justify-center rounded text-xs font-semibold"
      style={bg ? { background: `${color}33`, color: 'var(--fg)' } : { color, border: '1px solid var(--line)' }}
    >
      A
    </span>
  );
  const label = (c: string) => c[0].toUpperCase() + c.slice(1);
  return [
    { title: 'Default color', subtext: 'Remove text and highlight colors', icon: swatch('var(--fg)', false), group: 'Colors', aliases: ['color', 'reset', 'clear'], onItemClick: () => set({ textColor: 'default', backgroundColor: 'default' }) },
    ...COLORS.map(([c, hex]) => ({
      title: `${label(c)} text`,
      icon: swatch(hex, false),
      group: 'Colors',
      aliases: [c, 'color', 'text color', 'font color'],
      onItemClick: () => set({ textColor: c }),
    })),
    ...COLORS.map(([c, hex]) => ({
      title: `${label(c)} highlight`,
      icon: swatch(hex, true),
      group: 'Colors',
      aliases: [c, 'highlight', 'background', 'color'],
      onItemClick: () => set({ backgroundColor: c }),
    })),
  ];
}

const LIST_TYPES = new Set(['checkListItem', 'bulletListItem', 'numberedListItem', 'toggleListItem']);
const NESTED_GROUPS = new Set(['Media', 'Advanced', 'Pages', 'Planning']);

/**
 * Typing "/" at the end of a to-do (or other list item) that already has text and choosing an image,
 * file, table, page… puts that block *inside* the item instead of after it — so a checklist entry can
 * carry its own attachments.
 */
function nestInListItems(editor: AppEditor, item: DefaultReactSuggestionItem): DefaultReactSuggestionItem {
  if (!item.group || !NESTED_GROUPS.has(item.group)) return item;
  return {
    ...item,
    onItemClick: () => {
      const current = editor.getTextCursorPosition().block;
      const hasText = Array.isArray(current.content) && current.content.some((c: any) => (c.type === 'text' ? c.text.trim() : true));
      if (LIST_TYPES.has(current.type) && hasText) {
        editor.updateBlock(current, { children: [...current.children, { type: 'paragraph' }] } as any);
        const child = editor.getBlock(current.id)?.children.at(-1);
        if (child) editor.setTextCursorPosition(child, 'end');
      }
      return item.onItemClick();
    },
  };
}

/** The "@" menu: mention any page in the workspace. */
export function mentionItems(editor: AppEditor, currentPageId: string, query: string): DefaultReactSuggestionItem[] {
  const pages = (getDirectory()?.pages ?? []).filter((p) => p.id !== currentPageId);
  // People first: mentioning someone notifies them.
  const people: DefaultReactSuggestionItem[] = (getDirectory()?.members ?? []).map((m) => ({
    title: m.name,
    subtext: m.email,
    icon: <span className="flex size-[18px] items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: m.color }}>{m.name.slice(0, 1).toUpperCase()}</span>,
    group: 'People',
    aliases: [m.email],
    onItemClick: () => editor.insertInlineContent([{ type: 'personMention', props: { userId: m.id, name: m.name } }, ' ']),
  }));
  const items: DefaultReactSuggestionItem[] = pages.map((p) => ({
    title: pageTitle(p),
    icon: <PageIcon page={p} size={18} />,
    group: 'Pages',
    onItemClick: () => {
      editor.insertInlineContent([{ type: 'pageMention', props: { pageId: p.id } }, ' ']);
    },
  }));
  // Dates too: "@today", "@tomorrow", "@next week", or "@2026-12-25".
  const dateItem = (title: string, date: string, aliases: string[]): DefaultReactSuggestionItem => ({
    title,
    subtext: new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    icon: <CalendarDays size={18} />,
    group: 'Dates',
    aliases,
    onItemClick: () => editor.insertInlineContent([{ type: 'dateMention', props: { date, time: '', remind: '', by: '' } }, ' ']),
  });
  const dates = [dateItem('Today', todayISO(), ['date', 'now']), dateItem('Tomorrow', todayISO(1), ['date']), dateItem('Next week', todayISO(7), ['date', 'week'])];
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.trim())) dates.unshift(dateItem(query.trim(), query.trim(), []));
  return [...filterSuggestionItems(people, query).slice(0, 6), ...filterSuggestionItems(items, query).slice(0, 12), ...filterSuggestionItems(dates, query)];
}
