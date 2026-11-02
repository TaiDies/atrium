import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

// Find (Ctrl/⌘+F) and replace (Ctrl/⌘+H) in a page. Matches are highlighted with the CSS Custom
// Highlight API, so the document itself isn't touched until something is replaced.

interface Match {
  from: number;
  to: number;
}

function findMatches(view: EditorView, needle: string, matchCase: boolean): Match[] {
  if (!needle) return [];
  const out: Match[] = [];
  const q = matchCase ? needle : needle.toLowerCase();
  view.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = matchCase ? node.text : node.text.toLowerCase();
    for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) out.push({ from: pos + i, to: pos + i + q.length });
  });
  return out;
}

function domRange(view: EditorView, m: Match): Range | null {
  try {
    const start = view.domAtPos(m.from);
    const end = view.domAtPos(m.to);
    const r = document.createRange();
    r.setStart(start.node, start.offset);
    r.setEnd(end.node, end.offset);
    return r;
  } catch {
    return null;
  }
}

type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (): HighlightRegistry | null => (typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: HighlightRegistry }).highlights : null);
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

export function FindBar({ view, replace: startWithReplace, onClose, editable }: { view: EditorView; replace: boolean; onClose: () => void; editable: boolean }) {
  const [query, setQuery] = useState(() => {
    const { from, to } = view.state.selection;
    return to > from && to - from < 100 ? view.state.doc.textBetween(from, to) : '';
  });
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(startWithReplace && editable);
  const [matchCase, setMatchCase] = useState(false);
  const [current, setCurrent] = useState(0);
  const [version, setVersion] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Find again when the document changes.
  useEffect(() => {
    const dom = view.dom;
    const bump = () => setVersion((v) => v + 1);
    dom.addEventListener('input', bump);
    const timer = setInterval(bump, 1500);
    return () => {
      dom.removeEventListener('input', bump);
      clearInterval(timer);
    };
  }, [view]);

  const matches = useMemo(() => findMatches(view, query, matchCase), [view, query, matchCase, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const index = matches.length ? Math.min(current, matches.length - 1) : 0;

  useEffect(() => {
    const reg = highlights();
    if (!reg || !HighlightCtor) return;
    const ranges = matches.map((m) => domRange(view, m)).filter((r): r is Range => !!r);
    reg.set('find-match', new HighlightCtor(...ranges));
    const cur = matches[index] && domRange(view, matches[index]);
    if (cur) reg.set('find-current', new HighlightCtor(cur));
    else reg.delete('find-current');
  }, [matches, index, view]);

  useEffect(
    () => () => {
      highlights()?.delete('find-match');
      highlights()?.delete('find-current');
    },
    [],
  );

  const reveal = (i: number) => {
    const m = matches[i];
    if (!m) return;
    const el = view.domAtPos(m.from).node;
    (el instanceof Element ? el : el.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const go = (step: number) => {
    if (!matches.length) return;
    const next = (index + step + matches.length) % matches.length;
    setCurrent(next);
    reveal(next);
  };
  const replaceOne = () => {
    const m = matches[index];
    if (!m || !editable) return;
    view.dispatch(view.state.tr.insertText(replacement, m.from, m.to));
    setVersion((v) => v + 1);
  };
  const replaceAll = () => {
    if (!editable || !matches.length) return;
    let tr = view.state.tr;
    for (const m of [...matches].reverse()) tr = tr.insertText(replacement, m.from, m.to);
    view.dispatch(tr);
    setVersion((v) => v + 1);
  };
  const selectCurrent = () => {
    const m = matches[index];
    if (m) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView());
    view.focus();
    onClose();
  };

  useEffect(() => input.current?.select(), []);

  return (
    <div className="fixed top-14 end-4 z-40 w-[min(380px,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-2 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        {editable && (
          <button onClick={() => setShowReplace((v) => !v)} className={clsx('rounded p-1 text-muted hover:bg-hover', showReplace && 'text-accent')} title="Replace (Ctrl+H)">
            <Replace size={14} />
          </button>
        )}
        <input
          ref={input}
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrent(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.altKey) selectCurrent();
              else go(e.shiftKey ? -1 : 1);
            }
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Find in page"
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <span className="w-14 shrink-0 text-center text-xs text-muted tabular-nums">{query ? (matches.length ? `${index + 1}/${matches.length}` : '0/0') : ''}</span>
        <button onClick={() => setMatchCase((v) => !v)} className={clsx('rounded px-1 text-xs font-semibold', matchCase ? 'text-accent' : 'text-faint hover:text-fg')} title="Match case">
          Aa
        </button>
        <button onClick={() => go(-1)} className="rounded p-1 text-muted hover:bg-hover" title="Previous (Shift+Enter)">
          <ChevronUp size={15} />
        </button>
        <button onClick={() => go(1)} className="rounded p-1 text-muted hover:bg-hover" title="Next (Enter)">
          <ChevronDown size={15} />
        </button>
        <button onClick={onClose} className="rounded p-1 text-muted hover:bg-hover" title="Close (Esc)">
          <X size={15} />
        </button>
      </div>
      {showReplace && (
        <div className="mt-1.5 flex items-center gap-1 ps-7">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.ctrlKey || e.metaKey) replaceAll();
                else replaceOne();
              }
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Replace with"
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <button onClick={replaceOne} disabled={!matches.length} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-50">
            Replace
          </button>
          <button onClick={replaceAll} disabled={!matches.length} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-50">
            All
          </button>
        </div>
      )}
    </div>
  );
}
