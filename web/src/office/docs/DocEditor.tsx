import { Editor, Extension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Typography from '@tiptap/extension-typography';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import clsx from 'clsx';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Code2,
  Eraser,
  FileStack,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  MessageSquarePlus,
  Minus,
  Omega,
  Printer,
  Quote,
  Redo2,
  Replace,
  Ruler,
  Search,
  Strikethrough,
  Subscript as SubIcon,
  Superscript as SupIcon,
  Table2,
  Trash2,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { type Anchor, Avatar, Button, Dialog, IconButton, Popover, toastError } from '../../components/ui';
import { uploadFile, type User } from '../../lib/api';
import type { CollabSession } from '../../lib/collab';
import { timeAgo } from '../../lib/time';
import { convertBytes, type EditorHandle, extOf, type OfficeFile } from '../shared';
import { DEFAULT_SETUP, documentToHtml, exportHtml, htmlToMarkdown, inlineImages, MARGIN_PRESETS, PAGE_SIZES, type PageSetup, pageSize } from './convert';
import { Comment, FindReplace, Indent, PageBreak, searchKey, TableOfContents } from './extensions';

// A word processor everyone edits at once: the text lives in the file's Yjs document ("document"),
// the page setup in "docSetup" and comments in "comments".

/** Paragraph line spacing (1, 1.15, 1.5, 2…). */
const LineSpacing = Extension.create({
  name: 'lineSpacing',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineSpacing: {
            default: null,
            parseHTML: (el) => {
              const v = el.style.lineHeight;
              if (!v) return null;
              return v.endsWith('%') ? String(parseFloat(v) / 100) : /^[\d.]+$/.test(v) ? v : null;
            },
            renderHTML: (a) => (a.lineSpacing ? { style: `line-height: ${a.lineSpacing}` } : {}),
          },
        },
      },
    ];
  },
});

function extensions(doc: Y.Doc, session?: CollabSession, user?: User) {
  return [
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    TextStyleKit,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Highlight.configure({ multicolor: true }),
    Image.configure({ resize: { enabled: true, minWidth: 40, minHeight: 40, alwaysPreserveAspectRatio: true } }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Subscript,
    Superscript,
    Typography,
    Placeholder.configure({ placeholder: 'Start typing…' }),
    CharacterCount,
    PageBreak,
    Indent,
    LineSpacing,
    FindReplace,
    Comment,
    TableOfContents,
    Collaboration.configure({ document: doc, field: 'document' }),
    ...(session && user ? [CollaborationCaret.configure({ provider: session.provider, user: { name: user.name, color: user.color } })] : []),
  ];
}

/** Fills a new live document from the stored file (Word, OpenDocument, RTF, Markdown, text or HTML). */
export async function loadDocument(doc: Y.Doc, file: OfficeFile) {
  const { html, setup } = await documentToHtml(file);
  // A short-lived editor writes the content into the shared document.
  const editor = new Editor({ extensions: extensions(doc), content: '' });
  editor.commands.setContent(html, { emitUpdate: true });
  editor.destroy();
  doc.transact(() => doc.getMap('docSetup').set('setup', setup ?? DEFAULT_SETUP));
}

export const DOCUMENT_FORMATS = [
  { ext: 'docx', label: 'Word document (.docx)' },
  { ext: 'odt', label: 'OpenDocument text (.odt)' },
  { ext: 'pdf', label: 'PDF (.pdf)' },
  { ext: 'rtf', label: 'Rich Text Format (.rtf)' },
  { ext: 'doc', label: 'Word 97–2003 (.doc)' },
  { ext: 'html', label: 'Web page (.html)' },
  { ext: 'md', label: 'Markdown (.md)' },
  { ext: 'txt', label: 'Plain text (.txt)' },
];

const FONTS = ['Calibri', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Garamond', 'Cambria', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Inter', 'Courier New', 'Consolas', 'Comic Sans MS'];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 60, 72];
const SPACINGS = ['1', '1.15', '1.5', '2', '2.5', '3'];
const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  '#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47',
];
const SYMBOLS = '© ® ™ § ¶ † ‡ • … – — ‘ ’ “ ” « » ° ± × ÷ ≈ ≠ ≤ ≥ ∞ √ ∑ π µ Ω α β γ δ λ σ θ € £ ¥ ¢ ₹ ← → ↑ ↓ ↔ ⇒ ✓ ✗ ★ ☆ ♥ ☐ ☑ ½ ¼ ¾ ¹ ² ³'.split(' ');
const MM = 3.7795; // px per mm

interface CommentEntry {
  id: string;
  author: string;
  color: string;
  text: string;
  createdAt: number;
  resolved: boolean;
  replies: { author: string; color: string; text: string; createdAt: number }[];
}

interface Props {
  file: OfficeFile;
  session: CollabSession;
  user: User;
  readOnly: boolean;
}

export const DocEditor = forwardRef<EditorHandle, Props>(function DocEditor({ file, session, user, readOnly }, ref) {
  const setupMap = useMemo(() => session.doc.getMap<PageSetup>('docSetup'), [session]);
  const comments = useMemo(() => session.doc.getMap<CommentEntry>('comments'), [session]);
  const [setup, setSetup] = useState<PageSetup>(() => setupMap.get('setup') ?? DEFAULT_SETUP);
  const [zoom, setZoom] = useState(1);
  const [find, setFind] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [commentList, setCommentList] = useState<CommentEntry[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [activeComment, setActiveComment] = useState<string | null>(null);

  const editor = useEditor(
    {
      extensions: extensions(session.doc, session, user),
      editable: !readOnly,
      editorProps: {
        attributes: { class: 'doc-content', spellcheck: 'true' },
        handleClickOn: (_view, _pos, _node, _nodePos, event) => {
          const id = (event.target as HTMLElement).closest('[data-comment-id]')?.getAttribute('data-comment-id');
          if (id) {
            setShowComments(true);
            setActiveComment(id);
          }
          return false;
        },
      },
    },
    [session],
  );

  useEffect(() => editor?.setEditable(!readOnly), [editor, readOnly]);
  useEffect(() => {
    const read = () => setSetup(setupMap.get('setup') ?? DEFAULT_SETUP);
    setupMap.observe(read);
    return () => setupMap.unobserve(read);
  }, [setupMap]);
  useEffect(() => {
    const read = () => setCommentList([...comments.values()].sort((a, b) => Number(a.resolved) - Number(b.resolved) || a.createdAt - b.createdAt));
    read();
    comments.observe(read);
    return () => comments.unobserve(read);
  }, [comments]);

  const html = async (forExport = true) => {
    const body = editor?.getHTML() ?? '';
    const page = exportHtml(body, setup, file.name.replace(/\.[^.]+$/, ''));
    return forExport ? inlineImages(page) : page;
  };

  const exportAs = async (ext: string): Promise<Blob> => {
    if (!editor) throw new Error('The editor is still loading');
    if (ext === 'txt') return new Blob([editor.getText({ blockSeparator: '\n\n' })], { type: 'text/plain' });
    if (ext === 'md') return new Blob([await htmlToMarkdown(editor.getHTML())], { type: 'text/markdown' });
    if (ext === 'html') return new Blob([await html()], { type: 'text/html' });
    return convertBytes(file.workspaceId, 'document', 'html', ext, new Blob([await html()], { type: 'text/html' }), file.name);
  };

  useImperativeHandle(ref, () => ({
    formats: DOCUMENT_FORMATS,
    exportAs,
    exportOriginal: async () => {
      const ext = extOf(file.name);
      const base = file.name.replace(/\.[^.]+$/, '');
      if (['docx', 'odt', 'rtf', 'doc', 'txt', 'html'].includes(ext)) return { blob: await exportAs(ext), name: file.name };
      if (ext === 'htm') return { blob: await exportAs('html'), name: file.name };
      if (ext === 'md' || ext === 'markdown') return { blob: await exportAs('md'), name: file.name };
      return { blob: await exportAs('docx'), name: `${base}.docx` }; // .dotx, .docm, .wpd… are saved as .docx
    },
  }));

  const print = async () => {
    const w = window.open('', '_blank');
    if (!w) return toastError(new Error('Allow pop-ups to print'));
    w.document.write(await html(false));
    w.document.close();
    w.addEventListener('load', () => w.print());
    setTimeout(() => w.print(), 600);
  };

  const addComment = () => {
    if (!editor || editor.state.selection.empty) return;
    const text = prompt('Comment')?.trim();
    if (!text) return;
    const id = crypto.randomUUID();
    session.doc.transact(() => comments.set(id, { id, author: user.name, color: user.color, text, createdAt: Date.now(), resolved: false, replies: [] }));
    editor.chain().focus().setComment(id).run();
    setShowComments(true);
    setActiveComment(id);
  };

  const { w, h } = pageSize(setup);
  const m = setup.margins;

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {!readOnly && editor && (
        <Toolbar
          editor={editor}
          onFind={() => setFind((f) => !f)}
          onComment={addComment}
          onComments={() => setShowComments((s) => !s)}
          commentCount={commentList.filter((c) => !c.resolved).length}
          onPageSetup={() => setSetupOpen(true)}
          onPrint={print}
          workspaceId={file.workspaceId}
        />
      )}
      {find && editor && <FindBar editor={editor} readOnly={readOnly} onClose={() => setFind(false)} />}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto px-3 py-6 sm:px-6">
          <div
            className="doc-paper mx-auto bg-white text-black shadow-pop"
            style={{ width: w * MM, minHeight: h * MM, padding: `${m.top * MM}px ${m.right * MM}px ${m.bottom * MM}px ${m.left * MM}px`, zoom } as React.CSSProperties}
          >
            <EditorContent editor={editor} />
          </div>
        </div>
        {showComments && (
          <CommentsPanel
            comments={commentList}
            active={activeComment}
            user={user}
            readOnly={readOnly}
            onClose={() => setShowComments(false)}
            onSelect={(id) => {
              setActiveComment(id);
              editor?.view.dom.querySelector(`[data-comment-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
            onReply={(id, text) => {
              const c = comments.get(id);
              if (c) session.doc.transact(() => comments.set(id, { ...c, replies: [...c.replies, { author: user.name, color: user.color, text, createdAt: Date.now() }] }));
            }}
            onResolve={(id, resolved) => {
              const c = comments.get(id);
              if (c) session.doc.transact(() => comments.set(id, { ...c, resolved }));
            }}
            onDelete={(id) => {
              editor?.commands.unsetComment(id);
              session.doc.transact(() => comments.delete(id));
            }}
          />
        )}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-bg px-3 text-xs text-muted">
        <span>{editor ? `${editor.storage.characterCount.words()} words` : ''}</span>
        <span className="max-sm:hidden">{editor ? `${editor.storage.characterCount.characters()} characters` : ''}</span>
        <span className="max-sm:hidden">
          {PAGE_SIZES[setup.size].label} · {setup.orientation}
        </span>
        <span className="flex-1" />
        <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} className="rounded px-1 hover:bg-hover" aria-label="Zoom out">
          <Minus size={13} />
        </button>
        <button onClick={() => setZoom(1)} className="w-10 tabular-nums">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} className="rounded px-1 hover:bg-hover" aria-label="Zoom in">
          +
        </button>
      </div>
      {setupOpen && <PageSetupDialog setup={setup} onClose={() => setSetupOpen(false)} onSave={(s) => session.doc.transact(() => setupMap.set('setup', s))} />}
    </div>
  );
});

function TButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx('flex size-8 shrink-0 items-center justify-center rounded-md disabled:opacity-35', active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-0.5 h-6 w-px shrink-0 bg-line" />;

function Toolbar({
  editor,
  onFind,
  onComment,
  onComments,
  commentCount,
  onPageSetup,
  onPrint,
  workspaceId,
}: {
  editor: Editor;
  onFind: () => void;
  onComment: () => void;
  onComments: () => void;
  commentCount: number;
  onPageSetup: () => void;
  onPrint: () => void;
  workspaceId: string;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      code: e.isActive('code'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      align: (['left', 'center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      heading: ([1, 2, 3, 4, 5, 6] as const).find((l) => e.isActive('heading', { level: l })) ?? 0,
      font: (e.getAttributes('textStyle').fontFamily as string | undefined)?.replace(/['"]/g, '').split(',')[0] ?? '',
      size: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      color: (e.getAttributes('textStyle').color as string | undefined) ?? '#000000',
      spacing: (e.getAttributes('paragraph').lineSpacing as string | undefined) ?? (e.getAttributes('heading').lineSpacing as string | undefined) ?? '',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      empty: e.state.selection.empty,
    }),
  });
  const [pop, setPop] = useState<{ kind: 'color' | 'highlight' | 'table' | 'symbols' | 'link' | 'spacing'; anchor: Anchor } | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const open = (kind: NonNullable<typeof pop>['kind']) => (e: React.MouseEvent<HTMLElement>) => setPop({ kind, anchor: e.currentTarget.getBoundingClientRect() });
  const chain = () => editor.chain().focus();
  const sizePt = s.size ? parseFloat(s.size) : 11;
  const setSize = (pt: number) => chain().setFontSize(`${pt}pt`).run();

  const style = s.heading ? `h${s.heading}` : s.quote ? 'quote' : s.codeBlock ? 'code' : 'p';
  const setStyle = (v: string) => {
    if (v === 'p') chain().setParagraph().run();
    else if (v === 'quote') chain().setParagraph().toggleBlockquote().run();
    else if (v === 'code') chain().toggleCodeBlock().run();
    else chain().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
  };

  return (
    <div className="shrink-0 border-b border-line bg-bg">
      <div className="flex items-center gap-0.5 overflow-x-auto px-2 py-1">
        <TButton label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => chain().undo().run()}>
          <Undo2 size={16} />
        </TButton>
        <TButton label="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => chain().redo().run()}>
          <Redo2 size={16} />
        </TButton>
        <TButton label="Print (Ctrl+P)" onClick={onPrint}>
          <Printer size={16} />
        </TButton>
        <Sep />
        <select value={style} onChange={(e) => setStyle(e.target.value)} className="h-8 w-32 shrink-0 rounded-md border border-line bg-surface px-1.5 text-sm" title="Paragraph style">
          <option value="p">Normal text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="h4">Heading 4</option>
          <option value="h5">Heading 5</option>
          <option value="h6">Heading 6</option>
          <option value="quote">Quote</option>
          <option value="code">Code</option>
        </select>
        <select
          value={FONTS.includes(s.font) ? s.font : ''}
          onChange={(e) => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run())}
          className="h-8 w-32 shrink-0 rounded-md border border-line bg-surface px-1.5 text-sm"
          title="Font"
        >
          <option value="">{s.font && !FONTS.includes(s.font) ? s.font : 'Default font'}</option>
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
        <div className="flex shrink-0 items-center rounded-md border border-line">
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(SIZES.filter((x) => x < sizePt).at(-1) ?? 8)} className="px-1.5 text-muted hover:text-fg" aria-label="Smaller text">
            −
          </button>
          <select value={SIZES.includes(sizePt) ? sizePt : ''} onChange={(e) => setSize(Number(e.target.value))} className="h-8 w-12 bg-transparent text-center text-sm" title="Font size">
            {!SIZES.includes(sizePt) && <option value="">{sizePt}</option>}
            {SIZES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(SIZES.find((x) => x > sizePt) ?? 72)} className="px-1.5 text-muted hover:text-fg" aria-label="Bigger text">
            +
          </button>
        </div>
        <Sep />
        <TButton label="Bold (Ctrl+B)" active={s.bold} onClick={() => chain().toggleBold().run()}>
          <Bold size={16} />
        </TButton>
        <TButton label="Italic (Ctrl+I)" active={s.italic} onClick={() => chain().toggleItalic().run()}>
          <Italic size={16} />
        </TButton>
        <TButton label="Underline (Ctrl+U)" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
          <Underline size={16} />
        </TButton>
        <TButton label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}>
          <Strikethrough size={16} />
        </TButton>
        <TButton label="Subscript" active={s.sub} onClick={() => chain().toggleSubscript().run()}>
          <SubIcon size={16} />
        </TButton>
        <TButton label="Superscript" active={s.sup} onClick={() => chain().toggleSuperscript().run()}>
          <SupIcon size={16} />
        </TButton>
        <TButton label="Inline code" active={s.code} onClick={() => chain().toggleCode().run()}>
          <Code2 size={16} />
        </TButton>
        <TButton label="Text color" onClick={open('color')}>
          <span className="flex flex-col items-center">
            <Baseline size={15} />
            <span className="h-[3px] w-4 rounded-full" style={{ background: s.color }} />
          </span>
        </TButton>
        <TButton label="Highlight" onClick={open('highlight')}>
          <Highlighter size={16} />
        </TButton>
        <TButton label="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()}>
          <Eraser size={16} />
        </TButton>
        <Sep />
        {(
          [
            ['left', AlignLeft, 'Align left'],
            ['center', AlignCenter, 'Center'],
            ['right', AlignRight, 'Align right'],
            ['justify', AlignJustify, 'Justify'],
          ] as const
        ).map(([a, Icon, label]) => (
          <TButton key={a} label={label} active={s.align === a} onClick={() => chain().setTextAlign(a).run()}>
            <Icon size={16} />
          </TButton>
        ))}
        <TButton label="Line spacing" onClick={open('spacing')}>
          <span className="text-[11px] font-semibold">↕{s.spacing || ''}</span>
        </TButton>
        <Sep />
        <TButton label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
          <List size={16} />
        </TButton>
        <TButton label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
          <ListOrdered size={16} />
        </TButton>
        <TButton label="Checklist" active={s.task} onClick={() => chain().toggleTaskList().run()}>
          <ListChecks size={16} />
        </TButton>
        <TButton label="Decrease indent (Shift+Tab)" onClick={() => chain().outdent().run()}>
          <IndentDecrease size={16} />
        </TButton>
        <TButton label="Increase indent (Tab)" onClick={() => chain().indent().run()}>
          <IndentIncrease size={16} />
        </TButton>
        <TButton label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
          <Quote size={16} />
        </TButton>
        <Sep />
        <TButton label="Link (Ctrl+K)" active={s.link} onClick={open('link')}>
          <Link2 size={16} />
        </TButton>
        <TButton label="Image" onClick={() => imageInput.current?.click()}>
          <ImagePlus size={16} />
        </TButton>
        <TButton label="Table" active={s.table} onClick={open('table')}>
          <Table2 size={16} />
        </TButton>
        <TButton label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}>
          <Minus size={16} />
        </TButton>
        <TButton label="Page break (Ctrl+Enter)" onClick={() => chain().setPageBreak().run()}>
          <FileStack size={16} />
        </TButton>
        <TButton label="Special characters" onClick={open('symbols')}>
          <Omega size={16} />
        </TButton>
        <TButton label="Table of contents" onClick={() => chain().insertTableOfContents().run()}>
          <ListTree size={16} />
        </TButton>
        <Sep />
        <TButton label="Comment on the selected text" disabled={s.empty} onClick={onComment}>
          <MessageSquarePlus size={16} />
        </TButton>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={onComments}
          className="flex h-8 shrink-0 items-center rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg"
          title="Show comments"
        >
          Comments{commentCount ? ` (${commentCount})` : ''}
        </button>
        <TButton label="Find and replace (Ctrl+F)" onClick={onFind}>
          <Search size={16} />
        </TButton>
        <TButton label="Page setup" onClick={onPageSetup}>
          <Ruler size={16} />
        </TButton>
      </div>
      {s.table && <TableBar editor={editor} />}
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            chain().setImage({ src: await uploadFile(workspaceId, f), alt: f.name }).run();
          } catch (err) {
            toastError(err);
          }
        }}
      />
      <Popover anchor={pop?.anchor ?? null} onClose={() => setPop(null)}>
        {pop?.kind === 'color' && <Palette onPick={(c) => (c ? chain().setColor(c).run() : chain().unsetColor().run(), setPop(null))} />}
        {pop?.kind === 'highlight' && <Palette onPick={(c) => (c ? chain().setHighlight({ color: c }).run() : chain().unsetHighlight().run(), setPop(null))} />}
        {pop?.kind === 'table' && (
          <TableGrid
            onPick={(rows, cols) => {
              chain().insertTable({ rows, cols, withHeaderRow: true }).run();
              setPop(null);
            }}
          />
        )}
        {pop?.kind === 'symbols' && (
          <div className="grid w-72 grid-cols-10 gap-0.5 p-2">
            {SYMBOLS.map((ch) => (
              <button key={ch} onClick={() => chain().insertContent(ch).run()} className="flex size-6 items-center justify-center rounded text-sm hover:bg-hover">
                {ch}
              </button>
            ))}
          </div>
        )}
        {pop?.kind === 'spacing' && (
          <div className="w-36 p-1">
            {SPACINGS.map((v) => (
              <button
                key={v}
                onClick={() => {
                  chain().updateAttributes('paragraph', { lineSpacing: v }).updateAttributes('heading', { lineSpacing: v }).run();
                  setPop(null);
                }}
                className={clsx('block w-full rounded px-2 py-1 text-left text-sm hover:bg-hover', s.spacing === v && 'font-semibold text-accent')}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        {pop?.kind === 'link' && <LinkForm editor={editor} onDone={() => setPop(null)} />}
      </Popover>
    </div>
  );
}

function Palette({ onPick }: { onPick: (color: string | null) => void }) {
  return (
    <div className="w-64 p-2">
      <div className="grid grid-cols-10 gap-1">
        {PALETTE.map((c) => (
          <button key={c} onClick={() => onPick(c)} className="size-5 rounded-sm border border-black/10" style={{ background: c }} aria-label={c} />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Custom
          <input type="color" onChange={(e) => onPick(e.target.value)} className="h-6 w-8 cursor-pointer" />
        </label>
        <span className="flex-1" />
        <button onClick={() => onPick(null)} className="text-xs text-muted hover:text-fg">
          None
        </button>
      </div>
    </div>
  );
}

function TableGrid({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ r: 2, c: 2 });
  return (
    <div className="p-2">
      <div className="grid grid-cols-10 gap-0.5" onMouseLeave={() => setHover({ r: 2, c: 2 })}>
        {Array.from({ length: 80 }, (_, i) => {
          const r = Math.floor(i / 10);
          const c = i % 10;
          return (
            <button
              key={i}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => onPick(r + 1, c + 1)}
              className={clsx('size-4 rounded-[2px] border', r <= hover.r && c <= hover.c ? 'border-accent bg-accent-soft' : 'border-line')}
            />
          );
        })}
      </div>
      <div className="mt-1.5 text-center text-xs text-muted">
        {hover.r + 1} × {hover.c + 1}
      </div>
    </div>
  );
}

function TableBar({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus();
  const items: [string, () => void][] = [
    ['Row above', () => chain().addRowBefore().run()],
    ['Row below', () => chain().addRowAfter().run()],
    ['Column left', () => chain().addColumnBefore().run()],
    ['Column right', () => chain().addColumnAfter().run()],
    ['Delete row', () => chain().deleteRow().run()],
    ['Delete column', () => chain().deleteColumn().run()],
    ['Merge cells', () => chain().mergeCells().run()],
    ['Split cell', () => chain().splitCell().run()],
    ['Header row', () => chain().toggleHeaderRow().run()],
    ['Header column', () => chain().toggleHeaderColumn().run()],
  ];
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-t border-line px-2 py-1 text-xs">
      <span className="shrink-0 px-1 font-medium text-muted">Table</span>
      {items.map(([label, run]) => (
        <button key={label} onMouseDown={(e) => e.preventDefault()} onClick={run} className="h-7 shrink-0 rounded-md px-2 whitespace-nowrap text-muted hover:bg-hover hover:text-fg">
          {label}
        </button>
      ))}
      <button onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteTable().run()} className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-danger hover:bg-hover">
        <Trash2 size={13} /> Delete table
      </button>
    </div>
  );
}

function LinkForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [href, setHref] = useState((editor.getAttributes('link').href as string | undefined) ?? '');
  return (
    <form
      className="flex w-80 gap-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        const url = href.trim();
        if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run();
        else {
          const full = /^(https?:|mailto:|tel:|\/|#)/i.test(url) ? url : `https://${url}`;
          if (editor.state.selection.empty) editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: full } }] }).run();
          else editor.chain().focus().extendMarkRange('link').setLink({ href: full }).run();
        }
        onDone();
      }}
    >
      <input autoFocus value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://…" className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm" />
      <Button type="submit" size="sm">
        {href ? 'Apply' : 'Remove'}
      </Button>
    </form>
  );
}

function FindBar({ editor, readOnly, onClose }: { editor: Editor; readOnly: boolean; onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const state = useEditorState({ editor, selector: ({ editor: e }) => searchKey.getState(e.state) });
  useEffect(() => {
    editor.commands.setSearch(term, caseSensitive);
  }, [editor, term, caseSensitive]);
  useEffect(() => () => void editor.commands.setSearch(''), [editor]);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg px-3 py-1.5 text-sm">
      <Search size={15} className="text-muted" />
      <input
        autoFocus
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.shiftKey ? editor.commands.findPrevious() : editor.commands.findNext());
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Find"
        className="h-8 w-48 rounded-md border border-line bg-surface px-2"
      />
      <span className="w-14 text-xs text-muted tabular-nums">{state?.matches.length ? `${state.current + 1} / ${state.matches.length}` : term ? 'None' : ''}</span>
      <IconButton onClick={() => editor.commands.findPrevious()} title="Previous (Shift+Enter)">
        <ChevronUp size={16} />
      </IconButton>
      <IconButton onClick={() => editor.commands.findNext()} title="Next (Enter)">
        <ChevronDown size={16} />
      </IconButton>
      <IconButton onClick={() => setCaseSensitive((c) => !c)} title="Match case" className={caseSensitive ? 'text-accent' : ''}>
        <CaseSensitive size={16} />
      </IconButton>
      {!readOnly && (
        <>
          <Replace size={15} className="ml-2 text-muted" />
          <input value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="Replace with" className="h-8 w-44 rounded-md border border-line bg-surface px-2" />
          <Button size="sm" onClick={() => editor.commands.replaceCurrent(replace)}>
            Replace
          </Button>
          <Button size="sm" onClick={() => editor.commands.replaceAll(replace)}>
            Replace all
          </Button>
        </>
      )}
      <span className="flex-1" />
      <IconButton onClick={onClose} title="Close (Esc)">
        <X size={16} />
      </IconButton>
    </div>
  );
}

function CommentsPanel({
  comments,
  active,
  user,
  readOnly,
  onClose,
  onSelect,
  onReply,
  onResolve,
  onDelete,
}: {
  comments: CommentEntry[];
  active: string | null;
  user: User;
  readOnly: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onReply: (id: string, text: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [reply, setReply] = useState<Record<string, string>>({});
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-bg max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:shadow-pop">
      <div className="flex h-10 items-center justify-between border-b border-line px-3">
        <span className="text-sm font-medium">Comments</span>
        <IconButton onClick={onClose} aria-label="Close comments">
          <X size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {comments.length === 0 && <div className="px-2 py-6 text-center text-sm text-muted">Select some text and press the comment button to add one.</div>}
        {comments.map((c) => (
          <div key={c.id} onClick={() => onSelect(c.id)} className={clsx('cursor-pointer rounded-lg border p-2.5 text-sm', active === c.id ? 'border-accent' : 'border-line', c.resolved && 'opacity-60')}>
            <div className="flex items-center gap-2">
              <Avatar name={c.author} color={c.color} size={20} />
              <span className="min-w-0 flex-1 truncate font-medium">{c.author}</span>
              <span className="text-xs text-faint">{timeAgo(new Date(c.createdAt))}</span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap">{c.text}</p>
            {c.replies.map((r, i) => (
              <div key={i} className="mt-2 border-l-2 border-line pl-2">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="font-medium">{r.author}</span>
                  <span className="text-faint">{timeAgo(new Date(r.createdAt))}</span>
                </div>
                <p className="whitespace-pre-wrap">{r.text}</p>
              </div>
            ))}
            {!readOnly && (
              <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                {!c.resolved && (
                  <input
                    value={reply[c.id] ?? ''}
                    onChange={(e) => setReply((r) => ({ ...r, [c.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && reply[c.id]?.trim()) {
                        onReply(c.id, reply[c.id].trim());
                        setReply((r) => ({ ...r, [c.id]: '' }));
                      }
                    }}
                    placeholder="Reply"
                    className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-xs"
                  />
                )}
                <button onClick={() => onResolve(c.id, !c.resolved)} className="h-7 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg">
                  {c.resolved ? 'Reopen' : 'Resolve'}
                </button>
                {(c.author === user.name || c.resolved) && (
                  <button onClick={() => onDelete(c.id)} className="h-7 rounded-md px-1.5 text-xs text-muted hover:bg-hover hover:text-danger" aria-label="Delete comment">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function PageSetupDialog({ setup, onClose, onSave }: { setup: PageSetup; onClose: () => void; onSave: (s: PageSetup) => void }) {
  const [draft, setDraft] = useState(setup);
  const preset = MARGIN_PRESETS.find((p) => Object.values(draft.margins).every((v) => Math.abs(v - p.mm) < 0.2))?.id ?? 'custom';
  return (
    <Dialog open onClose={onClose} title="Page setup" width={440}>
      <div className="space-y-4 px-5 pb-5 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Paper size</span>
            <select value={draft.size} onChange={(e) => setDraft({ ...draft, size: e.target.value as PageSetup['size'] })} className="h-9 w-full rounded-lg border border-line bg-surface px-2">
              {Object.entries(PAGE_SIZES).map(([id, s]) => (
                <option key={id} value={id}>
                  {s.label} ({s.w} × {s.h} mm)
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Orientation</span>
            <select value={draft.orientation} onChange={(e) => setDraft({ ...draft, orientation: e.target.value as PageSetup['orientation'] })} className="h-9 w-full rounded-lg border border-line bg-surface px-2">
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Margins</span>
          <select
            value={preset}
            onChange={(e) => {
              const p = MARGIN_PRESETS.find((x) => x.id === e.target.value);
              if (p) setDraft({ ...draft, margins: { top: p.mm, right: p.mm, bottom: p.mm, left: p.mm } });
            }}
            className="h-9 w-full rounded-lg border border-line bg-surface px-2"
          >
            {MARGIN_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        <div className="grid grid-cols-4 gap-2">
          {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
            <label key={side} className="block">
              <span className="mb-1 block text-xs text-muted capitalize">{side} (mm)</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={Math.round(draft.margins[side] * 10) / 10}
                onChange={(e) => setDraft({ ...draft, margins: { ...draft.margins, [side]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } })}
                className="h-9 w-full rounded-lg border border-line bg-surface px-2"
              />
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Apply
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
