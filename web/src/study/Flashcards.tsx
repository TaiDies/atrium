import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Layers, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Button, confirmDialog, Dialog, Spinner, toast, toastError } from '../components/ui';
import { useAiAvailable } from '../editor/AiSelection';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';

// Flashcards kept with a page (shared by everyone who can see it), studied with spaced repetition on
// each person's own schedule, and quizzes the AI makes from the page.

export interface Flashcard {
  id: string;
  pageId: string;
  front: string;
  back: string;
  due?: string | null;
  pageTitle?: string;
  pageIcon?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const deckKey = (pageId: string) => ['flashcards', pageId];
export const dueKey = (workspaceId: string) => ['flashcards-due', workspaceId];

const GRADES = [
  { grade: 0, label: 'Again', hint: 'Forgot', className: 'bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25' },
  { grade: 1, label: 'Hard', hint: 'Barely', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/25' },
  { grade: 2, label: 'Good', hint: 'Got it', className: 'bg-green-500/15 text-green-700 dark:text-green-400 hover:bg-green-500/25' },
  { grade: 3, label: 'Easy', hint: 'Too easy', className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 hover:bg-sky-500/25' },
];

/** Going through cards: show the question, reveal the answer, say how well it was remembered. */
export function StudySession({ cards, onFinished, workspaceId }: { cards: Flashcard[]; onFinished?: () => void; workspaceId: string }) {
  const [queue, setQueue] = useState(cards);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  const [saving, setSaving] = useState(false);
  const total = cards.length;
  const card = queue[0];

  useEffect(() => {
    if (!card) onFinished?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);

  // Keys: space shows the answer, 1–4 grade it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (e.key === ' ' && !shown) {
        e.preventDefault();
        setShown(true);
      } else if (shown && ['1', '2', '3', '4'].includes(e.key)) void grade(Number(e.key) - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const grade = async (g: number) => {
    if (!card || saving) return;
    setSaving(true);
    try {
      await api(`/api/flashcards/${card.id}/review`, { method: 'POST', body: { grade: g, today: todayIso() } });
      setShown(false);
      // Forgotten ones come back at the end of this session.
      setQueue((q) => (g === 0 ? [...q.slice(1), q[0]] : q.slice(1)));
      if (g > 0) setDone((d) => d + 1);
      queryClient.invalidateQueries({ queryKey: ['flashcards'] });
      queryClient.invalidateQueries({ queryKey: dueKey(workspaceId) });
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  if (!card) {
    return (
      <div className="py-10 text-center">
        <div className="text-3xl">🎉</div>
        <p className="mt-2 font-medium">All done for now</p>
        <p className="mt-1 text-sm text-muted">
          {total ? `You went through ${total} card${total === 1 ? '' : 's'}. They'll come back when they're due.` : 'No cards are due.'}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
        </div>
        {done} / {total}
      </div>
      {card.pageTitle && (
        <div className="text-xs text-faint">
          {card.pageIcon} {card.pageTitle || 'Untitled'}
        </div>
      )}
      <div className="min-h-[120px] rounded-xl border border-line bg-surface px-5 py-6 text-center text-lg font-medium whitespace-pre-wrap">{card.front}</div>
      {shown ? (
        <>
          <div className="min-h-[80px] rounded-xl border border-dashed border-line px-5 py-4 text-center whitespace-pre-wrap">{card.back || <span className="text-faint">(no answer written)</span>}</div>
          <div className="grid grid-cols-4 gap-2">
            {GRADES.map((g) => (
              <button key={g.grade} disabled={saving} onClick={() => void grade(g.grade)} className={clsx('rounded-lg px-2 py-2 text-sm font-medium disabled:opacity-50', g.className)}>
                {g.label}
                <span className="block text-[11px] font-normal opacity-70">
                  {g.hint} · {g.grade + 1}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <Button variant="primary" onClick={() => setShown(true)}>
          Show answer <span className="text-xs opacity-70">(space)</span>
        </Button>
      )}
    </div>
  );
}

interface QuizQuestion {
  question: string;
  choices: string[];
  answer: number;
  explanation: string;
}

/** A multiple-choice quiz the AI makes from the page. */
function QuizPanel({ pageId }: { pageId: string }) {
  const ai = useAiAvailable();
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);

  const make = async () => {
    setBusy(true);
    try {
      const { questions } = await api<{ questions: QuizQuestion[] }>(`/api/pages/${pageId}/quiz`, { method: 'POST', body: { count: 8 } });
      setQuestions(questions);
      setPicked({});
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!ai) return <p className="py-6 text-center text-sm text-muted">Quizzes are made by the AI: set up an AI connection first (AI → Settings).</p>;
  if (!questions)
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-muted">The AI reads this page and makes a multiple-choice quiz from it.</p>
        <Button className="mt-4" variant="primary" onClick={make} loading={busy}>
          <Sparkles size={14} /> Quiz me
        </Button>
      </div>
    );
  const answered = Object.keys(picked).length;
  const right = questions.filter((q, i) => picked[i] === q.answer).length;
  return (
    <div className="space-y-4">
      {questions.map((q, i) => (
        <div key={i} className="rounded-xl border border-line p-3">
          <div className="text-sm font-medium">
            {i + 1}. {q.question}
          </div>
          <div className="mt-2 grid gap-1.5">
            {q.choices.map((c, j) => {
              const chosen = picked[i] === j;
              const revealed = picked[i] !== undefined;
              return (
                <button
                  key={j}
                  disabled={revealed}
                  onClick={() => setPicked((p) => ({ ...p, [i]: j }))}
                  className={clsx(
                    'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-start text-sm',
                    !revealed && 'border-line hover:bg-hover',
                    revealed && j === q.answer && 'border-green-500 bg-green-500/10',
                    revealed && chosen && j !== q.answer && 'border-red-500 bg-red-500/10',
                    revealed && !chosen && j !== q.answer && 'border-line opacity-60',
                  )}
                >
                  {revealed && j === q.answer ? <Check size={14} className="text-green-600" /> : revealed && chosen ? <X size={14} className="text-red-500" /> : <span className="w-3.5" />}
                  {c}
                </button>
              );
            })}
          </div>
          {picked[i] !== undefined && q.explanation && <p className="mt-2 text-xs text-muted">{q.explanation}</p>}
        </div>
      ))}
      <div className="flex items-center justify-between rounded-xl bg-accent/5 px-4 py-3 text-sm">
        <span>{answered === questions.length ? `You got ${right} of ${questions.length} right.` : `${answered} of ${questions.length} answered`}</span>
        <Button onClick={make} loading={busy}>
          <RotateCcw size={14} /> New quiz
        </Button>
      </div>
    </div>
  );
}

/** The cards of a page: edit them, add them, or have the AI suggest some. */
function CardsPanel({ pageId, cards, canEdit }: { pageId: string; cards: Flashcard[]; canEdit: boolean }) {
  const ai = useAiAvailable();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [suggested, setSuggested] = useState<{ front: string; back: string; keep: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: deckKey(pageId) });

  const add = async (list: { front: string; back: string }[]) => {
    await api(`/api/pages/${pageId}/flashcards`, { method: 'POST', body: { cards: list } });
    await refresh();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!front.trim()) return;
    try {
      await add([{ front: front.trim(), back: back.trim() }]);
      setFront('');
      setBack('');
    } catch (err) {
      toastError(err);
    }
  };
  const suggest = async () => {
    setBusy(true);
    try {
      const { cards } = await api<{ cards: { front: string; back: string }[] }>(`/api/pages/${pageId}/flashcards/generate`, { method: 'POST', body: { count: 12 } });
      setSuggested(cards.map((c) => ({ ...c, keep: true })));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const save = async (card: Flashcard, patch: { front?: string; back?: string }) => {
    if ((patch.front ?? card.front) === card.front && (patch.back ?? card.back) === card.back) return;
    try {
      await api(`/api/flashcards/${card.id}`, { method: 'PATCH', body: patch });
      refresh();
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (card: Flashcard) => {
    if (!(await confirmDialog({ title: 'Delete this card?', confirmLabel: 'Delete', danger: true }))) return;
    await api(`/api/flashcards/${card.id}`, { method: 'DELETE' }).catch(toastError);
    refresh();
  };

  if (suggested) {
    const keep = suggested.filter((s) => s.keep);
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">Untick any you don't want, then add them.</p>
        {suggested.map((s, i) => (
          <label key={i} className="flex cursor-pointer gap-2 rounded-lg border border-line p-2 text-sm">
            <input type="checkbox" checked={s.keep} onChange={(e) => setSuggested((l) => l!.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} className="mt-0.5" />
            <span>
              <span className="block font-medium">{s.front}</span>
              <span className="block text-muted">{s.back}</span>
            </span>
          </label>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => setSuggested(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!keep.length}
            onClick={async () => {
              try {
                await add(keep.map(({ front, back }) => ({ front, back })));
                toast(`Added ${keep.length} card${keep.length === 1 ? '' : 's'}`);
                setSuggested(null);
              } catch (err) {
                toastError(err);
              }
            }}
          >
            Add {keep.length} card{keep.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {canEdit && (
        <form onSubmit={submit} className="space-y-1.5 rounded-xl border border-line p-2.5">
          <input value={front} onChange={(e) => setFront(e.target.value)} placeholder="Question" className="h-8 w-full rounded-md bg-surface px-2 text-sm outline-none" />
          <textarea value={back} onChange={(e) => setBack(e.target.value)} placeholder="Answer" rows={2} className="w-full resize-none rounded-md bg-surface px-2 py-1 text-sm outline-none" />
          <div className="flex gap-2">
            <Button type="submit" disabled={!front.trim()}>
              <Plus size={14} /> Add card
            </Button>
            {ai && (
              <Button type="button" onClick={suggest} loading={busy}>
                <Sparkles size={14} /> Make cards from this page
              </Button>
            )}
          </div>
        </form>
      )}
      {cards.length === 0 && <p className="py-4 text-center text-sm text-muted">No cards yet.</p>}
      {cards.map((c) => (
        <div key={c.id} className="group flex gap-2 rounded-lg border border-line p-2">
          <div className="min-w-0 flex-1 space-y-1">
            <input
              defaultValue={c.front}
              readOnly={!canEdit}
              onBlur={(e) => void save(c, { front: e.target.value.trim() || c.front })}
              className="w-full bg-transparent text-sm font-medium outline-none"
            />
            <textarea
              defaultValue={c.back}
              readOnly={!canEdit}
              rows={Math.max(1, Math.min(4, c.back.split('\n').length))}
              onBlur={(e) => void save(c, { back: e.target.value })}
              className="w-full resize-none bg-transparent text-sm text-muted outline-none"
            />
            <div className="text-[11px] text-faint">{c.due ? (c.due <= todayIso() ? 'Due now' : `Next review ${c.due}`) : 'New'}</div>
          </div>
          {canEdit && (
            <button onClick={() => void remove(c)} className="self-start rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-red-500" title="Delete card">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** "Flashcards & quiz" for a page. */
export function FlashcardsDialog({ pageId, pageTitle, workspaceId, onClose }: { pageId: string; pageTitle: string; workspaceId: string; onClose: () => void }) {
  const deck = useQuery({ queryKey: deckKey(pageId), queryFn: () => api<{ cards: Flashcard[]; canEdit: boolean }>(`/api/pages/${pageId}/flashcards`) });
  const cards = deck.data?.cards ?? [];
  const due = useMemo(() => cards.filter((c) => !c.due || c.due <= todayIso()), [cards]);
  const [tab, setTab] = useState<'study' | 'cards' | 'quiz'>('study');
  const [session, setSession] = useState<Flashcard[] | null>(null);

  useEffect(() => {
    if (deck.data && !deck.data.cards.length) setTab('cards');
  }, [deck.data]);

  return (
    <Dialog open onClose={onClose} title={`Flashcards · ${pageTitle || 'Untitled'}`} width={560} maxHeight="86vh" top="6vh">
      <div className="flex min-h-0 flex-col px-5 pb-5">
        <div className="mb-3 flex gap-1 rounded-lg bg-hover p-1 text-sm">
          {(
            [
              ['study', `Study${due.length ? ` (${due.length})` : ''}`],
              ['cards', `Cards (${cards.length})`],
              ['quiz', 'Quiz'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => {
                setTab(k);
                setSession(null);
              }}
              className={clsx('flex-1 rounded-md py-1', tab === k ? 'bg-bg font-medium shadow-sm' : 'text-muted hover:text-fg')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-y-auto">
          {deck.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : tab === 'cards' ? (
            <CardsPanel pageId={pageId} cards={cards} canEdit={!!deck.data?.canEdit} />
          ) : tab === 'quiz' ? (
            <QuizPanel pageId={pageId} />
          ) : session ? (
            <StudySession cards={session} workspaceId={workspaceId} />
          ) : (
            <div className="py-8 text-center">
              <Layers size={28} className="mx-auto text-accent" />
              <p className="mt-2 font-medium">{due.length ? `${due.length} card${due.length === 1 ? '' : 's'} to review` : cards.length ? 'Nothing due right now' : 'No cards yet'}</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                Cards you remember come back after longer and longer gaps; ones you forget come back sooner.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                {due.length > 0 && (
                  <Button variant="primary" onClick={() => setSession(due)}>
                    Start
                  </Button>
                )}
                {cards.length > 0 && (
                  <Button onClick={() => setSession(cards)}>
                    <RotateCcw size={14} /> Study all {cards.length}
                  </Button>
                )}
                {!cards.length && <Button onClick={() => setTab('cards')}>Add cards</Button>}
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Every card due in the workspace, from Today. */
export function ReviewDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const due = useQuery({ queryKey: [...dueKey(workspaceId), 'session'], queryFn: () => api<{ cards: Flashcard[] }>(`/api/workspaces/${workspaceId}/flashcards/due?today=${todayIso()}`), staleTime: Infinity });
  return (
    <Dialog open onClose={onClose} title="Review flashcards" width={560} maxHeight="86vh" top="6vh">
      <div className="px-5 pb-5">{due.data ? <StudySession cards={due.data.cards} workspaceId={workspaceId} /> : <Spinner />}</div>
    </Dialog>
  );
}

/** How many cards are due (for Today's reminder). */
export function useDueCount(workspaceId: string) {
  const q = useQuery({
    queryKey: dueKey(workspaceId),
    queryFn: () => api<{ total: number }>(`/api/workspaces/${workspaceId}/flashcards/due?today=${todayIso()}`),
    refetchInterval: 5 * 60_000,
  });
  return q.data?.total ?? 0;
}
