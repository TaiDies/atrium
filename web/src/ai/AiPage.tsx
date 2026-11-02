import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  GraduationCap,
  ListChecks,
  MessageSquarePlus,
  NotebookPen,
  Paperclip,
  Pencil,
  Search,
  PanelLeft,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApp } from '../app/context';
import { PageIcon } from '../app/PageIcon';
import { COLOR_HEX, createEvent, EVENT_COLORS, type EventColor, REMINDERS } from '../calendar/api';
import { type Anchor, Button, confirmDialog, Dialog, IconButton, Popover, Spinner, toast, toastError } from '../components/ui';
import { api, pageTitle } from '../lib/api';
import { queryClient } from '../lib/queries';
import { kindOf, useWorkspaceFiles } from '../notes/api';
import { notificationsKey, SidebarIcon } from '../notifications/Notifications';
import { buildProposal, type Built, type Proposal, type ProposedTask } from './build';
import { ACCEPTED, extractText } from './extract';

// The AI assistant: chat with your own AI provider (or the one the server offers), give it files and
// pages to work from, and add what it makes — documents and dated tasks — to the workspace.

type Provider = 'anthropic' | 'openai' | 'gemini';

interface AiStatus {
  available: boolean;
  source: 'own' | 'shared' | null;
  model: { provider: Provider; model: string } | null;
  shared: { provider: Provider; model: string } | null;
  canUseOwn: boolean;
  own: { provider: Provider; model: string; baseUrl: string | null; keyHint: string | null; useOwn: boolean } | null;
  defaults: Record<Provider, string>;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  attachments?: { name: string; chars: number; truncated: boolean }[];
  proposal?: Proposal;
  applied?: { pages: { id: string; title: string }[]; tasks: number };
  /** The answer is still being written (it's saved into the conversation when it arrives). */
  pending?: boolean;
  /** Why no answer came. */
  error?: string;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
}

const PROVIDER_NAMES: Record<Provider, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI or compatible', gemini: 'Google Gemini' };

/** Addresses for OpenAI-compatible services, to fill in quickly. */
const COMPATIBLE: { label: string; url: string }[] = [
  { label: 'OpenAI', url: '' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { label: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { label: 'Mistral', url: 'https://api.mistral.ai/v1' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { label: 'Ollama (local)', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio (local)', url: 'http://localhost:1234/v1' },
];

const STARTERS: { icon: React.ReactNode; label: string; text: string; calendar?: boolean }[] = [
  {
    icon: <GraduationCap size={16} />,
    label: 'Study plan',
    calendar: true,
    text: 'Make me a study plan.\nDeadline (exam or due date): \nWhat I need to study (books, chapters, topics — or attach them): \nWhen I can study (days and hours): \nAnything else (what I find hard, how I like to study): ',
  },
  {
    icon: <CalendarDays size={16} />,
    label: 'Weekly schedule',
    calendar: true,
    text: 'Plan my next week. Here is what I need to get done, with any deadlines:\n- \n\nI am free: ',
  },
  { icon: <ListChecks size={16} />, label: 'Notes to tasks', text: 'Turn the attached notes into a list of tasks with sensible dates, starting today:\n' },
  { icon: <NotebookPen size={16} />, label: 'Summarise', text: 'Summarise the attached material into clear study notes with headings, key points and a short self-test at the end.' },
  { icon: <Sparkles size={16} />, label: 'How do I…', text: 'How do I ' },
];

const renderMarkdown = (md: string) => ({ __html: DOMPurify.sanitize(marked.parse(md, { gfm: true, async: false }) as string) });

const pad = (n: number) => String(n).padStart(2, '0');
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const statusKey = ['ai-status'] as const;
const chatsKey = (ws: string) => ['ai-chats', ws] as const;

export function AiPage() {
  const { workspace, sidebarOpen, toggleSidebar } = useApp();
  const [params, setParams] = useSearchParams();
  const chatId = params.get('chat');
  const status = useQuery({ queryKey: statusKey, queryFn: () => api<AiStatus>('/api/ai/status') });
  const chats = useQuery({
    queryKey: chatsKey(workspace.id),
    queryFn: () => api<{ chats: { id: string; title: string; updatedAt: string }[] }>(`/api/workspaces/${workspace.id}/ai/chats`).then((r) => r.chats),
  });
  const chat = useQuery({
    queryKey: ['ai-chat', chatId],
    queryFn: () => api<{ chat: Chat }>(`/api/ai/chats/${chatId}`).then((r) => r.chat),
    enabled: !!chatId,
  });
  const [settings, setSettings] = useState(false);
  const [listOpen, setListOpen] = useState(() => window.innerWidth >= 900);

  const select = (id: string | null) => {
    setParams(id ? { chat: id } : {});
    if (window.innerWidth < 900) setListOpen(false);
  };

  const removeChat = async (id: string, title: string) => {
    if (!(await confirmDialog({ title: `Delete “${title || 'this conversation'}”?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api(`/api/ai/chats/${id}`, { method: 'DELETE' });
      if (id === chatId) select(null);
      queryClient.invalidateQueries({ queryKey: chatsKey(workspace.id) });
    } catch (err) {
      toastError(err);
    }
  };

  const s = status.data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        {!sidebarOpen && (
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        )}
        <IconButton onClick={() => setListOpen((o) => !o)} title="Conversations">
          <PanelLeft size={17} />
        </IconButton>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles size={19} className="text-muted" /> AI assistant
        </h1>
        <div className="flex-1" />
        {s?.model && (
          <span className="hidden truncate text-xs text-muted sm:block">
            {s.model.model}
            {s.source === 'shared' ? ' · provided by the server' : ''}
          </span>
        )}
        <IconButton onClick={() => select(null)} title="New conversation">
          <MessageSquarePlus size={17} />
        </IconButton>
        <IconButton onClick={() => setSettings(true)} title="AI settings">
          <Settings2 size={17} />
        </IconButton>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {listOpen && (
          <aside className="absolute inset-y-0 start-0 z-10 flex w-64 flex-col border-e border-line bg-sidebar min-[900px]:static">
            <div className="p-2">
              <button onClick={() => select(null)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-hover">
                <MessageSquarePlus size={15} /> New conversation
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
              {(chats.data ?? []).map((c) => (
                <div key={c.id} className={clsx('group flex items-center rounded-md', c.id === chatId ? 'bg-active' : 'hover:bg-hover')}>
                  <button onClick={() => select(c.id)} className="min-w-0 flex-1 truncate px-2 py-1.5 text-start text-sm">
                    {c.title || 'Untitled'}
                  </button>
                  <button
                    onClick={() => removeChat(c.id, c.title)}
                    title="Delete"
                    className="hover-reveal me-1 rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {chats.data?.length === 0 && <p className="px-2 py-3 text-xs text-faint">Your conversations will show here.</p>}
            </div>
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {status.isPending ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : !s?.available ? (
            <Setup status={s} onOpenSettings={() => setSettings(true)} />
          ) : (
            <Conversation key={chatId ?? 'new'} chat={chatId ? (chat.data ?? null) : null} loading={!!chatId && chat.isPending} onCreated={(id) => select(id)} />
          )}
        </main>
      </div>

      {settings && s && <AiSettingsDialog status={s} onClose={() => setSettings(false)} />}
    </div>
  );
}

function Setup({ status, onOpenSettings }: { status: AiStatus | undefined; onOpenSettings: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Sparkles size={24} />
        </div>
        <h2 className="text-xl font-semibold">Connect an AI</h2>
        {status?.canUseOwn !== false ? (
          <>
            <p className="mt-2 text-sm text-muted">
              Use your own API key from Anthropic, OpenAI (or any OpenAI-compatible service, including local models), or Google. Your key is stored
              encrypted on this server and only used for your requests.
            </p>
            <Button variant="primary" className="mt-5" onClick={onOpenSettings}>
              Set up my AI
            </Button>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">The AI assistant isn't available yet. Ask the administrator of this server to set it up.</p>
        )}
      </div>
    </div>
  );
}

// ---------- the conversation ----------

interface Attachment {
  id: string;
  name: string;
  text: string | null;
  status: string;
  error?: string;
}

/**
 * One conversation. `compact` is the small assistant in the corner of a page, which always gives the
 * assistant `pageId` (the page that's open) with the first question.
 */
export function Conversation({
  chat,
  loading,
  onCreated,
  compact,
  pageId,
}: {
  chat: Chat | null;
  loading: boolean;
  onCreated: (id: string) => void;
  compact?: boolean;
  pageId?: string;
}) {
  const { workspace, pages } = useApp();
  const [current, setCurrent] = useState<Chat | null>(chat);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [useCalendar, setUseCalendar] = useState(false);
  // "Search my workspace": on by default in the corner assistant away from a page.
  const [searchWorkspace, setSearchWorkspace] = useState(() => !!compact && !pageId);
  const [sending, setSending] = useState<string | null>(null);
  const [pageMenu, setPageMenu] = useState<Anchor | null>(null);
  const [fileMenu, setFileMenu] = useState<Anchor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setCurrent(chat), [chat]);
  useEffect(() => {
    // (Braces matter: scrollIntoView returns a promise in newer browsers, which an effect mustn't return.)
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [current?.messages.length, sending]);

  const addFile = async (blob: Blob, name: string) => {
    const id = crypto.randomUUID();
    setAttachments((a) => [...a, { id, name, text: null, status: 'Reading…' }]);
    try {
      const text = await extractText(workspace.id, blob, name, (msg) => setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: msg } : x))));
      setAttachments((a) => a.map((x) => (x.id === id ? { ...x, text, status: `${Math.round(text.length / 1000)}k characters` } : x)));
    } catch (err) {
      setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: 'Could not read', error: err instanceof Error ? err.message : String(err) } : x)));
    }
  };

  // An answer on its way: check for it until it's saved (also after leaving and coming back).
  const waiting = !!current?.messages.at(-1)?.pending;
  useEffect(() => {
    if (!waiting || !current) return;
    const id = current.id;
    const timer = setInterval(async () => {
      try {
        const { chat: fresh } = await api<{ chat: Chat }>(`/api/ai/chats/${id}`);
        if (fresh.messages.at(-1)?.pending) return;
        setCurrent(fresh);
        queryClient.setQueryData(['ai-chat', id], fresh);
        queryClient.invalidateQueries({ queryKey: chatsKey(workspace.id) });
      } catch {
        // Offline for a moment: try again on the next tick.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, current?.id, workspace.id]);

  /** Sends a question (or, with `editIndex`, a rewritten earlier one: everything after it is replaced). */
  const ask = async (text: string, editIndex?: number) => {
    if (!text || sending || waiting) return false;
    if (attachments.some((a) => a.text === null && !a.error)) {
      toast('Wait for the attachments to finish reading');
      return false;
    }
    const ready = editIndex === undefined ? attachments.filter((a) => a.text !== null) : [];
    const withPage = pageId && !current ? [pageId, ...pageIds.filter((id) => id !== pageId)] : pageIds;
    setSending(text);
    try {
      const { chat: updated } = await api<{ chat: Chat }>(`/api/workspaces/${workspace.id}/ai/ask`, {
        method: 'POST',
        body: {
          chatId: current?.id ?? null,
          message: text,
          attachments: ready.map((a) => ({ name: a.name, text: a.text })),
          pageIds: withPage,
          useCalendar,
          searchWorkspace,
          today: todayIso(),
          ...(editIndex !== undefined ? { editIndex } : {}),
        },
      });
      setCurrent(updated);
      if (editIndex === undefined) {
        setAttachments([]);
        setPageIds([]);
      }
      queryClient.setQueryData(['ai-chat', updated.id], updated);
      queryClient.invalidateQueries({ queryKey: chatsKey(workspace.id) });
      if (!current) onCreated(updated.id);
      return true;
    } catch (err) {
      toastError(err);
      return false;
    } finally {
      setSending(null);
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = message.trim();
    if (!text) return;
    setMessage('');
    if (!(await ask(text))) setMessage(text);
  };

  const messages = current?.messages ?? [];
  const docPages = pages;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[780px] px-4 py-6 sm:px-6">
          {loading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {!loading && messages.length === 0 && !sending && compact && (
            <div className="py-4 text-sm text-muted">
              Ask about this page — summarise it, find something in it, plan tasks from it — or anything else. The assistant reads the page with your first question.
            </div>
          )}
          {!loading && messages.length === 0 && !sending && !compact && (
            <div className="py-8">
              <h2 className="text-2xl font-bold tracking-tight">What can I help with?</h2>
              <p className="mt-1 text-sm text-muted">
                Ask how to do anything in the app, or have it build something — documents, boards and lists, and calendar tasks — which you review before adding.
              </p>
              <div className="mt-6 grid gap-2 sm:grid-cols-2">
                {STARTERS.map((st) => (
                  <button
                    key={st.label}
                    onClick={() => {
                      setMessage(st.text);
                      if (st.calendar) setUseCalendar(true);
                      setTimeout(() => box.current?.focus());
                    }}
                    className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 text-start text-sm hover:bg-hover"
                  >
                    <span className="text-accent">{st.icon}</span>
                    <span className="font-medium">{st.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              editing?.index === i ? (
                <div key={i} className="mb-5 flex flex-col items-end gap-2">
                  <textarea
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ index: i, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditing(null);
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void ask(editing.text.trim(), i).then((ok) => ok && setEditing(null));
                      }
                    }}
                    rows={Math.min(10, Math.max(2, editing.text.split('\n').length))}
                    className="w-full max-w-[85%] resize-none rounded-2xl border border-accent bg-surface px-4 py-2.5 text-sm outline-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => setEditing(null)} className="rounded-md px-3 py-1 text-sm text-muted hover:bg-hover">
                      Cancel
                    </button>
                    <button
                      disabled={!editing.text.trim() || !!sending}
                      onClick={() => void ask(editing.text.trim(), i).then((ok) => ok && setEditing(null))}
                      className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Send
                    </button>
                  </div>
                  {i < messages.length - 1 && <p className="text-xs text-faint">The answers after this message will be replaced.</p>}
                </div>
              ) : (
              <div key={i} className="group mb-5 flex items-start justify-end gap-1">
                {!waiting && !sending && (
                  <button
                    onClick={() => setEditing({ index: i, text: m.content })}
                    title="Edit this message"
                    className="mt-1.5 rounded-md p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus:opacity-100"
                  >
                    <Pencil size={13} />
                  </button>
                )}
                <div className="max-w-[85%] rounded-2xl rounded-ee-md bg-accent/10 px-4 py-2.5">
                  <div className="text-sm whitespace-pre-wrap">{m.content}</div>
                  {!!m.attachments?.length && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.attachments.map((a) => (
                        <span key={a.name} title={a.truncated ? 'Only the first part was used: it was too long' : undefined} className="flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs text-muted">
                          <FileText size={12} /> {a.name.replace(/ \(id [0-9a-f-]{36}\)$/, '')}
                          {a.truncated ? ' (shortened)' : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              )
            ) : m.pending ? (
              <div key={i} className="mb-6 flex items-center gap-2 text-sm text-muted">
                <Spinner className="size-4" /> Thinking… you can leave this page — the answer is saved here when it's ready.
              </div>
            ) : m.error ? (
              <div key={i} className="mb-6 rounded-lg border border-red-400/50 bg-red-500/5 px-3 py-2 text-sm">
                <p className="text-red-500">No answer: {m.error}</p>
                {messages[i - 1]?.role === 'user' && (
                  <button onClick={() => void ask(messages[i - 1].content, i - 1)} disabled={!!sending} className="mt-1.5 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-hover">
                    Try again
                  </button>
                )}
              </div>
            ) : (
              <div key={i} className="mb-6">
                <div className="ai-markdown text-sm" dangerouslySetInnerHTML={renderMarkdown(m.content)} />
                {m.proposal && (m.proposal.documents.length > 0 || m.proposal.tasks.length > 0 || (m.proposal.databases?.length ?? 0) > 0) && (
                  <ProposalCard chatId={current!.id} index={i} proposal={m.proposal} applied={m.applied} onApplied={(c) => setCurrent(c)} />
                )}
              </div>
            ),
          )}

          {sending && !current && (
            <>
              <div className="mb-5 flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-ee-md bg-accent/10 px-4 py-2.5 text-sm whitespace-pre-wrap">{sending}</div>
              </div>
              <div className="mb-6 flex items-center gap-2 text-sm text-muted">
                <Spinner className="size-4" /> Thinking… plans with lots of material can take a minute.
              </div>
            </>
          )}
          <div ref={bottom} />
        </div>
      </div>

      <form onSubmit={send} className="shrink-0 border-t border-line bg-bg px-3 py-3 sm:px-6">
        <div className="mx-auto max-w-[780px]">
          {(attachments.length > 0 || pageIds.length > 0) && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span key={a.id} title={a.error} className={clsx('flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs', a.error ? 'border-red-400 text-red-500' : 'border-line')}>
                  {a.text === null && !a.error ? <Spinner className="size-3" /> : <FileText size={12} />}
                  <span className="max-w-[180px] truncate">{a.name}</span>
                  <span className="text-faint">{a.error ? a.error : a.status}</span>
                  <button type="button" onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))} className="text-faint hover:text-fg">
                    <X size={12} />
                  </button>
                </span>
              ))}
              {pageIds.map((id) => {
                const p = pages.find((x) => x.id === id);
                return (
                  <span key={id} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs">
                    {p && <PageIcon page={p} size={12} />}
                    <span className="max-w-[180px] truncate">{p ? pageTitle(p) : 'Page'}</span>
                    <button type="button" onClick={() => setPageIds((x) => x.filter((y) => y !== id))} className="text-faint hover:text-fg">
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="rounded-2xl border border-line bg-surface focus-within:border-accent">
            <textarea
              ref={box}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={Math.min(8, Math.max(2, message.split('\n').length))}
              placeholder="Ask the assistant, or describe what to make…"
              className="block w-full resize-none bg-transparent px-4 pt-3 text-sm outline-none"
            />
            <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPTED}
                className="hidden"
                onChange={(e) => {
                  for (const f of Array.from(e.target.files ?? [])) void addFile(f, f.name);
                  e.target.value = '';
                }}
              />
              <ToolButton icon={<Paperclip size={15} />} label="Attach" onClick={() => fileInput.current?.click()} />
              <ToolButton icon={<FolderOpen size={15} />} label="From Files" onClick={(e) => setFileMenu(e.currentTarget.getBoundingClientRect())} />
              <ToolButton icon={<FileText size={15} />} label="Pages" onClick={(e) => setPageMenu(e.currentTarget.getBoundingClientRect())} />
              <button
                type="button"
                onClick={() => setUseCalendar((u) => !u)}
                title="Let the assistant see your calendar for the next 6 months, to plan around it"
                className={clsx('flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs', useCalendar ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-hover hover:text-fg')}
              >
                <CalendarDays size={15} /> {useCalendar ? 'Using my calendar' : 'My calendar'}
              </button>
              <button
                type="button"
                onClick={() => setSearchWorkspace((u) => !u)}
                title="Let the assistant look through your pages, databases and files for the answer"
                className={clsx('flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs', searchWorkspace ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-hover hover:text-fg')}
              >
                <Search size={15} /> {searchWorkspace ? 'Searching my workspace' : 'Search my workspace'}
              </button>
              <div className="flex-1" />
              <button
                type="submit"
                disabled={!message.trim() || !!sending || waiting}
                title="Send (Enter)"
                className="flex size-8 items-center justify-center rounded-full bg-accent text-white disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        </div>
      </form>

      <Popover anchor={pageMenu} onClose={() => setPageMenu(null)}>
        <PagePicker
          pages={docPages.map((p) => ({ id: p.id, title: pageTitle(p), page: p }))}
          selected={pageIds}
          onToggle={(id) => setPageIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]))}
        />
      </Popover>
      <Popover anchor={fileMenu} onClose={() => setFileMenu(null)}>
        <WorkspaceFilePicker
          onPick={async (f) => {
            setFileMenu(null);
            try {
              const res = await fetch(f.url, { credentials: 'same-origin' });
              if (!res.ok) throw new Error('Could not download the file');
              await addFile(await res.blob(), f.name);
            } catch (err) {
              toastError(err);
            }
          }}
        />
      </Popover>
    </>
  );
}

function ToolButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:bg-hover hover:text-fg">
      {icon} {label}
    </button>
  );
}

function PagePicker({ pages, selected, onToggle }: { pages: { id: string; title: string; page: any }[]; selected: string[]; onToggle: (id: string) => void }) {
  const [q, setQ] = useState('');
  const shown = pages.filter((p) => p.title.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <div className="w-72 p-2">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a page" className="mb-1 h-8 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none" />
      <div className="max-h-72 overflow-y-auto">
        {shown.map((p) => (
          <button key={p.id} onClick={() => onToggle(p.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover">
            <span className={clsx('flex size-4 items-center justify-center rounded border', selected.includes(p.id) ? 'border-accent bg-accent text-white' : 'border-faint')}>
              {selected.includes(p.id) && <Check size={11} />}
            </span>
            <PageIcon page={p.page} size={14} />
            <span className="truncate">{p.title}</span>
          </button>
        ))}
        {shown.length === 0 && <p className="px-2 py-3 text-xs text-muted">No pages found.</p>}
      </div>
    </div>
  );
}

function WorkspaceFilePicker({ onPick }: { onPick: (f: { url: string; name: string }) => void }) {
  const { workspace } = useApp();
  const files = useWorkspaceFiles(workspace.id);
  const readable = (files.data ?? []).filter((f) => ['pdf', 'document', 'spreadsheet', 'presentation'].includes(kindOf(f)) || /\.(txt|md|csv)$/i.test(f.name));
  return (
    <div className="w-72 p-2">
      <div className="px-2 pb-1 text-xs text-muted">Files in this workspace</div>
      <div className="max-h-72 overflow-y-auto">
        {files.isPending && <Spinner className="m-3" />}
        {readable.map((f) => (
          <button key={f.id} onClick={() => onPick(f)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover">
            <FileText size={14} className="shrink-0 text-muted" />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
        {!files.isPending && readable.length === 0 && <p className="px-2 py-3 text-xs text-muted">No PDFs or documents here yet.</p>}
      </div>
    </div>
  );
}

// ---------- adding what it made ----------

const LAYOUT_LABELS: Record<string, string> = { board: 'Board', list: 'List', grid: 'Table', calendar: 'Calendar', timeline: 'Timeline', gallery: 'Gallery' };

function describeRepeat(r: NonNullable<ProposedTask['repeat']>) {
  const unit = r.every === 1 ? r.unit : `${r.every} ${r.unit}s`;
  return `every ${unit}${r.until ? ` until ${shortDate(r.until)}` : ''}`;
}

function ProposalCard({ chatId, index, proposal, applied, onApplied }: { chatId: string; index: number; proposal: Proposal; applied?: Message['applied']; onApplied: (chat: Chat) => void }) {
  const { workspace, pages } = useApp();
  const navigate = useNavigate();
  const databases = proposal.databases ?? [];
  const all = (n: number) => new Set(Array.from({ length: n }, (_, i) => i));
  const [docs, setDocs] = useState(() => all(proposal.documents.length));
  const [dbs, setDbs] = useState(() => all(databases.length));
  const [tasks, setTasks] = useState(() => all(proposal.tasks.length));
  const [preview, setPreview] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(proposal.tasks.length <= 12);
  const [color, setColor] = useState<EventColor>('purple');
  const [reminder, setReminder] = useState<number | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const titleOf = (id: string | null) => {
    if (!id) return null;
    const page = pages.find((p) => p.id === id);
    if (page) return pageTitle(page);
    return proposal.documents.find((d) => d.ref === id)?.title ?? databases.find((d) => d.ref === id)?.title ?? null;
  };

  const byDate = useMemo(() => {
    const groups = new Map<string, { task: ProposedTask; i: number }[]>();
    proposal.tasks.forEach((task, i) => groups.set(task.date, [...(groups.get(task.date) ?? []), { task, i }]));
    return [...groups.entries()];
  }, [proposal.tasks]);

  const toggle = (set: Set<number>, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  };

  const apply = async () => {
    const made: Built = { pages: [], tasks: 0 };
    try {
      await buildProposal(
        workspace.id,
        proposal,
        { documents: docs, databases: dbs, tasks },
        pages.map((p) => ({ id: p.id, type: p.type, title: pageTitle(p) })),
        { color, reminder },
        setProgress,
        made,
      );
    } catch (err) {
      toastError(err);
    } finally {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ['pages', workspace.id] });
      queryClient.invalidateQueries({ queryKey: ['tasks', workspace.id] });
      queryClient.invalidateQueries({ queryKey: ['calendar', workspace.id] });
      queryClient.invalidateQueries({ queryKey: notificationsKey });
    }
    if (!made.pages.length && !made.tasks) return;
    try {
      const { chat } = await api<{ chat: Chat }>(`/api/ai/chats/${chatId}/applied`, { method: 'POST', body: { index, pages: made.pages, tasks: made.tasks } });
      onApplied(chat);
    } catch {}
    const parts = [made.pages.length && `${made.pages.length} page${made.pages.length > 1 ? 's' : ''}`, made.tasks && `${made.tasks} task${made.tasks > 1 ? 's' : ''}`].filter(Boolean);
    toast(`Added ${parts.join(' and ')}`);
  };

  const count = docs.size + dbs.size + tasks.size;
  const label = [
    docs.size && `${docs.size} doc${docs.size > 1 ? 's' : ''}`,
    dbs.size && `${dbs.size} database${dbs.size > 1 ? 's' : ''}`,
    tasks.size && `${tasks.size} task${tasks.size > 1 ? 's' : ''}`,
  ]
    .filter(Boolean)
    .join(' + ');

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-line">
      {proposal.documents.length > 0 && (
        <div className="border-b border-line p-3">
          <div className="mb-1 text-xs font-semibold tracking-wide text-faint uppercase">Documents</div>
          {proposal.documents.map((d, i) => {
            const where = d.appendTo ? `added to the end of “${titleOf(d.appendTo) ?? 'a page'}”` : d.parent ? `inside “${titleOf(d.parent) ?? 'a page'}”` : null;
            return (
              <div key={i}>
                <div className="flex items-center gap-2 py-1">
                  <Box checked={docs.has(i)} onClick={() => setDocs((s) => toggle(s, i))} />
                  <span>{d.appendTo ? '➕' : d.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium">{d.appendTo ? 'New text' : d.title}</span>
                    {where && <span className="text-muted"> · {where}</span>}
                  </span>
                  <button onClick={() => setPreview(preview === `d${i}` ? null : `d${i}`)} className="text-xs text-accent hover:underline">
                    {preview === `d${i}` ? 'Hide' : 'Preview'}
                  </button>
                </div>
                {preview === `d${i}` && (
                  <div
                    className="ai-markdown my-2 max-h-80 overflow-y-auto rounded-lg bg-hover/50 p-3 text-sm"
                    dangerouslySetInnerHTML={renderMarkdown(d.markdown.replace(/@(\d{4}-\d{2}-\d{2})/g, '📅 $1').replace(/^\{\{\s*(database|page)\s*:\s*([^}]+?)\s*\}\}$/gm, (_, kind, ref) => `*(${kind === 'database' ? 'database' : 'sub-page'}: ${titleOf(ref) ?? ref})*`).replace(/^\{\{\s*tasks\s*\}\}$/gm, '*(linked tasks)*'))}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {databases.length > 0 && (
        <div className="border-b border-line p-3">
          <div className="mb-1 text-xs font-semibold tracking-wide text-faint uppercase">Databases</div>
          {databases.map((db, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 py-1">
                <Box checked={dbs.has(i)} onClick={() => setDbs((s) => toggle(s, i))} />
                <span>{db.icon}</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{db.title}</span>
                  <span className="text-muted">
                    {' '}
                    · {LAYOUT_LABELS[db.layout] ?? db.layout}, {db.rows.length} card{db.rows.length === 1 ? '' : 's'}
                    {db.parent ? ` · inside “${titleOf(db.parent) ?? 'a page'}”` : ''}
                  </span>
                </span>
                <button onClick={() => setPreview(preview === `b${i}` ? null : `b${i}`)} className="text-xs text-accent hover:underline">
                  {preview === `b${i}` ? 'Hide' : 'Preview'}
                </button>
              </div>
              {preview === `b${i}` && (
                <div className="my-2 max-h-80 overflow-auto rounded-lg border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-hover/50 text-start text-muted">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Name</th>
                        {db.fields.map((f) => (
                          <th key={f.name} className="px-2 py-1.5 font-medium whitespace-nowrap">
                            {f.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {db.rows.map((r, k) => (
                        <tr key={k} className="border-t border-line align-top">
                          <td className="px-2 py-1.5">{r.name}</td>
                          {db.fields.map((f) => {
                            const v = Object.entries(r.cells).find(([key]) => key.toLowerCase() === f.name.toLowerCase())?.[1];
                            return (
                              <td key={f.name} className="px-2 py-1.5 whitespace-nowrap text-muted">
                                {v === true ? '✓' : v === false || v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {proposal.tasks.length > 0 && (
        <div className="border-b border-line p-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowTasks((v) => !v)} className="flex flex-1 items-center gap-1 text-start text-xs font-semibold tracking-wide text-faint uppercase">
              {showTasks ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {proposal.tasks.length} on the calendar · {shortDate(proposal.tasks[0].date)} –{' '}
              {shortDate(proposal.tasks[proposal.tasks.length - 1].date)}
            </button>
            <button onClick={() => setTasks(tasks.size === proposal.tasks.length ? new Set() : all(proposal.tasks.length))} className="text-xs text-accent hover:underline">
              {tasks.size === proposal.tasks.length ? 'Select none' : 'Select all'}
            </button>
          </div>
          {showTasks && (
            <div className="mt-2 max-h-96 overflow-y-auto">
              {byDate.map(([day, items]) => (
                <div key={day} className="mb-2">
                  <div className="text-xs font-medium text-muted">{longDate(day)}</div>
                  {items.map(({ task, i }) => (
                    <label key={i} className="flex cursor-pointer items-start gap-2 py-1">
                      <Box checked={tasks.has(i)} onClick={() => setTasks((s) => toggle(s, i))} />
                      <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: COLOR_HEX[(task.color as EventColor) ?? color] }} />
                      <span className="min-w-0 flex-1 text-sm">
                        {task.title}
                        {!task.task && <span className="ms-1.5 rounded bg-hover px-1 text-[10px] text-muted">event</span>}
                        <span className="block text-xs text-muted">
                          {[
                            task.time,
                            task.minutes && `${task.minutes} min`,
                            task.endDate && `until ${shortDate(task.endDate)}`,
                            task.repeat && describeRepeat(task.repeat),
                            task.reminder !== null && task.reminder !== undefined && `reminder ${REMINDERS.find((r) => r.value === task.reminder)?.label.toLowerCase() ?? `${task.reminder} min before`}`,
                            task.document && `in “${titleOf(task.document) ?? 'the plan'}”`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                          {task.notes ? ` — ${task.notes}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1">
              Colour
              {EVENT_COLORS.slice(0, 7).map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={c}
                  className={clsx('size-4 rounded-full', color === c && 'ring-2 ring-fg ring-offset-1 ring-offset-surface')}
                  style={{ background: COLOR_HEX[c] }}
                />
              ))}
            </span>
            <label className="flex items-center gap-1">
              Reminder
              <select
                value={reminder === null ? '' : String(reminder)}
                onChange={(e) => setReminder(e.target.value === '' ? null : Number(e.target.value))}
                className="h-7 rounded-md border border-line bg-surface px-1"
              >
                {REMINDERS.map((r) => (
                  <option key={r.label} value={r.value === null ? '' : String(r.value)}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-faint">(for tasks that don't set their own)</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 bg-hover/40 px-3 py-2">
        {applied && (applied.pages.length > 0 || applied.tasks > 0) ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="flex items-center gap-1 text-green-600">
              <Check size={13} /> Added
            </span>
            {applied.pages.map((p, k) => (
              <button key={`${p.id}-${k}`} onClick={() => navigate(`/w/${workspace.id}/p/${p.id}`)} className="truncate text-accent hover:underline">
                {p.title}
              </button>
            ))}
            {applied.tasks > 0 && (
              <button onClick={() => navigate(`/w/${workspace.id}/today`)} className="text-accent hover:underline">
                {applied.tasks} tasks
              </button>
            )}
          </div>
        ) : (
          <div className="flex-1 text-xs text-muted">{progress ?? 'Choose what to add — tasks and dated cards go on the calendar and your Today list.'}</div>
        )}
        <Button size="sm" variant="primary" disabled={count === 0 || !!progress} onClick={apply}>
          {progress ? 'Adding…' : applied ? 'Add again' : `Add ${label}`}
        </Button>
      </div>
    </div>
  );
}

function Box({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={clsx('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border', checked ? 'border-accent bg-accent text-white' : 'border-faint')}
    >
      {checked && <Check size={11} />}
    </button>
  );
}

const shortDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// ---------- settings ----------

function AiSettingsDialog({ status, onClose }: { status: AiStatus; onClose: () => void }) {
  const own = status.own;
  const [provider, setProvider] = useState<Provider>(own?.provider ?? 'anthropic');
  const [model, setModel] = useState(own?.model ?? status.defaults[own?.provider ?? 'anthropic']);
  const [baseUrl, setBaseUrl] = useState(own?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [useOwn, setUseOwn] = useState(own?.useOwn ?? true);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'models' | 'remove' | null>(null);
  const sameProvider = own?.provider === provider;

  const changeProvider = (p: Provider) => {
    setProvider(p);
    setModels([]);
    if (!own || own.provider !== p) {
      setModel(status.defaults[p]);
      setBaseUrl('');
    } else {
      setModel(own.model);
      setBaseUrl(own.baseUrl ?? '');
    }
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: statusKey });
  };

  const loadModels = async () => {
    setBusy('models');
    try {
      const r = await api<{ models: string[] }>('/api/ai/models', { method: 'POST', body: { provider, baseUrl: baseUrl || null, key: key || undefined } });
      setModels(r.models);
      if (!r.models.length) toast('No models were listed');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    try {
      await api('/api/ai/connection', {
        method: 'PUT',
        body: { provider, model, baseUrl: provider === 'anthropic' ? null : baseUrl || null, key: key ? key : sameProvider ? undefined : '', useOwn },
      });
      toast('AI settings saved');
      refresh();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await api('/api/ai/connection', { method: 'DELETE' });
      toast('Your AI connection was removed');
      refresh();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const field = 'h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-accent';

  return (
    <Dialog open onClose={onClose} width={520}>
      <div className="p-5">
        <h2 className="text-lg font-semibold">AI settings</h2>
        {status.shared && (
          <div className="mt-3 rounded-lg bg-hover/60 px-3 py-2 text-sm">
            This server provides <b>{status.shared.model}</b> for everyone.
            {!status.canUseOwn && ' The administrator has turned off using your own key.'}
          </div>
        )}

        {status.canUseOwn ? (
          <form onSubmit={save} className="mt-4 space-y-3">
            {status.shared && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={useOwn} onChange={(e) => setUseOwn(e.target.checked)} />
                Use my own key instead of the server's
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Provider</span>
              <select value={provider} onChange={(e) => changeProvider(e.target.value as Provider)} className={field}>
                {(Object.keys(PROVIDER_NAMES) as Provider[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_NAMES[p]}
                  </option>
                ))}
              </select>
            </label>
            {provider === 'openai' && (
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Address (leave empty for OpenAI itself)</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className={field} />
                <span className="mt-1.5 flex flex-wrap gap-1">
                  {COMPATIBLE.map((c) => (
                    <button key={c.label} type="button" onClick={() => setBaseUrl(c.url)} className={clsx('rounded-md border px-1.5 py-0.5 text-[11px]', baseUrl === c.url ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg')}>
                      {c.label}
                    </button>
                  ))}
                </span>
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-xs text-muted">API key{provider === 'openai' ? ' (not needed for local models)' : ''}</span>
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={sameProvider && own?.keyHint ? `Saved: ${own.keyHint} — type to replace` : 'Paste your key'}
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1 flex items-center text-xs text-muted">
                <span className="flex-1">Model</span>
                <button type="button" onClick={loadModels} disabled={busy === 'models'} className="text-accent hover:underline disabled:opacity-50">
                  {busy === 'models' ? 'Loading…' : 'List available models'}
                </button>
              </span>
              <input list="ai-models" value={model} onChange={(e) => setModel(e.target.value)} className={field} />
              <datalist id="ai-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <p className="text-xs text-muted">Your key is stored encrypted on this server and used only for your own requests. It's never shown again.</p>
            <div className="flex items-center gap-2 pt-2">
              {own && (
                <Button type="button" variant="ghost" onClick={remove} disabled={!!busy}>
                  Remove
                </Button>
              )}
              <div className="flex-1" />
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!!busy || !model.trim()}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={onClose}>Close</Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
