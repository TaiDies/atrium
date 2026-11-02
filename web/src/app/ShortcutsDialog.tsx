import { Dialog } from '../components/ui';

// Ctrl/⌘ + / : every keyboard shortcut in one place.

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Anywhere',
    items: [
      [`${MOD} K`, 'Search'],
      [`${MOD} P`, 'Jump to a page (recently opened)'],
      [`${MOD} \\`, 'Show or hide the sidebar'],
      [`${MOD} /`, 'These shortcuts'],
    ],
  },
  {
    title: 'In a page',
    items: [
      ['/', 'Insert a block (headings, lists, tables, columns, equations…)'],
      ['@', 'Mention a page or person, or insert a date'],
      [`${MOD} F`, 'Find in the page'],
      [`${MOD} H`, 'Find and replace'],
      [`${MOD} Z  /  ${MOD} Shift Z`, 'Undo / redo'],
      [`${MOD} B / I / U`, 'Bold / italic / underline'],
      [`${MOD} Shift S`, 'Strikethrough'],
      [`${MOD} K`, 'Add a link to the selected text'],
      ['Tab  /  Shift Tab', 'Indent / outdent a block'],
      ['Esc', 'Select the block (then arrows to move between blocks)'],
    ],
  },
  {
    title: 'Typing shortcuts',
    items: [
      ['#  ##  ###', 'Headings'],
      ['-  or  *', 'Bulleted list'],
      ['1.', 'Numbered list'],
      ['[ ]', 'To-do'],
      ['>', 'Toggle list'],
      ['```', 'Code block'],
    ],
  },
  {
    title: 'Notes and PDFs',
    items: [
      ['P / H / S / T / E', 'Pen / highlighter / shapes / text / eraser'],
      ['V  or  Esc', 'Read (stop drawing)'],
      ['[  ]', 'Smaller / bigger'],
      ['Shift (while drawing)', 'Straight lines and even shapes'],
    ],
  },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={640} maxHeight="84vh">
      <div className="grid gap-x-8 gap-y-5 px-5 pb-5 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="mb-1.5 text-xs font-semibold tracking-wide text-faint uppercase">{g.title}</div>
            {g.items.map(([keys, what]) => (
              <div key={keys + what} className="flex items-start justify-between gap-3 py-1 text-sm">
                <span className="text-muted">{what}</span>
                <kbd className="shrink-0 rounded border border-line bg-sidebar px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap">{keys}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
