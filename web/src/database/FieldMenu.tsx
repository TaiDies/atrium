import clsx from 'clsx';
import { ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUp, ChevronRight, Copy, EyeOff, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Anchor, confirmDialog, MenuDivider, MenuItem, Popover } from '../components/ui';
import { FieldIcon } from './cells';
import { AiFieldSettings } from './AiFill';
import { useDb } from './context';
import { CONFIG_TYPES, FieldConfig, type FieldExtra, refreshRelated } from './FieldConfig';
import { FIELD_TYPES, type Field, fieldKind, type FieldType, fieldTypeLabel, type View } from './model';

/** Edit a property: name, type, sorting, visibility, position, delete. */
export function FieldMenu({ field: opened, view, anchor, onClose }: { field: Field | null; view?: View; anchor: Anchor | null; onClose: () => void }) {
  const { db, actions } = useDb();
  // The property as it is now (the one passed in is how it was when the menu opened), so settings
  // changed in the menu show straight away.
  const field = (opened && db.fields.find((f) => f.id === opened.id)) ?? opened;
  const [name, setName] = useState('');
  const [typesOpen, setTypesOpen] = useState(false);

  useEffect(() => {
    if (field) setName(field.name);
    setTypesOpen(false);
  }, [field?.id, anchor]);

  if (!field) return null;
  const index = db.fields.findIndex((f) => f.id === field.id);
  const commitName = () => name.trim() && name !== field.name && actions.updateField(field.id, { name: name.trim() });
  const close = () => {
    commitName();
    onClose();
  };
  const sort = (dir: 'asc' | 'desc') => {
    if (!view) return;
    actions.updateView(view.id, { sorts: [{ fieldId: field.id, dir }, ...view.sorts.filter((s) => s.fieldId !== field.id)] });
    close();
  };

  return (
    <Popover anchor={anchor} onClose={close} className="w-60 p-1">
      <div className="p-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && close()}
          className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
        />
      </div>
      {CONFIG_TYPES.has(field.type) && (
        <details
          open={field.type === 'button' ? !field.button?.actions.length : !field.relation && !field.rollup && field.formula === undefined}
          className="mx-1 mb-1 rounded-md border border-line"
        >
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-muted">
            {field.type === 'relation' ? 'Relation settings' : field.type === 'rollup' ? 'Rollup settings' : field.type === 'button' ? 'What it does' : 'Formula'}
          </summary>
          <FieldConfig
            type={field.type}
            field={field}
            onSave={(extra) => {
              const { id: _, ...config } = extra;
              actions.updateField(field.id, config);
              refreshRelated();
              close();
            }}
          />
        </details>
      )}
      {field.type === 'media' && (
        <label className="mx-1 mb-1 flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 text-xs hover:bg-hover">
          <input type="checkbox" checked={!!field.autoFiles} onChange={(e) => actions.updateField(field.id, { autoFiles: e.target.checked || undefined })} className="mt-0.5" />
          <span>
            <span className="block text-sm text-fg">Include files from the card's page</span>
            <span className="text-muted">Every file and image attached in each card's blocks shows here too.</span>
          </span>
        </label>
      )}
      {field.type === 'select' && (field.options?.length ?? 0) > 0 && (
        <div className="mx-1 mb-1 space-y-1.5 rounded-md px-1.5 py-1.5 text-xs">
          <div className="text-sm text-fg">When the card's tasks are done</div>
          <label className="flex items-center gap-2 text-muted">
            <span className="w-24 shrink-0">Set to</span>
            <select
              value={field.taskDone ?? ''}
              onChange={(e) =>
                actions.updateField(field.id, {
                  taskDone: e.target.value || undefined,
                  ...(e.target.value ? {} : { taskUndone: undefined }),
                  // The older all-groups setting is replaced by the chosen option.
                  followTasks: undefined,
                })
              }
              className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-xs text-fg"
            >
              <option value="">Don't change</option>
              {field.options!.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || 'Untitled'}
                </option>
              ))}
            </select>
          </label>
          {field.taskDone && (
            <label className="flex items-center gap-2 text-muted">
              <span className="w-24 shrink-0">If reopened, to</span>
              <select
                value={field.taskUndone ?? ''}
                onChange={(e) => actions.updateField(field.id, { taskUndone: e.target.value || undefined })}
                className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-xs text-fg"
              >
                <option value="">Keep as it is</option>
                {field.options!
                  .filter((o) => o.id !== field.taskDone)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name || 'Untitled'}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <p className="text-faint">
            {field.followTasks && !field.taskDone
              ? 'Now: moves between To-do, In progress and Complete with the tasks. Pick an option to use it instead.'
              : 'Applies once every task inside a card is done (tasks added in the card’s page).'}
          </p>
        </div>
      )}
      {field.type === 'ai' && <AiFieldSettings field={field} />}
      {field.type === 'unique_id' && (
        <label className="mx-1 mb-1 flex items-center gap-2 px-1.5 text-xs text-muted">
          Prefix
          <input
            defaultValue={field.prefix ?? ''}
            placeholder="e.g. TASK"
            maxLength={12}
            onBlur={(e) => actions.updateField(field.id, { prefix: e.target.value.trim().toUpperCase() || undefined })}
            className="h-7 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
          />
        </label>
      )}
      {!field.primary && !field.relation?.reverse && (
        <button
          onClick={() => setTypesOpen(!typesOpen)}
          className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-start text-sm hover:bg-hover"
        >
          <FieldIcon type={fieldKind(field)} className="text-muted" />
          <span className="flex-1">{fieldTypeLabel(fieldKind(field))}</span>
          <ChevronRight size={14} className={clsx('text-faint transition-transform', typesOpen && 'rotate-90')} />
        </button>
      )}
      {typesOpen && (
        <div className="mb-1 ms-3 border-s border-line ps-1">
          {FIELD_TYPES.map((t) => (
            <button
              key={t.type}
              onClick={() => {
                actions.changeFieldType(field.id, t.type as FieldType);
                setTypesOpen(false);
              }}
              className={clsx('flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-hover', t.type === fieldKind(field) && 'text-accent')}
            >
              <FieldIcon type={t.type} />
              {t.label}
            </button>
          ))}
        </div>
      )}
      <MenuDivider />
      {view && (
        <>
          <MenuItem icon={<ArrowUp size={15} />} label="Sort ascending" onClick={() => sort('asc')} />
          <MenuItem icon={<ArrowDown size={15} />} label="Sort descending" onClick={() => sort('desc')} />
          {!field.primary && (
            <MenuItem
              icon={<EyeOff size={15} />}
              label="Hide in this view"
              onClick={() => {
                actions.updateView(view.id, { hidden: [...view.hidden, field.id] });
                close();
              }}
            />
          )}
          <MenuDivider />
        </>
      )}
      <MenuItem
        icon={<ArrowLeftToLine size={15} />}
        label="Insert left"
        onClick={() => {
          actions.addField('text', undefined, Math.max(index, field.primary ? 1 : index));
          close();
        }}
      />
      <MenuItem
        icon={<ArrowRightToLine size={15} />}
        label="Insert right"
        onClick={() => {
          actions.addField('text', undefined, index + 1);
          close();
        }}
      />
      {!field.primary && (
        <>
          <MenuItem
            icon={<Copy size={15} />}
            label="Duplicate"
            onClick={() => {
              actions.duplicateField(field.id);
              close();
            }}
          />
          <MenuItem
            icon={<Trash2 size={15} />}
            label="Delete property"
            danger
            onClick={async () => {
              onClose();
              if (await confirmDialog({ title: `Delete “${field.name}”?`, message: 'Its values will be removed from every row.', confirmLabel: 'Delete', danger: true })) {
                actions.deleteField(field.id);
              }
            }}
          />
        </>
      )}
    </Popover>
  );
}

/** Pick the type (and name) for a new property. */
export function NewFieldMenu({
  anchor,
  onClose,
  onCreate,
}: {
  anchor: Anchor | null;
  onClose: () => void;
  onCreate: (type: FieldType, name: string, extra?: FieldExtra) => void;
}) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState<FieldType | null>(null);
  useEffect(() => {
    setName('');
    setPending(null);
  }, [anchor]);
  if (pending) {
    return (
      <Popover anchor={anchor} onClose={onClose} align="end" className="w-72 p-1">
        <div className="flex items-center gap-2 px-1.5 pt-1.5">
          <button onClick={() => setPending(null)} className="text-xs text-muted hover:text-fg">
            ← Back
          </button>
          <span className="flex-1 truncate text-sm font-medium">{name.trim() || fieldTypeLabel(pending)}</span>
        </div>
        <FieldConfig
          type={pending}
          onSave={(extra) => {
            onCreate(pending, name.trim() || fieldTypeLabel(pending), extra);
            refreshRelated();
            onClose();
          }}
        />
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="w-56 p-1">
      <div className="p-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onCreate('text', name.trim() || 'Text');
              onClose();
            }
          }}
          placeholder="Property name"
          className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
        />
      </div>
      <div className="px-2 pt-1 pb-1 text-xs font-medium text-faint">Type</div>
      {FIELD_TYPES.map((t) => (
        <button
          key={t.type}
          onClick={() => {
            if (CONFIG_TYPES.has(t.type)) return setPending(t.type);
            onCreate(t.type, name.trim() || t.label);
            onClose();
          }}
          className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-start text-sm hover:bg-hover"
        >
          <FieldIcon type={t.type} className="text-muted" />
          {t.label}
        </button>
      ))}
    </Popover>
  );
}
