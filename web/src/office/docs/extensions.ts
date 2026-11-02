import { Extension, Mark, mergeAttributes, Node } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Word-processor features on top of TipTap: page breaks, paragraph indents, find & replace,
// comments anchored to text, and a table of contents built from the headings.

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: { setPageBreak: () => ReturnType };
    indent: { indent: () => ReturnType; outdent: () => ReturnType };
    findReplace: {
      setSearch: (term: string, caseSensitive?: boolean) => ReturnType;
      findNext: () => ReturnType;
      findPrevious: () => ReturnType;
      replaceCurrent: (text: string) => ReturnType;
      replaceAll: (text: string) => ReturnType;
    };
    comment: { setComment: (id: string) => ReturnType; unsetComment: (id: string) => ReturnType };
    tableOfContents: { insertTableOfContents: () => ReturnType };
  }
}

/** A manual page break: the next content starts on a new page when printed or exported. */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }, { tag: 'p[data-page-break]' }],
  // An empty paragraph that starts a new page is what Word and LibreOffice understand from HTML.
  renderHTML: ({ HTMLAttributes }) => ['p', mergeAttributes(HTMLAttributes, { 'data-page-break': '', class: 'page-break', style: 'page-break-before: always' })],
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name }).createParagraphNear().run(),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
  },
});

const INDENT_STEP = 36; // px, about half an inch
const MAX_INDENT = 12;

/** Indenting whole paragraphs and headings (lists indent by nesting instead). */
export const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => {
              const m = /margin-left:\s*([\d.]+)(px|pt|in|cm)?/i.exec(el.getAttribute('style') ?? '');
              if (!m) return 0;
              const v = parseFloat(m[1]);
              const px = m[2] === 'pt' ? v * (4 / 3) : m[2] === 'in' ? v * 96 : m[2] === 'cm' ? v * 37.8 : v;
              return Math.min(MAX_INDENT, Math.round(px / INDENT_STEP));
            },
            renderHTML: (attrs) => (attrs.indent ? { style: `margin-left: ${attrs.indent * INDENT_STEP}px` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    const change =
      (delta: number) =>
      ({ tr, state, dispatch }: { tr: Transaction; state: EditorState; dispatch?: (tr: Transaction) => void }) => {
        let changed = false;
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
          if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
          const next = Math.max(0, Math.min(MAX_INDENT, (node.attrs.indent ?? 0) + delta));
          if (next === node.attrs.indent) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          changed = true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };
    return {
      indent: () => (props) => {
        // In a list, Tab nests the item instead.
        if (this.editor.isActive('listItem') || this.editor.isActive('taskItem')) return this.editor.commands.sinkListItem(this.editor.isActive('taskItem') ? 'taskItem' : 'listItem');
        return change(1)(props);
      },
      outdent: () => (props) => {
        if (this.editor.isActive('listItem') || this.editor.isActive('taskItem')) return this.editor.commands.liftListItem(this.editor.isActive('taskItem') ? 'taskItem' : 'listItem');
        return change(-1)(props);
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => (this.editor.isActive('table') ? false : this.editor.commands.indent()),
      'Shift-Tab': () => (this.editor.isActive('table') ? false : this.editor.commands.outdent()),
    };
  },
});

// ---------- find & replace ----------

interface SearchState {
  term: string;
  caseSensitive: boolean;
  matches: { from: number; to: number }[];
  current: number;
}

export const searchKey = new PluginKey<SearchState>('findReplace');

function findMatches(doc: EditorState['doc'], term: string, caseSensitive: boolean) {
  const out: { from: number; to: number }[] = [];
  if (!term) return out;
  const needle = caseSensitive ? term : term.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = caseSensitive ? node.text : node.text.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push({ from: pos + i, to: pos + i + needle.length });
  });
  return out;
}

export const FindReplace = Extension.create({
  name: 'findReplace',
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: () => ({ term: '', caseSensitive: false, matches: [], current: 0 }),
          apply(tr, prev) {
            const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined;
            const next = { ...prev, ...meta };
            if (meta || tr.docChanged) {
              next.matches = findMatches(tr.doc, next.term, next.caseSensitive);
              next.current = Math.min(next.current, Math.max(0, next.matches.length - 1));
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const s = searchKey.getState(state);
            if (!s?.matches.length) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              s.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === s.current ? 'search-match current' : 'search-match' })),
            );
          },
        },
      }),
    ];
  },
  addCommands() {
    const go = (dir: 1 | -1) => () => ({ state, dispatch, view }: { state: EditorState; dispatch?: (tr: Transaction) => void; view: { dom: HTMLElement } }) => {
      const s = searchKey.getState(state);
      if (!s?.matches.length) return false;
      const current = (s.current + dir + s.matches.length) % s.matches.length;
      if (dispatch) dispatch(state.tr.setMeta(searchKey, { current }));
      requestAnimationFrame(() => view.dom.querySelector('.search-match.current')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      return true;
    };
    return {
      setSearch:
        (term, caseSensitive = false) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { term, caseSensitive, current: 0 }));
          return true;
        },
      findNext: go(1),
      findPrevious: go(-1),
      replaceCurrent:
        (text) =>
        ({ state, dispatch }) => {
          const s = searchKey.getState(state);
          const m = s?.matches[s.current];
          if (!m) return false;
          if (dispatch) dispatch(text ? state.tr.insertText(text, m.from, m.to) : state.tr.delete(m.from, m.to));
          return true;
        },
      replaceAll:
        (text) =>
        ({ state, dispatch }) => {
          const s = searchKey.getState(state);
          if (!s?.matches.length) return false;
          const tr = state.tr;
          // From the end, so earlier positions stay valid.
          for (const m of [...s.matches].reverse()) {
            if (text) tr.insertText(text, m.from, m.to);
            else tr.delete(m.from, m.to);
          }
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

/** Text with a comment on it; the comments themselves live in the doc's "comments" map. */
export const Comment = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => el.getAttribute('data-comment-id'), renderHTML: (a) => ({ 'data-comment-id': a.id }) } }),
  parseHTML: () => [{ tag: 'span[data-comment-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { class: 'doc-comment' }), 0],
  addCommands() {
    return {
      setComment:
        (id) =>
        ({ commands }) =>
          commands.setMark(this.name, { id }),
      unsetComment:
        (id) =>
        ({ tr, state, dispatch }) => {
          const type = state.schema.marks.comment;
          state.doc.descendants((node, pos) => {
            const mark = node.marks.find((m) => m.type === type && m.attrs.id === id);
            if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
          });
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

/** A table of contents that lists the document's headings and stays up to date. */
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  parseHTML: () => [{ tag: 'nav[data-toc]' }],
  renderHTML: ({ HTMLAttributes }) => ['nav', mergeAttributes(HTMLAttributes, { 'data-toc': '', class: 'doc-toc' })],
  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement('nav');
      dom.className = 'doc-toc';
      dom.contentEditable = 'false';
      const render = () => {
        const items: { level: number; text: string; pos: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'heading' && node.textContent.trim()) items.push({ level: node.attrs.level, text: node.textContent, pos });
        });
        dom.replaceChildren();
        const title = document.createElement('div');
        title.className = 'doc-toc-title';
        title.textContent = 'Contents';
        dom.append(title);
        if (!items.length) {
          const empty = document.createElement('div');
          empty.className = 'doc-toc-empty';
          empty.textContent = 'Add headings and they’ll be listed here.';
          dom.append(empty);
        }
        for (const it of items) {
          const a = document.createElement('a');
          a.textContent = it.text;
          a.style.paddingLeft = `${(it.level - 1) * 16}px`;
          a.onclick = (e) => {
            e.preventDefault();
            editor.chain().focus().setTextSelection(it.pos + 1).scrollIntoView().run();
          };
          dom.append(a);
        }
      };
      render();
      editor.on('update', render);
      return { dom, destroy: () => editor.off('update', render) };
    };
  },
});
