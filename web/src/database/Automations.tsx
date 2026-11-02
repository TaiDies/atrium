import clsx from 'clsx';
import { Plus, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '../components/ui';
import { useDirectory } from '../lib/directory';
import { useDb } from './context';
import { type Automation, type Field, fieldKind, type FieldType, newId } from './model';

// "When … then …" rules for a database. They're stored with the database and run by the server, so
// cards added from forms, the API or the AI count too.

type Action = Automation['actions'][number];

const SETTABLE = new Set<FieldType>(['text', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone', 'person']);
const WATCHABLE = new Set<FieldType>(['text', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone', 'person', 'relation', 'checklist']);
const control = 'h-7 min-w-0 rounded border border-line bg-bg px-1.5 text-xs';

/** A value picker that fits the property (options, ticked or not, people, today…). */
function ValueInput({ field, value, onChange, allowAny }: { field: Field | undefined; value: unknown; onChange: (v: unknown) => void; allowAny?: boolean }) {
  const dir = useDirectory();
  if (!field) return null;
  const any = allowAny ? <option value="">anything</option> : <option value="">Empty</option>;
  if (field.type === 'select' || field.type === 'multi_select') {
    const v = Array.isArray(value) ? value[0] : value;
    return (
      <select value={String(v ?? '')} onChange={(e) => onChange(e.target.value ? (field.type === 'multi_select' ? [e.target.value] : e.target.value) : allowAny ? undefined : null)} className={control}>
        {any}
        {field.options?.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <select value={value === undefined ? '' : value ? '1' : '0'} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === '1')} className={control}>
        {allowAny && <option value="">anything</option>}
        <option value="1">Checked</option>
        <option value="0">Unchecked</option>
      </select>
    );
  }
  if (field.type === 'person') {
    const v = Array.isArray(value) ? value[0] : value;
    return (
      <select value={String(v ?? '')} onChange={(e) => onChange(e.target.value === '@me' ? '@me' : e.target.value ? [e.target.value] : allowAny ? undefined : [])} className={control}>
        {allowAny ? <option value="">anyone</option> : <option value="">Nobody</option>}
        {!allowAny && <option value="@me">Whoever made the change</option>}
        {(dir?.members ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'date' && !allowAny) {
    return (
      <select value={value === '@today' ? '@today' : ''} onChange={(e) => onChange(e.target.value || null)} className={control}>
        <option value="@today">Today</option>
        <option value="">Empty</option>
      </select>
    );
  }
  if (allowAny) return <span className="text-xs text-muted">changes</span>;
  return <input value={String(value ?? '')} onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)} placeholder="Value" className={clsx(control, 'flex-1')} />;
}

function RuleEditor({ rule, onChange, onDelete }: { rule: Automation; onChange: (r: Automation) => void; onDelete: () => void }) {
  const { db } = useDb();
  const dir = useDirectory();
  const watchable = db.fields.filter((f) => WATCHABLE.has(fieldKind(f)));
  const settable = db.fields.filter((f) => SETTABLE.has(fieldKind(f)));
  const people = db.fields.filter((f) => f.type === 'person');
  const trigger = rule.trigger;
  const setAction = (i: number, a: Action) => onChange({ ...rule, actions: rule.actions.map((x, j) => (j === i ? a : x)) });

  return (
    <div className={clsx('rounded-lg border border-line p-3', !rule.enabled && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <Zap size={15} className="shrink-0 text-accent" />
        <input value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} placeholder="Name this automation" className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none" />
        <label className="flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={rule.enabled} onChange={(e) => onChange({ ...rule, enabled: e.target.checked })} /> On
        </label>
        <button onClick={onDelete} className="rounded p-1 text-muted hover:text-danger" title="Delete">
          <Trash2 size={14} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
        <span className="w-12 font-medium text-muted">When</span>
        <select
          value={trigger.type === 'added' ? '__added' : trigger.fieldId}
          onChange={(e) => onChange({ ...rule, trigger: e.target.value === '__added' ? { type: 'added' } : { type: 'changed', fieldId: e.target.value } })}
          className={control}
        >
          <option value="__added">a card is added</option>
          {watchable.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} changes
            </option>
          ))}
        </select>
        {trigger.type === 'changed' && (
          <>
            <span className="text-muted">to</span>
            <ValueInput field={db.fields.find((f) => f.id === trigger.fieldId)} value={trigger.value} allowAny onChange={(value) => onChange({ ...rule, trigger: { ...trigger, value } })} />
          </>
        )}
      </div>

      {rule.actions.map((a, i) => (
        <div key={i} className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
          <span className="w-12 font-medium text-muted">{i === 0 ? 'Then' : 'and'}</span>
          {a.type === 'set' ? (
            <>
              <span className="text-muted">set</span>
              <select value={a.fieldId} onChange={(e) => setAction(i, { type: 'set', fieldId: e.target.value, value: null })} className={control}>
                {settable.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <span className="text-muted">to</span>
              <ValueInput field={db.fields.find((f) => f.id === a.fieldId)} value={a.value} onChange={(value) => setAction(i, { ...a, value })} />
            </>
          ) : (
            <>
              <span className="text-muted">notify</span>
              <select
                value={a.personField ? `field:${a.personField}` : a.userIds[0] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setAction(i, v.startsWith('field:') ? { ...a, personField: v.slice(6), userIds: [] } : { ...a, personField: null, userIds: v ? [v] : [] });
                }}
                className={control}
              >
                <option value="">Choose…</option>
                {people.map((f) => (
                  <option key={f.id} value={`field:${f.id}`}>
                    people in “{f.name}”
                  </option>
                ))}
                {(dir?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <input value={a.message} onChange={(e) => setAction(i, { ...a, message: e.target.value })} placeholder="Message" className={clsx(control, 'flex-1')} />
            </>
          )}
          <button onClick={() => onChange({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })} className="rounded px-1 text-muted hover:text-danger" aria-label="Remove">
            ✕
          </button>
        </div>
      ))}
      <div className="mt-2 flex gap-1 ps-[52px]">
        <button
          disabled={!settable.length}
          onClick={() => onChange({ ...rule, actions: [...rule.actions, { type: 'set', fieldId: settable[0].id, value: null }] })}
          className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover disabled:opacity-50"
        >
          + Set a property
        </button>
        <button onClick={() => onChange({ ...rule, actions: [...rule.actions, { type: 'notify', userIds: [], personField: null, message: '' }] })} className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover">
          + Notify someone
        </button>
      </div>
    </div>
  );
}

export function AutomationsDialog({ onClose }: { onClose: () => void }) {
  const { db, actions, readOnly } = useDb();
  const [rules, setRules] = useState<Automation[]>(() => structuredClone(db.settings.automations ?? []));
  const save = () => {
    actions.setSetting('automations', rules.length ? rules : null);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Automations" width={620} maxHeight="84vh" top="8vh">
      <div className="space-y-3 px-5 pb-5">
        <p className="text-sm text-muted">The server runs these whenever cards change — including cards added from forms, the AI assistant or the API.</p>
        {rules.map((r, i) => (
          <RuleEditor key={r.id} rule={r} onChange={(next) => setRules((rs) => rs.map((x, j) => (j === i ? next : x)))} onDelete={() => setRules((rs) => rs.filter((_, j) => j !== i))} />
        ))}
        {!rules.length && <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-muted">No automations yet.</p>}
        <div className="flex items-center justify-between pt-1">
          <Button size="sm" disabled={readOnly} onClick={() => setRules((rs) => [...rs, { id: newId(), name: '', enabled: true, trigger: { type: 'added' }, actions: [] }])}>
            <Plus size={14} /> New automation
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={readOnly} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
