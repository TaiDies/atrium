import { SuggestionMenu } from '@blocknote/core/extensions';
import { useExtension } from '@blocknote/react';
import { Bold, Check, IndentDecrease, IndentIncrease, Italic, List, ListChecks, Plus, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useState } from 'react';
import { openAiForBlocks } from './AiSelection';

// On phones there's no hovering block handle and the floating toolbar is fiddly, so while typing a
// toolbar sits on top of the keyboard: add a block, bold, italic, lists, indent, undo/redo and AI.

function Key({ label, onPress, children, active }: { label: string; onPress: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Pressing a key mustn't take the focus from the text (that would close the keyboard).
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={`flex h-10 min-w-10 shrink-0 items-center justify-center rounded-lg px-2 ${active ? 'bg-accent/15 text-accent' : 'text-fg active:bg-hover'}`}
    >
      {children}
    </button>
  );
}

export function PhoneToolbar({ editor, wrapper, ai }: { editor: any; wrapper: RefObject<HTMLDivElement | null>; ai: boolean }) {
  const suggestions = useExtension(SuggestionMenu, { editor }) as any;
  const [focused, setFocused] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const root = wrapper.current;
    if (!root) return;
    const onIn = () => setFocused(true);
    const onOut = () => setTimeout(() => setFocused(!!root.contains(document.activeElement) && (document.activeElement as HTMLElement)?.isContentEditable), 50);
    root.addEventListener('focusin', onIn);
    root.addEventListener('focusout', onOut);
    // Keep the bold/italic/list states current as the cursor moves.
    const off = editor.onSelectionChange?.(() => setTick((t) => t + 1));
    return () => {
      root.removeEventListener('focusin', onIn);
      root.removeEventListener('focusout', onOut);
      off?.();
    };
  }, [editor, wrapper]);

  if (!focused) return null;
  const styles = editor.getActiveStyles?.() ?? {};
  const block = editor.getTextCursorPosition().block;
  const setType = (type: string) => {
    const current = editor.getTextCursorPosition().block;
    editor.updateBlock(current, { type: current.type === type ? 'paragraph' : type });
  };

  return (
    <div className="atrium-phone-toolbar fixed inset-x-0 bottom-0 z-40 flex items-center gap-0.5 overflow-x-auto border-t border-line bg-surface px-1 py-1 shadow-pop">
      <Key label="Add a block" onPress={() => suggestions?.openSuggestionMenu?.('/')}>
        <Plus size={20} />
      </Key>
      <Key label="Bold" active={!!styles.bold} onPress={() => editor.toggleStyles({ bold: true })}>
        <Bold size={18} />
      </Key>
      <Key label="Italic" active={!!styles.italic} onPress={() => editor.toggleStyles({ italic: true })}>
        <Italic size={18} />
      </Key>
      <Key label="To-do" active={block.type === 'checkListItem'} onPress={() => setType('checkListItem')}>
        <ListChecks size={19} />
      </Key>
      <Key label="Bulleted list" active={block.type === 'bulletListItem'} onPress={() => setType('bulletListItem')}>
        <List size={19} />
      </Key>
      <Key label="Indent" onPress={() => editor.canNestBlock() && editor.nestBlock()}>
        <IndentIncrease size={18} />
      </Key>
      <Key label="Outdent" onPress={() => editor.canUnnestBlock() && editor.unnestBlock()}>
        <IndentDecrease size={18} />
      </Key>
      <Key label="Undo" onPress={() => editor.undo()}>
        <Undo2 size={18} />
      </Key>
      <Key label="Redo" onPress={() => editor.redo()}>
        <Redo2 size={18} />
      </Key>
      {ai && (
        <Key label="Ask AI" onPress={() => openAiForBlocks(editor, editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block])}>
          <Sparkles size={18} className="text-accent" />
        </Key>
      )}
      <div className="flex-1" />
      <Key
        label="Done"
        onPress={() => {
          (document.activeElement as HTMLElement | null)?.blur();
          setFocused(false);
        }}
      >
        <Check size={20} />
      </Key>
    </div>
  );
}
