import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, ChevronRight, GitFork, PartyPopper, Plus, Trash2 } from 'lucide-react';
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
  /** Repeating tasks: missed days wait to be done one by one (on unless turned off). */
  catchUp?: boolean;
}

export type PathStep = { kind: 'step'; id: string; title: string } | { kind: 'card'; pageId: string; rowId: string; title: string };

export interface PathChoice {
  date: string;
  trail: string[];
  labels: string[];
  step: PathStep | null;
}

export interface PathState {
  done: string[];
  today: PathChoice | null;
  history?: { date: string }[];
}

interface Progress {
  total: number;
  left: number;
  next: PathStep | null;
  hidden?: boolean;
}

interface PathsView {
  paths: Paths | null;
  choice: PathChoice | null;
  progress: Record<string, Progress>;
}

const DATABASES = ['grid', 'board', 'calendar', 'timeline', 'chart', 'form', 'list', 'gallery', 'feed'];
const isLeaf = (o: PathOption) => !o.options?.length;

/** Today's choice of a task, if it was made for the task's current date. */
export const choiceOf = (e: { startDate: string; pathState?: PathState | null }) => (e.pathState?.today?.date === e.startDate ? e.pathState.today : null);

/** A repeating task with paths keeps missed days: it waits on the first day not done, and ticking it moves it on. */
export const keepsMissedDays = (e: { paths?: Paths | null; repeat?: unknown }) => !!e.paths && e.paths.catchUp !== false && !!e.repeat;

/** Takes back the last day a task was ticked off for. */
export async function undoLastDay(eventId: string, onDone?: () => void) {
  try {
    await api(`/api/events/${eventId}/paths/undo`, { method: 'POST' });
    refreshPaths(eventId);
    onDone?.();
  } catch (err) {
    toastError(err);
  }
}

// ---------- choosing ----------

/** Asks the task's questions one by one, showing how far along each path is, and picks today's step. */
export function ChoosePathDialog({ eventId, title, onClose, onChosen }: { eventId: string; title: string; onClose: () => void; onChosen?: () => void }) {
  const view = useQuery({
    queryKey: ['event-paths', eventId],
    queryFn: () => api<PathsView>(`/api/events/${eventId}/paths`),
    staleTime: 0,
  });
  const [trail, setTrail] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const paths = view.data?.paths;

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
                const finished = isLeaf(o) ? !p?.next : left === 0;
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
            {view.data?.choice && (
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

/**
 * Under a task: today's path and step (opening the card), or a button to choose one. A task that keeps
 * missed days also says when it's all caught up (it's then on a day ahead), and can undo its last day.
 */
export function PathLine({
  workspaceId,
  eventId,
  choice,
  done,
  ahead = false,
  date,
  canUndo = false,
  onChoose,
}: {
  workspaceId: string;
  eventId: string;
  choice: Pick<PathChoice, 'labels' | 'step'> | null;
  done: boolean;
  ahead?: boolean;
  /** The day the task is on. */
  date: string;
  canUndo?: boolean;
  onChoose: () => void;
}) {
  const navigate = useNavigate();
  const undo = canUndo && (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void undoLastDay(eventId);
      }}
      className="shrink-0 text-faint hover:text-fg"
      title="Take back the last day you ticked off"
    >
      Undo last day
    </button>
  );
  const caughtUp = ahead && (
    <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400">
      <PartyPopper size={12} className="shrink-0" />
      All caught up. You can keep going with {dayLabel(date)}.
    </span>
  );
  if (!choice)
    return (
      <span className="flex flex-col items-start">
        {caughtUp}
        <span className="mt-1 flex items-center gap-2 text-xs">
          {!done && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onChoose();
              }}
              className="flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 font-medium text-accent hover:bg-accent/20"
            >
              <GitFork size={12} /> {ahead ? 'Choose the next path' : 'Choose today’s path'}
            </button>
          )}
          {undo}
        </span>
      </span>
    );
  const step = choice.step;
  return (
    <span className="flex flex-col items-start">
      {caughtUp}
      <span className="mt-0.5 flex min-w-0 max-w-full items-center gap-1.5 text-xs text-muted">
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
          <button
            onClick={(e) => {
              e.stopPropagation();
              onChoose();
            }}
            className="shrink-0 text-faint hover:text-fg"
          >
            Change
          </button>
        )}
        {undo}
      </span>
    </span>
  );
}

/** "Friday, Nov 6" for a YYYY-MM-DD day. */
function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
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
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={paths.catchUp !== false}
            onChange={(e) => setPaths({ ...paths, catchUp: e.target.checked ? undefined : false })}
          />
          <span>
            Missed days wait for you
            <span className="block text-xs text-muted">
              For a repeating task: it stays overdue on the first day not done, and each tick moves it to the next day. Once caught up you can keep going ahead.
            </span>
          </span>
        </label>
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
