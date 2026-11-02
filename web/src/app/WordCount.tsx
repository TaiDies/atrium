import { Dialog } from '../components/ui';
import type { EditorHandle } from './DocumentEditor';

// Words, characters and reading time for a page (and for the selected text, if any).

function textOf(blocks: any[]): string {
  const parts: string[] = [];
  const inline = (content: any): void => {
    if (!Array.isArray(content)) {
      // Tables keep their cells in rows.
      if (content?.type === 'tableContent') for (const row of content.rows ?? []) for (const cell of row.cells ?? []) inline(Array.isArray(cell) ? cell : cell?.content);
      return;
    }
    for (const c of content) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'link') inline(c.content);
    }
  };
  const walk = (list: any[]) => {
    for (const b of list) {
      inline(b.content);
      parts.push('\n');
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return parts.join('');
}

function stats(text: string) {
  const words = text.match(/[\p{L}\p{N}'’-]+/gu)?.length ?? 0;
  return { words, chars: text.replace(/\n/g, '').length, charsNoSpaces: text.replace(/\s/g, '').length, minutes: Math.max(1, Math.round(words / 220)) };
}

export function WordCountDialog({ editor, onClose }: { editor: EditorHandle | null; onClose: () => void }) {
  if (!editor) return null;
  const all = stats(textOf(editor.document as any[]));
  const selected = editor.getSelectedText();
  const sel = selected ? stats(selected) : null;
  const row = (label: string, value: string | number, extra?: string | number) => (
    <div className="flex justify-between border-b border-line py-1.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">
        {value}
        {extra !== undefined && <span className="ms-2 text-faint">({extra} selected)</span>}
      </span>
    </div>
  );
  return (
    <Dialog open onClose={onClose} title="Word count" width={360}>
      <div className="px-5 pb-5">
        {row('Words', all.words.toLocaleString(), sel?.words.toLocaleString())}
        {row('Characters', all.chars.toLocaleString(), sel?.chars.toLocaleString())}
        {row('Characters without spaces', all.charsNoSpaces.toLocaleString(), sel?.charsNoSpaces.toLocaleString())}
        {row('Blocks', countBlocks(editor.document as any[]))}
        {row('Reading time', `about ${all.minutes} min`)}
      </div>
    </Dialog>
  );
}

function countBlocks(blocks: any[]): number {
  return blocks.reduce((n, b) => n + 1 + (b.children?.length ? countBlocks(b.children) : 0), 0);
}
