import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Blocks with no text of their own (tasks and events, files, images, embeds, whiteboards…) can't show
// the browser's text highlight, so a selection running across them looked like it skipped them. This
// marks every such block inside the selection, so it's plain that they're selected along with the text
// (and the AI button, copy, delete and the rest act on them too).

const key = new PluginKey('af-block-selection');

// Where the pointer is while a selection is being dragged (to take in the block it's over).
let dragPointer: { x: number; y: number } | null = null;
// Where that selection started (read as the button goes down; the editor's own state lags behind).
let dragAnchor: number | null = null;

/** The text-less block under a point, as [from, to] positions, if there is one. */
function atomBlockAt(view: EditorView, x: number, y: number): [number, number] | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit || hit.inside < 0) return null;
  const doc = view.state.doc;
  for (const pos of [hit.inside, hit.inside + 1]) {
    const node = pos <= doc.content.size ? doc.nodeAt(pos) : null;
    if (node?.isBlock && node.isAtom) return [pos, pos + node.nodeSize];
  }
  return null;
}

const blockSelectionPlugin = new Plugin({
  key,
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        dragAnchor = event.button === 0 && !event.shiftKey ? (view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null) : null;
        return false;
      },
      mousemove(view, event) {
        dragPointer = event.buttons & 1 ? { x: event.clientX, y: event.clientY } : null;
        // Over a text-less block the browser's selection doesn't move, so stretch it here as well.
        const { selection } = view.state;
        if (!dragPointer || selection instanceof NodeSelection) return false;
        const block = atomBlockAt(view, dragPointer.x, dragPointer.y);
        if (!block) return false;
        const anchor = dragAnchor ?? selection.anchor;
        const head = block[0] < anchor ? block[0] : block[1];
        if (head !== selection.head || anchor !== selection.anchor) {
          try {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
          } catch {
            // Not a place a selection can end: leave it as it is.
          }
        }
        return false;
      },
      mouseup() {
        dragPointer = null;
        dragAnchor = null;
        return false;
      },
    },
    // Dragging a selection onto a task, file or image: the browser can't end a selection inside it, so
    // the selection is stretched to take the whole block in (above or below where it started).
    createSelectionBetween(view, $anchor) {
      if (!dragPointer) return null;
      const block = atomBlockAt(view, dragPointer.x, dragPointer.y);
      if (!block) return null;
      const anchor = dragAnchor ?? $anchor.pos;
      const head = block[0] < anchor ? block[0] : block[1];
      try {
        return TextSelection.create(view.state.doc, anchor, head);
      } catch {
        return null;
      }
    },
    decorations(state) {
      const { selection, doc } = state;
      if (selection.empty || selection instanceof NodeSelection) return null;
      const { from, to } = selection;
      const decorations: Decoration[] = [];
      doc.nodesBetween(from, to, (node, pos) => {
        // A block's own content node with nothing editable inside (an atom), wholly in the selection.
        if (node.isBlock && node.isAtom && pos >= from && pos + node.nodeSize <= to) {
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'af-selected-block' }));
          return false;
        }
        return true;
      });
      if (!decorations.length) return null;
      // With a block like that in it, the browser can't draw the selection, so the text is marked too.
      decorations.push(Decoration.inline(from, to, { class: 'af-selected-text' }));
      return DecorationSet.create(doc, decorations);
    },
  },
});

export const BlockSelectionExtension = createExtension({ key: 'afBlockSelection', prosemirrorPlugins: [blockSelectionPlugin] });

/** Whether the selection takes in any block without text (a task, file, image…) along with the rest. */
export function selectionHasBlocks(view: EditorView): boolean {
  const { selection, doc } = view.state;
  if (selection.empty || selection instanceof NodeSelection) return false;
  let found = false;
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (found) return false;
    if (node.isBlock && node.isAtom && pos >= selection.from && pos + node.nodeSize <= selection.to) found = true;
    return !found;
  });
  return found;
}
