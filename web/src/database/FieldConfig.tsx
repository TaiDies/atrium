import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApp } from '../app/context';
import { PageIcon } from '../app/PageIcon';
import { Button, toastError } from '../components/ui';
import { api, pageTitle } from '../lib/api';
import { queryClient } from '../lib/queries';
import { fetchRelated, relatedKey } from './computed';
import { useDb } from './context';
import { FUNCTION_HELP, runFormula } from './formula';
import { type ButtonAction, type ButtonConfig, type Field, fieldKind, type FieldType, newId, type RelationConfig, type RollupConfig, type RollupFn } from './model';

// Setting up the properties that need more than a name: which database a relation links to, what a
// rollup adds up, and a formula.

export const CONFIG_TYPES = new Set<FieldType>(['relation', 'rollup', 'formula', 'button']);

const DATABASE_TYPES = ['grid', 'board', 'calendar', 'timeline', 'chart', 'form', 'list', 'gallery', 'feed'];

export const ROLLUP_FNS: { fn: RollupFn; label: string }[] = [
  { fn: 'count', label: 'Count linked cards' },
  { fn: 'count_values', label: 'Count filled in' },
  { fn: 'count_unique', label: 'Count different values' },
  { fn: 'sum', label: 'Sum' },
  { fn: 'average', label: 'Average' },
  { fn: 'min', label: 'Smallest' },
  { fn: 'max', label: 'Largest' },
  { fn: 'percent_checked', label: '% checked' },
  { fn: 'percent_done', label: '% with a “Done” status' },
  { fn: 'earliest', label: 'Earliest date' },
  { fn: 'latest', label: 'Latest date' },
  { fn: 'show', label: 'Show the values' },
];

export interface FieldExtra {
  id?: string;
  relation?: RelationConfig;
  rollup?: RollupConfig;
  formula?: string;
  button?: ButtonConfig;
}

/**
 * The settings for a relation, rollup or formula. `field` is the property being edited (absent while
 * making a new one); `onSave` gets what to store.
 */
export function FieldConfig({ type, field, onSave }: { type: FieldType; field?: Field; onSave: (extra: FieldExtra) => void }) {
  if (type === 'relation') return <RelationConfigForm field={field} onSave={onSave} />;
  if (type === 'rollup') return <RollupConfigForm field={field} onSave={onSave} />;
  if (type === 'button') return <ButtonConfigForm field={field} onSave={onSave} />;
  return <FormulaConfigForm field={field} onSave={onSave} />;
}

function RelationConfigForm({ field, onSave }: { field?: Field; onSave: (extra: FieldExtra) => void }) {
  const { pages } = useApp();
  const { pageId, actions } = useDb();
  const [target, setTarget] = useState(field?.relation?.pageId ?? '');
  const [twoWay, setTwoWay] = useState(true);
  const [busy, setBusy] = useState(false);
  const databases = pages.filter((p) => DATABASE_TYPES.includes(p.type));
  const existing = !!field?.relation;
  const self = pages.find((p) => p.id === pageId);

  const save = async () => {
    if (!target) return;
    if (existing) return onSave({ relation: { ...field!.relation!, pageId: target } });
    const id = newId();
    let pairedFieldId: string | null = null;
    if (twoWay && target === pageId) {
      pairedFieldId = newId();
      actions.addField('relation', `${field?.name ?? 'Related'} (linked from)`, undefined, { id: pairedFieldId, relation: { pageId, pairedFieldId: id, reverse: true } });
    } else if (twoWay) {
      setBusy(true);
      try {
        pairedFieldId = newId();
        await api(`/api/pages/${target}/fields`, {
          method: 'POST',
          body: { field: { id: pairedFieldId, name: self ? pageTitle(self) : 'Linked', type: 'relation', relation: { pageId, pairedFieldId: id, reverse: true } } },
        });
      } catch (err) {
        setBusy(false);
        return toastError(err);
      }
      setBusy(false);
    }
    onSave({ id, relation: { pageId: target, pairedFieldId } });
  };

  return (
    <div className="space-y-2 p-1.5">
      <div className="text-xs font-medium text-faint">Link to cards in</div>
      <div className="max-h-48 overflow-y-auto rounded-md border border-line">
        {databases.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={existing && field?.relation?.reverse}
            onClick={() => setTarget(p.id)}
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-start text-sm ${target === p.id ? 'bg-active font-medium' : 'hover:bg-hover'}`}
          >
            <PageIcon page={p} size={14} />
            <span className="truncate">
              {pageTitle(p)}
              {p.id === pageId ? ' (this database)' : ''}
            </span>
          </button>
        ))}
        {!databases.length && <p className="p-2 text-xs text-muted">No databases yet.</p>}
      </div>
      {!existing && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} className="mt-1" />
          <span>
            Show it on the other side too
            <span className="block text-xs text-muted">Adds a matching property there that lists the cards linking to each card.</span>
          </span>
        </label>
      )}
      <Button size="sm" variant="primary" disabled={!target || busy} loading={busy} onClick={save} className="w-full">
        {existing ? 'Save' : 'Add relation'}
      </Button>
    </div>
  );
}

function RollupConfigForm({ field, onSave }: { field?: Field; onSave: (extra: FieldExtra) => void }) {
  const { db } = useDb();
  const relations = db.fields.filter((f) => f.type === 'relation' && f.relation);
  const [relationField, setRelationField] = useState(field?.rollup?.relationField ?? relations[0]?.id ?? '');
  const [targetField, setTargetField] = useState(field?.rollup?.targetField ?? '');
  const [fn, setFn] = useState<RollupFn>(field?.rollup?.fn ?? 'count');
  const relation = relations.find((f) => f.id === relationField);
  const other = useQuery({
    queryKey: relatedKey(relation?.relation?.pageId ?? 'none'),
    queryFn: () => fetchRelated(relation!.relation!.pageId),
    enabled: !!relation?.relation?.pageId,
  });
  const select = 'h-8 w-full rounded-md border border-line bg-bg px-2 text-sm';

  if (!relations.length) return <p className="p-2 text-xs text-muted">Add a relation property first — a rollup adds up values from the cards it links to.</p>;
  return (
    <div className="space-y-2 p-1.5">
      <label className="block">
        <span className="mb-1 block text-xs text-faint">Relation</span>
        <select value={relationField} onChange={(e) => setRelationField(e.target.value)} className={select}>
          {relations.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-faint">Property of the linked cards</span>
        <select value={targetField} onChange={(e) => setTargetField(e.target.value)} className={select}>
          <option value="">{other.data ? 'Name' : 'Loading…'}</option>
          {(other.data?.fields ?? [])
            .filter((f) => !f.primary)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-faint">Calculate</span>
        <select value={fn} onChange={(e) => setFn(e.target.value as RollupFn)} className={select}>
          {ROLLUP_FNS.map((r) => (
            <option key={r.fn} value={r.fn}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" variant="primary" disabled={!relationField} onClick={() => onSave({ rollup: { relationField, targetField: targetField || null, fn } })} className="w-full">
        {field?.rollup ? 'Save' : 'Add rollup'}
      </Button>
    </div>
  );
}

function FormulaConfigForm({ field, onSave }: { field?: Field; onSave: (extra: FieldExtra) => void }) {
  const { db } = useDb();
  const [formula, setFormula] = useState(field?.formula ?? '');
  const [showFns, setShowFns] = useState(false);
  const sample = db.rows[0];
  const props = db.fields.filter((f) => f.id !== field?.id);
  // A preview against the first card, so mistakes show straight away.
  const preview = formula.trim()
    ? runFormula(formula, {
        prop: (name) => {
          const p = props.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
          if (!p) throw new Error(`There's no property called “${name}”`);
          const v = sample?.cells[p.id];
          if (p.type === 'select') return p.options?.find((o) => o.id === v)?.name ?? null;
          return v === undefined ? null : Array.isArray(v) || typeof v !== 'object' ? (v as never) : null;
        },
      })
    : null;
  const insert = (text: string) => setFormula((f) => (f ? `${f}${/\s$/.test(f) ? '' : ' '}${text}` : text));

  return (
    <div className="w-[min(360px,80vw)] space-y-2 p-1.5">
      <textarea
        autoFocus
        value={formula}
        onChange={(e) => setFormula(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={'e.g. dateBetween(prop("Due"), today(), "days")'}
        className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
      />
      <div className="text-xs">
        {!preview ? (
          <span className="text-muted">Use prop("Name") for a property, + − × ÷, comparisons, and functions below.</span>
        ) : 'error' in preview ? (
          <span className="text-red-500">{preview.error}</span>
        ) : (
          <span className="text-muted">
            First card: <b className="text-fg">{preview.value === null ? '—' : Array.isArray(preview.value) ? preview.value.join(', ') : String(preview.value)}</b>
          </span>
        )}
      </div>
      <div>
        <div className="mb-1 text-xs text-faint">Properties</div>
        <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
          {props.map((p) => (
            <button key={p.id} type="button" onClick={() => insert(`prop("${p.name}")`)} className="rounded border border-line px-1.5 py-0.5 text-xs hover:bg-hover">
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <button type="button" onClick={() => setShowFns((v) => !v)} className="text-xs text-accent hover:underline">
        {showFns ? 'Hide functions' : 'Show functions'}
      </button>
      {showFns && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-line p-1">
          {FUNCTION_HELP.map((f) => (
            <button key={f.name} type="button" onClick={() => insert(`${f.name}(`)} className="block w-full rounded px-1.5 py-0.5 text-start font-mono text-[11px] hover:bg-hover">
              {f.help}
            </button>
          ))}
        </div>
      )}
      <Button size="sm" variant="primary" onClick={() => onSave({ formula })} className="w-full">
        {field ? 'Save' : 'Add formula'}
      </Button>
    </div>
  );
}

/** Types a button can set, and the special values it can fill in. */
const SETTABLE = new Set<FieldType>(['text', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone', 'person', 'checklist']);

function ButtonConfigForm({ field, onSave }: { field?: Field; onSave: (extra: FieldExtra) => void }) {
  const { db } = useDb();
  const [label, setLabel] = useState(field?.button?.label ?? field?.name ?? 'Button');
  const [steps, setSteps] = useState<ButtonAction[]>(field?.button?.actions ?? []);
  const targets = db.fields.filter((f) => SETTABLE.has(fieldKind(f)) && f.id !== field?.id);
  const control = 'h-7 rounded border border-line bg-bg px-1.5 text-xs';
  const update = (i: number, next: ButtonAction) => setSteps((s) => s.map((x, j) => (j === i ? next : x)));

  const valueInput = (step: Extract<ButtonAction, { type: 'set' }>, i: number) => {
    const target = db.fields.find((f) => f.id === step.fieldId);
    if (!target) return null;
    const set = (value: unknown) => update(i, { ...step, value });
    if (target.type === 'select' || target.type === 'multi_select') {
      return (
        <select value={String((Array.isArray(step.value) ? step.value[0] : step.value) ?? '')} onChange={(e) => set(target.type === 'multi_select' ? [e.target.value] : e.target.value || null)} className={control}>
          <option value="">Empty</option>
          {target.options?.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    }
    if (target.type === 'checkbox') {
      return (
        <select value={step.value ? '1' : ''} onChange={(e) => set(!!e.target.value)} className={control}>
          <option value="1">Checked</option>
          <option value="">Unchecked</option>
        </select>
      );
    }
    if (target.type === 'date') {
      return (
        <select value={step.value === '@today' ? '@today' : ''} onChange={(e) => set(e.target.value || null)} className={control}>
          <option value="@today">Today</option>
          <option value="">Empty</option>
        </select>
      );
    }
    if (target.type === 'person') {
      return (
        <select value={step.value === '@me' ? '@me' : ''} onChange={(e) => set(e.target.value || [])} className={control}>
          <option value="@me">Whoever clicks</option>
          <option value="">Nobody</option>
        </select>
      );
    }
    return <input value={String(step.value ?? '')} onChange={(e) => set(target.type === 'number' ? Number(e.target.value) : e.target.value)} placeholder={target.type === 'checklist' ? 'Item to add' : 'Value'} className={clsx(control, 'min-w-0 flex-1')} />;
  };

  return (
    <div className="w-[min(340px,80vw)] space-y-2 p-1.5">
      <label className="block">
        <span className="mb-1 block text-xs text-faint">Button text</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent" />
      </label>
      <div className="text-xs text-faint">When clicked</div>
      {steps.map((step, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1 rounded-md border border-line p-1.5">
          {step.type === 'set' ? (
            <>
              <span className="text-xs text-muted">Set</span>
              <select value={step.fieldId} onChange={(e) => update(i, { type: 'set', fieldId: e.target.value, value: null })} className={control}>
                {targets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">to</span>
              {valueInput(step, i)}
            </>
          ) : (
            <>
              <span className="text-xs text-muted">Open</span>
              <input value={step.url} onChange={(e) => update(i, { type: 'url', url: e.target.value })} placeholder="https://…" className={clsx(control, 'min-w-0 flex-1')} />
            </>
          )}
          <button type="button" onClick={() => setSteps((s) => s.filter((_, j) => j !== i))} className="ms-auto rounded px-1 text-xs text-muted hover:text-danger" aria-label="Remove">
            ✕
          </button>
        </div>
      ))}
      <div className="flex gap-1">
        <button
          type="button"
          disabled={!targets.length}
          onClick={() => setSteps((s) => [...s, { type: 'set', fieldId: targets[0].id, value: null }])}
          className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:opacity-50"
        >
          + Set a property
        </button>
        <button type="button" onClick={() => setSteps((s) => [...s, { type: 'url', url: '' }])} className="rounded-md border border-line px-2 py-1 text-xs hover:bg-hover">
          + Open a link
        </button>
      </div>
      <Button size="sm" variant="primary" onClick={() => onSave({ button: { label: label.trim() || 'Button', actions: steps } })} className="w-full">
        {field ? 'Save' : 'Add button'}
      </Button>
    </div>
  );
}

/** After a two-way relation is made, the other database needs a fresh look. */
export const refreshRelated = () => queryClient.invalidateQueries({ queryKey: ['related-db'] });
