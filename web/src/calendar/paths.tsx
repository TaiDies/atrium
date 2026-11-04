import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Check, ChevronRight, GitFork, Minus, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Dialog, Input, Spinner, toastError } from '../components/ui';
import { newId } from '../database/model';
import { api } from '../lib/api';
import { locationPath } from '../lib/placement';
import { queryClient, usePages } from '../lib/queries';
import type { CardField } from './api';

// Tasks with paths: the task asks a question, each answer can ask another, and the last answer leads
// to steps (typed in, or the cards of a database) worked through in order. Every day you pick a path
// and get its next unfinished step; ticking the task off finishes that step. See server/src/paths.ts.

export interface PathSource {
  pageId: string;
  filters: { fieldId: string; values: string[] }[];
  sortField: string | null;
  dateField: string | null;
}

export interface PathOption {
  id: string;
  label: string;
  question?: string;
  options?: PathOption[];
  steps?: { id: string; title: string }[];
  source?: PathSource | null;
}

export interface Paths {
  question: string;
  options: PathOption[];
}

export type PathStep = { kind: 'step'; id: string; title: string } | { kind: 'card'; pageId: string; rowId: string; title: string };

export interface PathChoice {
  date: string;
  trail: string[];
  labels: string[];
  step: PathStep | null;
  applied?: unknown;
}

export interface PathState {
  done: string[];
  today: PathChoice | null;
  more?: { date: string; items: unknown[] } | null;
}

/** Opening the picker to choose today's path, or to finish more steps (getting ahead, catching up). */
export type PathMode = 'choose' | 'more';

interface Progress {
  total: number;
  left: number;
  next: PathStep | null;
  hidden?: boolean;
}

interface PathsView {
  paths: Paths | null;
  choice: PathChoice | null;
  more: { labels: string[]; step: PathStep }[];
  progress: Record<string, Progress>;
}

const DATABASES = ['grid', 'board', 'calendar', 'timeline', 'chart', 'form', 'list', 'gallery', 'feed'];
const isLeaf = (o: PathOption) => !o.options?.length;

/** Today's choice of a task, if it was made for the task's current date. */
export const choiceOf = (e: { startDate: string; pathState?: PathState | null }) => (e.pathState?.today?.date === e.startDate ? e.pathState.today : null);

/** How many more steps were finished on the task's current date. */
export const moreOf = (e: { startDate: string; pathState?: PathState | null }) => (e.pathState?.more?.date === e.startDate ? e.pathState.more.items.length : 0);

// ---------- choosing ----------

/**
 * Asks the task's questions one by one, showing how far along each path is, and picks today's step.
 * In "more" mode the last answer instead finishes a number of its next steps right away.
 */
export function ChoosePathDialog({
  eventId,
  title,
  mode: initialMode = 'choose',
  onClose,
  onChosen,
}: {
  eventId: string;
  title: string;
  mode?: PathMode;
  onClose: () => void;
  onChosen?: () => void;
}) {
  const view = useQuery({
    queryKey: ['event-paths', eventId],
    queryFn: () => api<PathsView>(`/api/events/${eventId}/paths`),
    staleTime: 0,
  });
  const [mode, setMode] = useState<PathMode>(initialMode);
  const [trail, setTrail] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<PathOption | null>(null);
  const [count, setCount] = useState(1);
  const paths = view.data?.paths;
  const choice = view.data?.choice;

  /** Steps that can be finished now on a path (today's chosen step is kept for the task itself). */
  const available = (o: PathOption) => {
    const left = view.data?.progress[o.id]?.left ?? 0;
    const keeps = choice?.step && !choice.applied && choice.trail.at(-1) === o.id ? 1 : 0;
    return Math.max(0, left - keeps);
  };

  const finishMore = async () => {
    if (!picked) return;
    setBusy(picked.id);
    try {
      const v = await api<PathsView>(`/api/events/${eventId}/paths/more`, { method: 'POST', body: { trail: [...trail, picked.id], count } });
      queryClient.setQueryData(['event-paths', eventId], v);
      refreshPaths(eventId);
      onChosen?.();
      setPicked(null);
      setTrail([]);
      setCount(1);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const undoMore = async (index: number) => {
    try {
      const v = await api<PathsView>(`/api/events/${eventId}/paths/more/undo`, { method: 'POST', body: { index } });
      queryClient.setQueryData(['event-paths', eventId], v);
      refreshPaths(eventId);
      onChosen?.();
    } catch (err) {
      toastError(err);
    }
  };

  let options = paths?.options ?? [];
  let question = paths?.question ?? '';
  const answers: PathOption[] = [];
  for (const id of trail) {
    const o = options.find((x) => x.id === id);
    if (!o) break;
    answers.push(o);
    question = o.question ?? '';
    options = o.options ?? [];
  }

  const choose = async (o: PathOption) => {
    if (!isLeaf(o)) return setTrail([...trail, o.id]);
    if (mode === 'more') {
      setPicked(o);
      setCount(1);
      return;
    }
    setBusy(o.id);
    try {
      await api(`/api/events/${eventId}/paths/choose`, {
        method: 'POST',
        body: { trail: [...trail, o.id] },
      });
      refreshPaths(eventId);
      onChosen?.();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  /** Steps left under an answer (all its paths together). */
  const leftUnder = (o: PathOption): number | null => {
    if (isLeaf(o)) return view.data?.progress[o.id]?.left ?? null;
    const sub = o.options!.map(leftUnder);
    return sub.every((n) => n === null) ? null : sub.reduce<number>((a, n) => a + (n ?? 0), 0);
  };

  return (
    <Dialog open onClose={onClose} title={title || 'Choose today’s path'} width={460}>
      <div className="flex flex-col gap-3 px-5 pb-5">
        {view.isPending ? (
          <Spinner />
        ) : !paths ? (
          <p className="text-sm text-muted">This task has no paths.</p>
        ) : (
          <>
            <div className="flex gap-1 self-start rounded-lg bg-hover p-0.5 text-xs font-medium">
              {(['choose', 'more'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setPicked(null);
                    setTrail([]);
                  }}
                  className={clsx('rounded-md px-2.5 py-1', mode === m ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}
                >
                  {m === 'choose' ? 'Today’s path' : 'Finish more'}
                </button>
              ))}
            </div>
            {mode === 'more' && (
              <p className="text-xs text-muted">
                Finish several steps at once: to get ahead, or to catch up on days you missed. Each one is marked done today.
              </p>
            )}
            {mode === 'more' && (view.data?.more.length ?? 0) > 0 && (
              <div className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2">
                <span className="text-xs font-medium text-muted">Finished more today</span>
                {view.data!.more.map((x, i) => (
                  <span key={i} className="flex min-w-0 items-center gap-2 text-sm">
                    <Check size={13} className="shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate">
                      {x.step.title} <span className="text-xs text-faint">· {x.labels.join(' › ')}</span>
                    </span>
                    <button onClick={() => void undoMore(i)} className="shrink-0 text-xs text-faint hover:text-fg">
                      Undo
                    </button>
                  </span>
                ))}
              </div>
            )}
            {picked ? (
              <div className="flex flex-col gap-3">
                <button onClick={() => setPicked(null)} className="flex items-center gap-1 self-start text-xs text-muted hover:text-fg">
                  <ArrowLeft size={13} /> {[...answers, picked].map((a) => a.label).join(' › ')}
                </button>
                <p className="text-[15px] font-medium">How many to finish now?</p>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => setCount(Math.max(1, count - 1))} disabled={count <= 1} aria-label="Fewer">
                    <Minus size={14} />
                  </Button>
                  <span className="w-10 text-center text-lg font-semibold tabular-nums">{count}</span>
                  <Button
                    variant="secondary"
                    onClick={() => setCount(Math.min(available(picked), count + 1))}
                    disabled={count >= available(picked)}
                    aria-label="More"
                  >
                    <Plus size={14} />
                  </Button>
                  <span className="text-xs text-muted">of {available(picked)} not done yet</span>
                </div>
                <p className="text-xs text-muted">Starting with {view.data?.progress[picked.id]?.next?.title ?? 'the next step'}, in order.</p>
                <Button onClick={() => void finishMore()} disabled={busy !== null} className="self-start">
                  {busy ? <Spinner /> : count === 1 ? 'Finish 1 step' : `Finish ${count} steps`}
                </Button>
              </div>
            ) : (
              <>
                {answers.length > 0 && (
                  <button onClick={() => setTrail(trail.slice(0, -1))} className="flex items-center gap-1 self-start text-xs text-muted hover:text-fg">
                    <ArrowLeft size={13} /> {answers.map((a) => a.label).join(' › ')}
                  </button>
                )}
                <p className="text-[15px] font-medium">{question || 'Which one?'}</p>
                <div className="flex flex-col gap-2">
                  {options.map((o) => {
                    const p = isLeaf(o) ? view.data?.progress[o.id] : undefined;
                    const left = leftUnder(o);
                    const finished = isLeaf(o) ? !p?.next || (mode === 'more' && available(o) === 0) : left === 0;
                    if (p?.hidden) return null;
                    return (
                      <button
                        key={o.id}
                        onClick={() => void choose(o)}
                        disabled={finished || busy !== null}
                        className={clsx(
                          'flex items-center gap-3 rounded-lg border border-line px-3.5 py-3 text-start transition-colors',
                          finished ? 'opacity-55' : 'hover:border-accent hover:bg-hover',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{o.label || 'Untitled'}</span>
                          <span className="mt-0.5 block truncate text-xs text-muted">
                            {finished ? 'All done' : p?.next ? `Next: ${p.next.title} · ${p.left} of ${p.total} left` : left !== null ? `${left} left` : ''}
                          </span>
                        </span>
                        {busy === o.id ? <Spinner /> : <ChevronRight size={16} className="shrink-0 text-faint" />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {mode === 'choose' && view.data?.choice && (
              <button
                onClick={async () => {
                  try {
                    await api(`/api/events/${eventId}/paths/choose`, {
                      method: 'POST',
                      body: { trail: null },
                    });
                    refreshPaths(eventId);
                    onChosen?.();
                    onClose();
                  } catch (err) {
                    toastError(err);
                  }
                }}
                className="self-start text-xs text-muted hover:text-fg"
              >
                Clear today’s choice
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function refreshPaths(eventId: string) {
  queryClient.invalidateQueries({ queryKey: ['event-paths', eventId] });
  queryClient.invalidateQueries({ queryKey: ['event', eventId] });
  queryClient.invalidateQueries({ queryKey: ['tasks'] });
}

/** Under a task: today's path and step (opening the card), or a button to choose one. */
export function PathLine({
  workspaceId,
  choice,
  done,
  more = 0,
  onChoose,
}: {
  workspaceId: string;
  choice: Pick<PathChoice, 'labels' | 'step'> | null;
  done: boolean;
  /** Steps finished today on top of the day's one. */
  more?: number;
  onChoose: (mode: PathMode) => void;
}) {
  const navigate = useNavigate();
  const open = (mode: PathMode) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onChoose(mode);
  };
  const extra = (
    <>
      {more > 0 && <span className="shrink-0 text-accent">+{more} more</span>}
      <button onClick={open('more')} className="shrink-0 text-faint hover:text-fg" title="Finish more steps today: get ahead, or catch up">
        Finish more
      </button>
    </>
  );
  if (!choice)
    return (
      <span className="mt-1 flex min-w-0 items-center gap-2 text-xs">
        {!done && (
          <button
            onClick={open('choose')}
            className="flex shrink-0 items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 font-medium text-accent hover:bg-accent/20"
          >
            <GitFork size={12} /> Choose today’s path
          </button>
        )}
        {extra}
      </span>
    );
  const step = choice.step;
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <GitFork size={12} className="shrink-0" />
      <span className="shrink-0">{choice.labels.join(' › ')}</span>
      {step ? (
        <>
          <span className="shrink-0">·</span>
          {step.kind === 'card' ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(
                  locationPath(workspaceId, {
                    pageId: step.pageId,
                    rowId: step.rowId,
                  }),
                );
              }}
              className="min-w-0 truncate font-medium text-fg hover:underline"
            >
              {step.title}
            </button>
          ) : (
            <span className="min-w-0 truncate font-medium text-fg">{step.title}</span>
          )}
        </>
      ) : (
        <span>· nothing left on this path</span>
      )}
      {!done && (
        <button onClick={open('choose')} className="shrink-0 text-faint hover:text-fg">
          Change
        </button>
      )}
      {extra}
    </span>
  );
}

// ---------- editing ----------

/** Sets up a task's questions and answers. */
export function PathsEditor({
  workspaceId,
  value,
  onSave,
  onClose,
}: {
  workspaceId: string;
  value: Paths | null;
  onSave: (paths: Paths | null) => void;
  onClose: () => void;
}) {
  const [paths, setPaths] = useState<Paths>(() => value ?? { question: '', options: [blankOption(), blankOption()] });
  const pages = usePages(workspaceId);
  const databases = (pages.data ?? []).filter((p) => DATABASES.includes(p.type));

  const save = () => {
    const bad = findEmpty(paths.options);
    if (bad) return toastError(new Error(bad));
    onSave(paths);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} title="Paths" width={640} maxHeight="88vh" top="5vh">
      <div className="flex min-h-0 flex-col gap-3 px-5 pb-5">
        <p className="text-sm text-muted">
          Each day the task asks this question. An answer can ask another question, or lead to steps worked through in order: typed in, or the cards of a
          database. Ticking the task off finishes the day’s step.
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto pe-1">
          <Input
            value={paths.question}
            onChange={(e) => setPaths({ ...paths, question: e.target.value })}
            placeholder="Question, e.g. What do you want to study today?"
          />
          <Answers options={paths.options} onChange={(options) => setPaths({ ...paths, options })} databases={databases} level={1} />
        </div>
        <div className="flex items-center gap-2">
          {value && (
            <Button
              variant="ghost"
              className="text-danger"
              onClick={() => {
                onSave(null);
                onClose();
              }}
            >
              <Trash2 size={15} /> Remove paths
            </Button>
          )}
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const blankOption = (): PathOption => ({ id: newId(), label: '', steps: [] });

function findEmpty(options: PathOption[]): string | null {
  for (const o of options) {
    if (!o.label.trim()) return 'Give every answer a name';
    if (o.options?.length) {
      const bad = findEmpty(o.options);
      if (bad) return bad;
    } else if (o.source && !o.source.pageId) return `Choose a database for “${o.label}”`;
  }
  return null;
}

type Mode = 'question' | 'steps' | 'cards';
const modeOf = (o: PathOption): Mode => (o.options?.length ? 'question' : o.source ? 'cards' : 'steps');

function Answers({
  options,
  onChange,
  databases,
  level,
}: {
  options: PathOption[];
  onChange: (o: PathOption[]) => void;
  databases: { id: string; title: string; icon: string }[];
  level: number;
}) {
  const update = (i: number, o: PathOption) => onChange(options.map((x, j) => (j === i ? o : x)));
  return (
    <div className="mt-2 flex flex-col gap-2">
      {options.map((o, i) => (
        <div key={o.id} className="rounded-lg border border-line p-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={o.label}
              onChange={(e) => update(i, { ...o, label: e.target.value })}
              placeholder={`Answer ${i + 1}, e.g. Geography`}
              className="flex-1"
            />
            <select
              value={modeOf(o)}
              onChange={(e) => {
                const mode = e.target.value as Mode;
                if (mode === 'question')
                  update(i, {
                    id: o.id,
                    label: o.label,
                    question: '',
                    options: [blankOption(), blankOption()],
                  });
                else if (mode === 'cards')
                  update(i, {
                    id: o.id,
                    label: o.label,
                    source: {
                      pageId: '',
                      filters: [],
                      sortField: null,
                      dateField: null,
                    },
                  });
                else update(i, { id: o.id, label: o.label, steps: [] });
              }}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-sm"
            >
              {level < 6 && <option value="question">Asks another question</option>}
              <option value="steps">Leads to steps</option>
              <option value="cards">Leads to cards</option>
            </select>
            <button
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              disabled={options.length < 2}
              className="p-1 text-faint hover:text-danger disabled:opacity-30"
              aria-label="Remove answer"
            >
              <Trash2 size={15} />
            </button>
          </div>
          {modeOf(o) === 'question' && (
            <div className="mt-2 border-s-2 border-line ps-3">
              <Input value={o.question ?? ''} onChange={(e) => update(i, { ...o, question: e.target.value })} placeholder="Next question, e.g. Which book?" />
              <Answers options={o.options!} onChange={(sub) => update(i, { ...o, options: sub })} databases={databases} level={level + 1} />
            </div>
          )}
          {modeOf(o) === 'steps' && <StepsEditor steps={o.steps ?? []} onChange={(steps) => update(i, { ...o, steps })} />}
          {modeOf(o) === 'cards' && <SourceEditor source={o.source!} onChange={(source) => update(i, { ...o, source })} databases={databases} />}
        </div>
      ))}
      <button
        onClick={() => onChange([...options, blankOption()])}
        disabled={options.length >= 20}
        className="flex items-center gap-1 self-start text-sm text-muted hover:text-fg"
      >
        <Plus size={15} /> Add answer
      </button>
    </div>
  );
}

/** Steps typed one per line; lines keep their id (and whether they're done) while the text stays the same. */
function StepsEditor({ steps, onChange }: { steps: { id: string; title: string }[]; onChange: (s: { id: string; title: string }[]) => void }) {
  const [text, setText] = useState(() => steps.map((s) => s.title).join('\n'));
  return (
    <textarea
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const free = [...steps];
        onChange(
          e.target.value
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((title) => {
              const i = free.findIndex((s) => s.title === title);
              return i >= 0 ? free.splice(i, 1)[0] : { id: newId(), title };
            }),
        );
      }}
      rows={4}
      placeholder={'One step per line, in order, e.g.\nChapter 1\nChapter 2'}
      className="mt-2 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
    />
  );
}

function SourceEditor({
  source,
  onChange,
  databases,
}: {
  source: PathSource;
  onChange: (s: PathSource) => void;
  databases: { id: string; title: string; icon: string }[];
}) {
  const fields = useQuery({
    queryKey: ['fields', source.pageId],
    queryFn: () => api<{ fields: CardField[] }>(`/api/pages/${source.pageId}/fields`).then((r) => r.fields),
    enabled: !!source.pageId,
  });
  const all = fields.data ?? [];
  const selects = all.filter((f) => (f.type === 'select' || f.type === 'multi_select') && f.options?.length);
  const values = (fieldId: string) => source.filters.find((f) => f.fieldId === fieldId)?.values ?? [];
  const toggle = (fieldId: string, optionId: string) => {
    const has = values(fieldId).includes(optionId);
    const next = has ? values(fieldId).filter((v) => v !== optionId) : [...values(fieldId), optionId];
    const filters = source.filters.filter((f) => f.fieldId !== fieldId);
    onChange({
      ...source,
      filters: next.length ? [...filters, { fieldId, values: next }] : filters,
    });
  };
  const label = 'flex items-center gap-2 text-sm';
  const select = 'h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-sm';
  return (
    <div className="mt-2 flex flex-col gap-2 text-sm">
      <label className={label}>
        <span className="w-28 shrink-0 text-muted">Database</span>
        <select
          value={source.pageId}
          onChange={(e) =>
            onChange({
              pageId: e.target.value,
              filters: [],
              sortField: null,
              dateField: null,
            })
          }
          className={select}
        >
          <option value="">Choose…</option>
          {databases.map((d) => (
            <option key={d.id} value={d.id}>
              {d.icon ? `${d.icon} ` : ''}
              {d.title || 'Untitled'}
            </option>
          ))}
        </select>
      </label>
      {source.pageId && (
        <>
          {selects.map((f) => (
            <div key={f.id} className="flex items-start gap-2">
              <span className="w-28 shrink-0 truncate pt-1 text-muted">Only {f.name}</span>
              <div className="flex flex-1 flex-wrap gap-1">
                {f.options!.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => toggle(f.id, opt.id)}
                    className={clsx(
                      'rounded-md border px-2 py-0.5 text-xs',
                      values(f.id).includes(opt.id) ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-line text-muted hover:text-fg',
                    )}
                  >
                    {opt.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <label className={label}>
            <span className="w-28 shrink-0 text-muted">In order of</span>
            <select value={source.sortField ?? ''} onChange={(e) => onChange({ ...source, sortField: e.target.value || null })} className={select}>
              <option value="">The database’s order</option>
              {all.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            <span className="w-28 shrink-0 text-muted">When finished</span>
            <select value={source.dateField ?? ''} onChange={(e) => onChange({ ...source, dateField: e.target.value || null })} className={select}>
              <option value="">Only set it to done</option>
              {all
                .filter((f) => f.type === 'date')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    Also set {f.name} to the day
                  </option>
                ))}
            </select>
          </label>
          <p className="text-xs text-faint">Cards that are done are skipped. Finishing one sets its status to done and ticks the tasks inside it.</p>
        </>
      )}
    </div>
  );
}

/** One line about a task's paths, for the task dialog. */
export function describePaths(p: Paths): string {
  const count = (os: PathOption[]): number => os.reduce((n, o) => n + (isLeaf(o) ? 1 : count(o.options!)), 0);
  const n = count(p.options);
  return `${p.question || 'A question'} · ${n} path${n === 1 ? '' : 's'}`;
}
