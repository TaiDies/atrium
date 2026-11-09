import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  BlockColorsItem,
  DragHandleMenu,
  FormattingToolbar,
  getFormattingToolbarItems,
  RemoveBlockItem,
  SideMenu,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState,
} from '@blocknote/react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Spinner, toast, toastError } from '../components/ui';
import { aiApi, api, isStopped } from '../lib/api';
import { useStoppable } from '../lib/useStoppable';
import { queryClient } from '../lib/queries';
import { getDirectory } from '../lib/directory';
import { selectionHasBlocks } from './blockSelection';

/** Whether an AI connection is set up for this person (the AI tools only show when there is one). */
export function useAiAvailable() {
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<{ available: boolean }>('/api/ai/status'),
    // Checked again whenever a screen opens, so the AI buttons follow a connection being added or removed.
    staleTime: 0,
    // Published pages have no signed-in person to ask for.
    enabled: !getDirectory()?.public,
  });
  aiReadyNow = !!status.data?.available;
  return aiReadyNow;
}

let aiReadyNow = false;
/** Whether AI was available when last checked (for menus built outside React, like the / menu). */
export const aiReady = () => aiReadyNow;

/** Turns an audio or video attachment into text, added below it (a "Transcript" heading, then the words). */
export async function transcribeInto(editor: any, workspaceId: string, blockId: string, url: string) {
  const fileId = /\/api\/files\/([0-9a-f-]{36})/i.exec(url)?.[1];
  if (!fileId) return toastError(new Error('Only files uploaded here can be transcribed'));
  toast('Transcribing… this can take a minute for long recordings');
  try {
    const { text } = await aiApi<{ text: string }>(`/api/workspaces/${workspaceId}/ai/transcribe`, { method: 'POST', body: { fileId } });
    const block = editor.getBlock(blockId);
    if (!block) return;
    const paragraphs = text.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean);
    editor.insertBlocks(
      [
        { type: 'heading', props: { level: 3 }, content: 'Transcript' },
        ...paragraphs.map((p: string) => ({ type: 'paragraph', content: p })),
      ],
      block,
      'after',
    );
    toast('Transcript added below the recording');
  } catch (err) {
    toastError(err);
  }
}

/** "/ai": write something new where the cursor is (on an empty line, or a new one below). */
export function openAiWrite(editor: any) {
  let block = editor.getTextCursorPosition().block;
  const empty = Array.isArray(block.content) && block.content.length === 0;
  if (!empty) {
    const [inserted] = editor.insertBlocks([{ type: 'paragraph' }], block, 'after');
    block = inserted;
  }
  hosts.get(editor)?.({ text: '', from: 0, to: 0, inline: false, blocks: [block], eventIds: [], files: [] });
}

const QUICK: { label: string; instruction: string }[] = [
  { label: 'Improve writing', instruction: 'Improve the writing: clearer and better flowing, same meaning and tone.' },
  { label: 'Fix spelling & grammar', instruction: 'Fix spelling, grammar and punctuation. Change nothing else.' },
  { label: 'Make shorter', instruction: 'Make it shorter and more concise, keeping the key points.' },
  { label: 'Make longer', instruction: 'Expand it with more detail and explanation.' },
  { label: 'Simplify', instruction: 'Rewrite it in simpler words that are easy to understand.' },
  { label: 'Summarise', instruction: 'Summarise it as a few short bullet points.' },
  { label: 'Turn into a to-do list', instruction: 'Turn it into a Markdown task list ("- [ ] item"), one action per line.' },
  { label: 'Explain', instruction: 'Explain what this means, simply and briefly.' },
  { label: 'Translate to English', instruction: 'Translate it to English.' },
];

const TASK_QUICK: { label: string; instruction: string }[] = [
  { label: 'Mark as done', instruction: 'Mark every selected task as done.' },
  { label: 'Move to tomorrow', instruction: 'Move every selected task/event to the day after its current date (keep times).' },
  { label: 'Move a week later', instruction: 'Move every selected task/event one week later (keep times).' },
  { label: 'Clearer titles', instruction: 'Rewrite the task/event titles to be short and clear. Change nothing else.' },
];

const FILE_QUICK: { label: string; instruction: string }[] = [
  { label: 'Summarise the file', instruction: 'Summarise the attached file(s) as short notes with headings and bullet points.' },
  { label: 'Study notes', instruction: 'Make clear study notes from the attached file(s), with key terms in bold and a short self-test at the end.' },
  { label: 'To-do list from it', instruction: 'Make a Markdown task list ("- [ ] item") of the actions in the attached file(s).' },
];

interface Captured {
  text: string;
  from: number;
  to: number;
  /** Whether the selection is inside one paragraph (so a one-line answer can replace just that text). */
  inline: boolean;
  blocks: any[];
  /** Tasks and events among the blocks (their ids), and attached files ({id, name}). */
  eventIds: string[];
  files: { id: string; name: string }[];
}

interface TaskInfo {
  id: string;
  title: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  status: 'todo' | 'doing' | 'done' | null;
  description: string;
}

const isTextBlock = (b: any) => Array.isArray(b.content) || b.content?.type === 'tableContent';
const FILE_ID = /\/api\/files\/([0-9a-f-]{36})/i;

/** What a set of whole blocks holds: their text (as Markdown), the tasks in them and the attached files. */
function captureBlocks(editor: any, blocks: any[]): Captured {
  const all: any[] = [];
  const walk = (list: any[]) => {
    for (const b of list) {
      all.push(b);
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  let text = '';
  try {
    text = editor.blocksToMarkdownLossy(blocks.filter(isTextBlock));
  } catch {
    text = '';
  }
  const eventIds = all.filter((b) => b.type === 'event' && b.props?.eventId).map((b) => String(b.props.eventId));
  const files = all
    .map((b) => ({ m: FILE_ID.exec(String(b.props?.url ?? '')), name: String(b.props?.name || b.props?.caption || 'file') }))
    .filter((x) => x.m)
    .map((x) => ({ id: x.m![1], name: x.name }));
  return { text: text.trim(), from: 0, to: 0, inline: false, blocks, eventIds: [...new Set(eventIds)], files };
}

/** Opens "Ask AI" for whole blocks: anything — text, tasks, files, images. */
export function openAiForBlocks(editor: any, blocks: any[]) {
  if (blocks.length) hosts.get(editor)?.(captureBlocks(editor, blocks));
}

/** The formatting toolbar with an "AI" button added, for pages and cards when an AI connection is set up. */
export function AiFormattingToolbar() {
  return (
    <FormattingToolbar>
      {...getFormattingToolbarItems()}
      <AiToolbarButton key="ai" />
    </FormattingToolbar>
  );
}

// The dialog lives with the editor, not in the toolbar: the toolbar disappears as soon as the dialog
// takes the focus, and anything inside it would go too.
const hosts = new WeakMap<object, (c: Captured) => void>();

/** Where an editor's "Ask AI" dialog shows (put once next to each editor). */
export function AiSelectionHost({ editor, workspaceId }: { editor: any; workspaceId: string }) {
  const [captured, setCaptured] = useState<Captured | null>(null);
  useEffect(() => {
    hosts.set(editor, setCaptured);
    return () => {
      hosts.delete(editor);
    };
  }, [editor]);
  // A selection that takes in tasks, files or images doesn't get the text toolbar: offer AI next to it.
  const [mixedAt, setMixedAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const view = editor.prosemirrorView;
      if (!view || !view.hasFocus() || !selectionHasBlocks(view)) return setMixedAt(null);
      const end = view.coordsAtPos(view.state.selection.to);
      setMixedAt({ x: Math.min(end.right + 8, window.innerWidth - 110), y: Math.min(end.bottom + 6, window.innerHeight - 44) });
    };
    const off = editor.onSelectionChange(update);
    const blur = () => setTimeout(update, 150);
    window.addEventListener('blur', blur);
    return () => {
      off?.();
      window.removeEventListener('blur', blur);
    };
  }, [editor]);
  return (
    <>
      {mixedAt &&
        !captured &&
        createPortal(
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              openAiForBlocks(editor, editor.getSelection()?.blocks ?? []);
            }}
            className="fixed z-40 flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] font-medium text-accent shadow-pop hover:bg-hover"
            style={{ left: mixedAt.x, top: mixedAt.y }}
          >
            <Sparkles size={14} /> Ask AI
          </button>,
          document.body,
        )}
      {captured && createPortal(<AiDialog editor={editor} workspaceId={workspaceId} captured={captured} onClose={() => setCaptured(null)} />, document.body)}
    </>
  );
}

function AiToolbarButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;

  const open = () => {
    const view = editor.prosemirrorView;
    const sel = view.state.selection;
    const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
    // A selection that takes in tasks, files or images: work on the whole blocks.
    if (blocks.some((b: any) => !isTextBlock(b))) return openAiForBlocks(editor, blocks);
    hosts.get(editor)?.({
      text: editor.getSelectedText(),
      from: sel.from,
      to: sel.to,
      inline: sel.$from.sameParent(sel.$to),
      blocks,
      eventIds: [],
      files: [],
    });
  };

  return (
    <Components.FormattingToolbar.Button mainTooltip="Ask AI to change this text" label="AI" icon={<Sparkles size={15} />} onClick={open}>
      <span className="flex items-center gap-1 px-0.5 text-[13px] font-medium text-accent">
        <Sparkles size={14} /> AI
      </span>
    </Components.FormattingToolbar.Button>
  );
}

/** "Ask AI" in a block's ⋮⋮ menu: for that block (or every selected block, when it's one of them). */
function AskAiItem({ children }: { children: React.ReactNode }) {
  const editor = useBlockNoteEditor<any, any, any>();
  const current = useExtensionState(SideMenuExtension, { editor, selector: (s: any) => s?.block }) as any;
  // The menu lets go of its block as the mouse goes down; remember it so the click still lands here.
  const last = useRef<any>(null);
  if (current) last.current = current;
  if (!last.current) return null;
  const open = () => {
    const block = last.current;
    const selected = editor.getSelection()?.blocks;
    openAiForBlocks(editor, selected?.some((b: any) => b.id === block.id) ? selected : [block]);
  };
  // A plain button that acts as the pointer goes down: the menu closes (and lets go of the block)
  // before a click would arrive.
  return (
    <button
      type="button"
      className="bn-menu-item flex w-full items-center rounded px-2.5 py-1.5 text-start text-sm hover:bg-hover"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open()}
    >
      {children}
    </button>
  );
}

function AiDragHandleMenu() {
  return (
    <DragHandleMenu>
      <AskAiItem>✨ Ask AI</AskAiItem>
      <RemoveBlockItem>Delete</RemoveBlockItem>
      <BlockColorsItem>Colors</BlockColorsItem>
      <TableRowHeaderItem>Header row</TableRowHeaderItem>
      <TableColumnHeaderItem>Header column</TableColumnHeaderItem>
    </DragHandleMenu>
  );
}

/** The block handle (⋮⋮) with "Ask AI" in its menu. */
export function AiSideMenu(props: any) {
  return <SideMenu {...props} dragHandleMenu={AiDragHandleMenu} />;
}

const pad = (n: number) => String(n).padStart(2, '0');
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function describeChange(before: TaskInfo | undefined, change: Record<string, unknown>) {
  const parts: string[] = [];
  if (change.title !== undefined) parts.push(`renamed to “${change.title}”`);
  if (change.startDate !== undefined || change.startTime !== undefined) {
    parts.push(`moved to ${change.startDate ?? before?.startDate}${change.startTime ? ` ${change.startTime}` : change.startTime === null ? ' (all day)' : ''}`);
  }
  if (change.endDate !== undefined || change.endTime !== undefined) parts.push(`ends ${change.endDate ?? ''}${change.endTime ? ` ${change.endTime}` : ''}`.trim());
  if (change.status !== undefined) parts.push(change.status === 'done' ? 'marked done' : change.status === 'doing' ? 'marked in progress' : change.status === 'todo' ? 'marked to do' : 'made an event');
  if (change.description !== undefined) parts.push('notes changed');
  return `${before?.title || 'Untitled'}: ${parts.join(', ')}`;
}

function AiDialog({ editor, workspaceId, captured, onClose }: { editor: any; workspaceId: string; captured: Captured; onClose: () => void }) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const stoppable = useStoppable();
  const [result, setResult] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, unknown>[]>([]);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const blockMode = !captured.inline && (captured.eventIds.length > 0 || captured.files.length > 0 || captured.blocks.some((b) => !isTextBlock(b)));

  const run = async (what: string) => {
    if (!what.trim() || busy) return;
    setBusy(what);
    const signal = stoppable.start();
    try {
      let context = '';
      try {
        context = editor.blocksToMarkdownLossy(editor.document).slice(0, 60_000);
      } catch {
        // Unusual blocks: go without the page around it.
      }
      // The tasks as they are now (the block only holds the id).
      const events = (
        await Promise.all(captured.eventIds.map((id) => api<{ event: TaskInfo }>(`/api/events/${id}`).then((r) => r.event).catch(() => null)))
      ).filter((e): e is TaskInfo => !!e);
      setTasks(events);
      const answer = await aiApi<{ text: string; events: Record<string, unknown>[] }>(`/api/workspaces/${workspaceId}/ai/transform`, {
        method: 'POST',
        body: {
          text: captured.text,
          instruction: what,
          context,
          events: events.map(({ id, title, startDate, startTime, endDate, endTime, status, description }) => ({ id, title, startDate, startTime, endDate, endTime, status, description: description ?? '' })),
          fileIds: captured.files.map((f) => f.id),
          today: todayIso(),
        },
        signal,
      });
      setResult(answer.text);
      setChanges(answer.events ?? []);
    } catch (err) {
      if (!isStopped(err)) toastError(err);
    } finally {
      setBusy(null);
    }
  };

  /** Saves the suggested changes to the tasks (they update everywhere they're shown). */
  const applyTasks = async () => {
    for (const { id, ...patch } of changes) await api(`/api/events/${id}`, { method: 'PATCH', body: patch });
    if (changes.length) {
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['event'] });
    }
  };

  const blocksOf = (md: string) => editor.tryParseMarkdownToBlocks(md);
  const singleLine = (md: string) => !/\n/.test(md.trim()) && !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/.test(md.trim());

  const replace = async () => {
    if (result === null) return;
    try {
      await applyTasks();
      if (blockMode) {
        // Only the text blocks are rewritten; tasks, files and images stay where they are.
        const textBlocks = captured.blocks.filter(isTextBlock);
        if (result.trim()) {
          if (textBlocks.length) {
            editor.insertBlocks(blocksOf(result), textBlocks[0], 'before');
            editor.removeBlocks(textBlocks);
          } else {
            editor.insertBlocks(blocksOf(result), captured.blocks[captured.blocks.length - 1], 'after');
          }
        }
      } else if (captured.inline && singleLine(result)) {
        const view = editor.prosemirrorView;
        view.dispatch(view.state.tr.insertText(result.trim().replace(/^\*\*(.*)\*\*$/, '$1'), captured.from, captured.to));
      } else {
        editor.replaceBlocks(captured.blocks, blocksOf(result));
      }
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  const insertBelow = async () => {
    if (result === null) return;
    try {
      await applyTasks();
      if (result.trim()) editor.insertBlocks(blocksOf(result), captured.blocks[captured.blocks.length - 1], 'after');
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  // Nothing picked ("/ai" on an empty line): the AI writes something new there.
  const writing = !captured.text && !captured.eventIds.length && !captured.files.length;
  // Shortcuts that fit what was picked: tasks, files, or text.
  const quick = [...(captured.eventIds.length ? TASK_QUICK : []), ...(captured.files.length ? FILE_QUICK : []), ...(captured.text ? QUICK : [])];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(instruction);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-3 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[76vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl">
        <div className="border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={15} className="text-accent" /> Ask AI
          </div>
          {captured.text && <p className="mt-1 line-clamp-2 text-xs text-muted">“{captured.text.slice(0, 300)}”</p>}
          {(captured.eventIds.length > 0 || captured.files.length > 0) && (
            <p className="mt-1 text-xs text-muted">
              {[
                captured.eventIds.length ? `${captured.eventIds.length} task${captured.eventIds.length === 1 ? '' : 's'} or event${captured.eventIds.length === 1 ? '' : 's'}` : '',
                ...captured.files.map((f) => `📎 ${f.name}`),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {result === null ? (
            <>
              <form onSubmit={submit} className="flex gap-2">
                <input
                  autoFocus
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && onClose()}
                  placeholder={writing ? 'What should the AI write here?' : 'Tell the AI what to do with it…'}
                  className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
                />
                <button type="submit" disabled={!instruction.trim() || !!busy} className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50">
                  Go
                </button>
              </form>
              <div className="mt-3 grid grid-cols-2 gap-1">
                {quick.map((q) => (
                  <button
                    key={q.label}
                    disabled={!!busy}
                    onClick={() => void run(q.instruction)}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover disabled:opacity-50"
                  >
                    {busy === q.instruction ? <Spinner className="size-3.5" /> : <Sparkles size={13} className="text-faint" />}
                    {q.label}
                  </button>
                ))}
              </div>
              {busy && (
                <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                  {!quick.some((q) => q.instruction === busy) && (
                    <>
                      <Spinner className="size-4" /> Working on it…
                    </>
                  )}
                  <button type="button" onClick={() => stoppable.stop()} className="ml-auto rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover">
                    Stop
                  </button>
                </p>
              )}
            </>
          ) : (
            <>
              {result.trim() && (
                <div
                  className="ai-markdown rounded-lg border border-line bg-surface px-3 py-2 text-sm"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(result, { gfm: true, async: false }) as string) }}
                />
              )}
              {changes.length > 0 && (
                <div className="mt-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                  <div className="mb-1 text-xs font-medium text-muted">Changes to tasks</div>
                  <ul className="list-disc space-y-0.5 ps-4">
                    {changes.map((c) => (
                      <li key={String(c.id)}>{describeChange(tasks.find((t) => t.id === c.id), c)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!result.trim() && !changes.length && <p className="text-sm text-muted">The AI suggested no changes.</p>}
            </>
          )}
        </div>
        {result !== null && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
            <button onClick={() => void replace()} className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-white">
              {writing ? 'Insert' : result.trim() ? 'Replace' : 'Apply changes'}
            </button>
            {result.trim() && !writing && (
              <button onClick={() => void insertBelow()} className="h-8 rounded-md border border-line px-3 text-sm hover:bg-hover">
                Insert below
              </button>
            )}
            <button
              onClick={() => {
                void navigator.clipboard.writeText(result).then(() => toast('Copied'));
              }}
              className="h-8 rounded-md px-3 text-sm text-muted hover:bg-hover"
            >
              Copy
            </button>
            <div className="flex-1" />
            <button onClick={() => setResult(null)} className="h-8 rounded-md px-3 text-sm text-muted hover:bg-hover">
              Try something else
            </button>
            <button onClick={onClose} className="h-8 rounded-md px-3 text-sm text-muted hover:bg-hover">
              Discard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
