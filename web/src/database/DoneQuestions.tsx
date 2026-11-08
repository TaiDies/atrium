import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../components/ui';
import { CellEditor, FieldIcon } from './cells';
import { DatabaseContext, type DatabaseContextValue, useDb } from './context';
import { COMPUTED_TYPES, type DatabaseState, type Field, isDoneOption, type Row } from './model';

/** One question asked when a card is marked done: a property to fill in, and whether it must be. */
export interface DoneQuestion {
  fieldId: string;
  required?: boolean;
}

/** Properties that can be asked: anything typed in by hand. */
const askable = (f: Field, owner: Field) => f.id !== owner.id && !f.primary && !COMPUTED_TYPES.has(f.type) && f.type !== 'ai';

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Whether a value marks a card done for this property (a ticked checkbox, or a "done" status). */
const marksDone = (field: Field, value: unknown) => (field.type === 'checkbox' ? value === true : isDoneOption(field, value));

/** A change that would mark a card done and has questions to ask first. */
export interface DoneAsk {
  row: Row;
  questions: { field: Field; required: boolean }[];
}

/** The questions to ask before applying `patch` to a card, or null when it can go ahead as it is. */
export function doneQuestionsFor(db: DatabaseState, rowId: string, patch: Record<string, unknown>): DoneAsk | null {
  const row = db.rows.find((r) => r.id === rowId);
  if (!row) return null;
  for (const [fieldId, value] of Object.entries(patch)) {
    const field = db.fields.find((f) => f.id === fieldId);
    if (!field?.askOnDone?.length) continue;
    if (!marksDone(field, value) || marksDone(field, row.cells[fieldId])) continue;
    const questions = field.askOnDone
      .map((q) => ({ field: db.fields.find((f) => f.id === q.fieldId), required: !!q.required }))
      .filter((q): q is { field: Field; required: boolean } => !!q.field && askable(q.field, field));
    if (questions.length) return { row, questions };
  }
  return null;
}

/** Asks the questions; `onDone` gets the answers (only the ones filled in), `onCancel` leaves the card as it was. */
export function DoneQuestionsDialog({ ask, onDone, onCancel }: { ask: DoneAsk; onDone: (answers: Record<string, unknown>) => void; onCancel: () => void }) {
  const ctx = useDb();
  // Answers start empty, so a card that repeats doesn't carry the last answers over.
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [tried, setTried] = useState(false);
  const draft = useMemo<Row>(() => {
    const cells = { ...ask.row.cells };
    for (const q of ask.questions) cells[q.field.id] = answers[q.field.id];
    return { ...ask.row, cells };
  }, [ask, answers]);
  // The property editors write into the answers instead of the card.
  const local = useMemo<DatabaseContextValue>(
    () => ({ ...ctx, actions: { ...ctx.actions, updateCell: (_row: string, fieldId: string, value: unknown) => setAnswers((a) => ({ ...a, [fieldId]: value })) } }),
    [ctx],
  );
  // The properties as they are now (an option made while answering shows straight away), required ones first.
  const questions = useMemo(
    () => ask.questions.map((q) => ({ ...q, field: ctx.db.fields.find((f) => f.id === q.field.id) ?? q.field })).sort((a, b) => Number(b.required) - Number(a.required)),
    [ask, ctx.db.fields],
  );
  const missing = questions.filter((q) => q.required && isEmpty(answers[q.field.id]));
  const submit = () => {
    if (missing.length) return setTried(true);
    onDone(Object.fromEntries(Object.entries(answers).filter(([, v]) => !isEmpty(v))));
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="dialog" aria-label="Before you finish" className="w-full max-w-[440px] rounded-xl border border-line bg-surface p-4 shadow-xl">
        <div className="mb-1 text-base font-semibold">Before you finish</div>
        <p className="mb-3 text-sm text-muted">A few questions about this card. Questions marked * must be answered.</p>
        <DatabaseContext.Provider value={local}>
          <div className="space-y-2">
            {questions.map(({ field, required }) => (
              <div key={field.id}>
                <div className="mb-0.5 flex items-center gap-1.5 text-sm font-medium">
                  <FieldIcon type={field.type} className="text-muted" />
                  {field.name || 'Untitled'}
                  {required ? <span className="text-red-500">*</span> : <span className="text-xs font-normal text-faint">optional</span>}
                </div>
                <div className={tried && required && isEmpty(answers[field.id]) ? 'rounded-md ring-1 ring-red-500' : 'rounded-md border border-line'}>
                  <CellEditor field={field} row={draft} variant="detail" />
                </div>
              </div>
            ))}
          </div>
        </DatabaseContext.Provider>
        {tried && missing.length > 0 && <p className="mt-2 text-xs text-red-500">Answer {missing.map((q) => q.field.name || 'Untitled').join(', ')} to finish.</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>Mark as done</Button>
        </div>
      </div>
    </div>
  );
}

/** Field menu section (checkboxes and status/select properties): questions asked when a card is marked done. */
export function DoneQuestionsSettings({ field }: { field: Field }) {
  const { db, actions } = useDb();
  const list = field.askOnDone ?? [];
  const choices = db.fields.filter((f) => askable(f, field) && !list.some((q) => q.fieldId === f.id));
  const save = (next: DoneQuestion[]) => actions.updateField(field.id, { askOnDone: next.length ? next : undefined });

  return (
    <div className="mx-1 mb-1 space-y-1.5 rounded-md px-1.5 py-1.5 text-xs">
      <div className="text-sm text-fg">Ask when marked done</div>
      {list.map((q) => {
        const f = db.fields.find((x) => x.id === q.fieldId);
        if (!f) return null;
        return (
          <div key={q.fieldId} className="flex items-center gap-1.5">
            <FieldIcon type={f.type} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-fg">{f.name || 'Untitled'}</span>
            <select
              value={q.required ? 'required' : 'optional'}
              onChange={(e) => save(list.map((x) => (x.fieldId === q.fieldId ? { ...x, required: e.target.value === 'required' || undefined } : x)))}
              className="h-6 rounded border border-line bg-surface px-1 text-xs text-fg"
            >
              <option value="required">Required</option>
              <option value="optional">Optional</option>
            </select>
            <button aria-label="Remove question" onClick={() => save(list.filter((x) => x.fieldId !== q.fieldId))} className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg">
              <X size={13} />
            </button>
          </div>
        );
      })}
      {choices.length > 0 && (
        <label className="flex items-center gap-1.5 text-muted">
          <Plus size={13} className="shrink-0" />
          <select
            value=""
            onChange={(e) => e.target.value && save([...list, { fieldId: e.target.value, required: true }])}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-xs text-fg"
          >
            <option value="">Add a question…</option>
            {choices.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name || 'Untitled'}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-faint">
        {list.length
          ? 'Marking a card done asks these first. Cancelling leaves the card as it was.'
          : 'Pick properties to fill in each time a card is marked done (for example how it went, or notes).'}
      </p>
    </div>
  );
}
