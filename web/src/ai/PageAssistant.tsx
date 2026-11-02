import { useQuery } from '@tanstack/react-query';
import { ExternalLink, MessageSquarePlus, Sparkles, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../app/context';
import { Spinner } from '../components/ui';
import { useAiAvailable } from '../editor/AiSelection';
import { api } from '../lib/api';
import { getLocal, setLocal } from '../lib/storage';
import type { Chat } from './AiPage';

const Conversation = lazy(() => import('./AiPage').then((m) => ({ default: m.Conversation })));

const chatKey = (workspaceId: string, pageId?: string) => (pageId ? `af-page-ai:${pageId}` : `af-ai-general:${workspaceId}`);

/**
 * A small assistant in the corner of every screen, only when an AI connection is set up (the person's
 * own or the server's). On a page its conversation is kept per page and it reads the page with the
 * first question; elsewhere there's one per workspace. The answer keeps coming if it's closed.
 */
export function PageAssistant({ pageId }: { pageId?: string }) {
  const available = useAiAvailable();
  const [open, setOpen] = useState(false);
  if (!available) return null;
  return open ? (
    <Panel pageId={pageId} onClose={() => setOpen(false)} />
  ) : (
    <button
      onClick={() => setOpen(true)}
      title={pageId ? 'Ask AI about this page' : 'Ask AI'}
      className="ai-fab fixed end-4 bottom-4 z-20 flex size-11 items-center justify-center rounded-full bg-accent text-white shadow-lg transition hover:scale-105 print:hidden"
    >
      <Sparkles size={19} />
    </button>
  );
}

function Panel({ pageId, onClose }: { pageId?: string; onClose: () => void }) {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [chatId, setChatId] = useState<string | null>(() => getLocal<string | null>(chatKey(workspace.id, pageId), null));
  const chat = useQuery({
    queryKey: ['ai-chat', chatId],
    queryFn: () => api<{ chat: Chat }>(`/api/ai/chats/${chatId}`).then((r) => r.chat),
    enabled: !!chatId,
    retry: false,
  });
  const pick = (id: string | null) => {
    setChatId(id);
    setLocal(chatKey(workspace.id, pageId), id);
  };
  // The conversation was deleted on the AI page: start a new one.
  if (chatId && chat.isError) pick(null);

  return (
    <div className="fixed end-3 bottom-3 z-30 flex h-[min(560px,calc(100dvh-90px))] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl print:hidden">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
        <Sparkles size={15} className="text-accent" />
        <span className="flex-1 truncate text-sm font-semibold">{chat.data?.title || (pageId ? 'Ask AI about this page' : 'Ask AI')}</span>
        <button onClick={() => pick(null)} title="New conversation" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg">
          <MessageSquarePlus size={15} />
        </button>
        {chatId && (
          <button onClick={() => navigate(`/w/${workspace.id}/ai?chat=${chatId}`)} title="Open in the AI page" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg">
            <ExternalLink size={15} />
          </button>
        )}
        <button onClick={onClose} title="Close (the answer still arrives)" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg">
          <X size={15} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <Conversation
            key={chatId ?? 'new'}
            chat={chatId ? (chat.data ?? null) : null}
            loading={!!chatId && chat.isPending}
            onCreated={(id) => pick(id)}
            compact
            pageId={pageId}
          />
        </Suspense>
      </div>
    </div>
  );
}
