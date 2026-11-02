import clsx from 'clsx';
import { Repeat } from 'lucide-react';
import { type CardField, STATUS_LABELS, type TaskStatus } from './api';
import { type RepeatRule, type RepeatUnit } from './repeat';

const UNITS: { id: RepeatUnit; one: string; many: string }[] = [
  { id: 'day', one: 'day', many: 'days' },
  { id: 'week', one: 'week', many: 'weeks' },
  { id: 'month', one: 'month', many: 'months' },
  { id: 'year', one: 'year', many: 'years' },
];

function niceDate(d: string) {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Every 2 weeks from 5 Oct 2026 until 30 Dec 2026". */
export function describeRepeat(rule: RepeatRule) {
  const unit = UNITS.find((u) => u.id === rule.unit)!;
  const every = rule.every === 1 ? `Every ${unit.one}` : `Every ${rule.every} ${unit.many}`;
  return `${every} from ${niceDate(rule.start)}${rule.end ? ` until ${niceDate(rule.end)}` : ''}`;
}

const select = 'h-9 rounded-lg border border-line bg-surface px-2 text-sm';
const input = 'h-9 rounded-lg border border-line bg-surface px-2 text-sm';

/**
 * Repeat settings for an event, task or card: how often (every N days/weeks/months/years), between
 * which dates, whether it resets on each new date or once it's done, and what it goes back to.
 */
export function RepeatEditor({
  value,
  onChange,
  defaultStart,
  kind,
  fields,
}: {
  value: RepeatRule | null;
  onChange: (rule: RepeatRule | null) => void;
  defaultStart: string;
  /** 'event' (no status), 'task' (has a status), or 'card' (a database row). */
  kind: 'event' | 'task' | 'card';
  fields?: CardField[];
}) {
  const on = !!value;
  const rule: RepeatRule = value ?? { unit: 'week', every: 1, start: defaultStart, end: null, when: 'date' };
  const set = (patch: Partial<RepeatRule>) => onChange({ ...rule, ...patch });

  const dateFields = (fields ?? []).filter((f) => f.type === 'date');
  const statusFields = (fields ?? []).filter((f) => f.type === 'select' || f.type === 'checkbox');
  const statusField = statusFields.find((f) => f.id === rule.statusField) ?? null;

  return (
    <div className="rounded-xl border border-line p-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            if (!e.target.checked) return onChange(null);
            const base: RepeatRule = { ...rule };
            if (kind === 'task') base.resetStatus = 'todo';
            if (kind === 'card') {
              base.dateField = dateFields[0]?.id;
              const status = statusFields.find((f) => f.type === 'select') ?? statusFields[0];
              if (status) {
                base.statusField = status.id;
                base.resetTo = status.type === 'checkbox' ? false : status.options?.[0]?.id;
                base.doneValue = status.type === 'checkbox' ? true : status.options?.[status.options.length - 1]?.id;
              }
            }
            onChange(base);
          }}
        />
        <Repeat size={15} className="text-muted" /> Repeat
      </label>

      {on && (
        <div className="mt-3 space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Every</span>
            <input
              type="number"
              min={1}
              max={999}
              value={rule.every}
              onChange={(e) => set({ every: Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1))) })}
              className={clsx(input, 'w-20')}
              aria-label="Repeat every"
            />
            <select value={rule.unit} onChange={(e) => set({ unit: e.target.value as RepeatUnit })} className={select} aria-label="Unit">
              {UNITS.map((u) => (
                <option key={u.id} value={u.id}>
                  {rule.every === 1 ? u.one : u.many}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Starts on</span>
              <input type="date" value={rule.start} onChange={(e) => e.target.value && set({ start: e.target.value })} className={clsx(input, 'w-full')} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Stops after</span>
              <div className="flex gap-2">
                <select value={rule.end ? 'on' : 'never'} onChange={(e) => set({ end: e.target.value === 'never' ? null : rule.end ?? rule.start })} className={select}>
                  <option value="never">Never</option>
                  <option value="on">A date</option>
                </select>
                {rule.end && <input type="date" min={rule.start} value={rule.end} onChange={(e) => set({ end: e.target.value || null })} className={clsx(input, 'min-w-0 flex-1')} />}
              </div>
            </label>
          </div>

          {kind !== 'event' && (
            <div>
              <span className="mb-1 block text-xs text-muted">Resets</span>
              <div className="flex flex-col gap-1.5 sm:flex-row">
                {(
                  [
                    ['date', 'On each new date'],
                    ['done', 'As soon as it’s done'],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id} className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="radio" checked={rule.when === id} onChange={() => set({ when: id })} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {kind === 'task' && (
            <label className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Status goes back to</span>
              <select value={rule.resetStatus ?? 'todo'} onChange={(e) => set({ resetStatus: e.target.value as TaskStatus })} className={select}>
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          )}

          {kind === 'card' && (
            <div className="space-y-2">
              {dateFields.length === 0 ? (
                <div className="rounded-lg bg-sidebar px-3 py-2 text-muted">Add a Date property to this database so the card has a date to repeat on.</div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted">Date that moves</span>
                    <select value={rule.dateField ?? ''} onChange={(e) => set({ dateField: e.target.value })} className={clsx(select, 'w-full')}>
                      {dateFields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted">End date (keeps its length)</span>
                    <select value={rule.endField ?? ''} onChange={(e) => set({ endField: e.target.value || null })} className={clsx(select, 'w-full')}>
                      <option value="">None</option>
                      {dateFields
                        .filter((f) => f.id !== rule.dateField)
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted">Status property</span>
                  <select
                    value={rule.statusField ?? ''}
                    onChange={(e) => {
                      const f = statusFields.find((x) => x.id === e.target.value);
                      set({
                        statusField: f?.id ?? null,
                        resetTo: f ? (f.type === 'checkbox' ? false : f.options?.[0]?.id) : undefined,
                        doneValue: f ? (f.type === 'checkbox' ? true : f.options?.[f.options.length - 1]?.id) : undefined,
                      });
                    }}
                    className={clsx(select, 'w-full')}
                  >
                    <option value="">None</option>
                    {statusFields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
                {statusField && (
                  <>
                    <StatusValue label="Goes back to" field={statusField} value={rule.resetTo} onChange={(v) => set({ resetTo: v })} />
                    {rule.when === 'done' && <StatusValue label="Counts as done" field={statusField} value={rule.doneValue} onChange={(v) => set({ doneValue: v })} />}
                  </>
                )}
              </div>
              <label className="flex items-center gap-2 text-muted">
                <input type="checkbox" checked={!!rule.untick} onChange={(e) => set({ untick: e.target.checked })} />
                Also untick its checklists and checkboxes
              </label>
            </div>
          )}

          <div className="text-xs text-faint">{describeRepeat(rule)}</div>
        </div>
      )}
    </div>
  );
}

function StatusValue({ label, field, value, onChange }: { label: string; field: CardField; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {field.type === 'checkbox' ? (
        <select value={value === true ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === 'on')} className={clsx(select, 'w-full')}>
          <option value="off">Unchecked</option>
          <option value="on">Checked</option>
        </select>
      ) : (
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)} className={clsx(select, 'w-full')}>
          <option value="">Empty</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}
