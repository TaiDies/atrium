import { publicOrigin } from '../lib/native';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Copy, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { type Anchor, Menu, MenuDivider, MenuItem, MenuLabel, toast } from '../components/ui';
import { FieldIcon } from './cells';
import { useDb } from './context';
import { FIELD_TYPES, FORM_FIELD_TYPES, type FieldType, type FormSettings, type View, fieldKind } from './model';

const DEFAULT_FORM: FormSettings = { published: false, title: 'Form', description: '', submitText: 'Submit', items: [] };

export function formUrl(pageId: string, viewId: string) {
  return `${publicOrigin()}/form/${pageId}/${viewId}`;
}

/** Build a form from the database's properties; every submission becomes a new row. */
export function FormBuilderView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, pageId, readOnly } = useDb();
  const form = view.form ?? DEFAULT_FORM;
  const [addMenu, setAddMenu] = useState<Anchor | null>(null);
  const set = (patch: Partial<FormSettings>) => actions.updateView(view.id, { form: { ...form, ...patch } });
  const items = form.items.filter((i) => db.fields.some((f) => f.id === i.fieldId));
  const unused = db.fields.filter((f) => FORM_FIELD_TYPES.has(f.type) && !items.some((i) => i.fieldId === f.id));
  const url = formUrl(pageId, view.id);

  const move = (index: number, dir: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + dir, 0, item);
    set({ items: next });
  };

  return (
    <div className={clsx('pt-4 pb-10', !embedded && 'px-6 sm:px-[54px]')}>
      <div className="mx-auto max-w-[680px] space-y-3">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-sidebar p-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input type="checkbox" disabled={readOnly} checked={form.published} onChange={(e) => set({ published: e.target.checked })} className="size-4 accent-[var(--accent)]" />
            {form.published ? 'Published — anyone with the link can respond' : 'Not published'}
          </label>
          {form.published && (
            <div className="ms-auto flex gap-1">
              <button
                onClick={() => navigator.clipboard.writeText(url).then(() => toast('Form link copied'), () => toast('Could not copy the link', 'error'))}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-accent hover:bg-accent-soft"
              >
                <Copy size={14} /> Copy link
              </button>
              <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-accent hover:bg-accent-soft">
                <ExternalLink size={14} /> Open
              </a>
            </div>
          )}
        </div>

        <div className="rounded-xl border-t-4 border-accent bg-card p-5 shadow-sm ring-1 ring-line">
          <input
            value={form.title}
            readOnly={readOnly}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Form title"
            className="w-full bg-transparent text-2xl font-bold outline-none placeholder:text-faint"
          />
          <textarea
            value={form.description}
            readOnly={readOnly}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Description (optional)"
            rows={2}
            className="mt-2 w-full resize-none bg-transparent text-sm text-muted outline-none placeholder:text-faint"
          />
        </div>

        {items.map((item, index) => {
          const field = db.fields.find((f) => f.id === item.fieldId)!;
          return (
            <div key={item.fieldId} className="group rounded-xl bg-card p-4 shadow-sm ring-1 ring-line">
              <div className="flex items-center gap-2">
                <FieldIcon type={fieldKind(field)} className="text-muted" />
                <input
                  value={field.name}
                  readOnly={readOnly}
                  onChange={(e) => actions.updateField(field.id, { name: e.target.value })}
                  className="min-w-0 flex-1 bg-transparent font-medium outline-none"
                />
                {item.required && <span className="text-danger">*</span>}
                {!readOnly && (
                  <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                    <button disabled={index === 0} onClick={() => move(index, -1)} className="rounded p-1 hover:bg-hover disabled:opacity-30" title="Move up">
                      <ArrowUp size={14} />
                    </button>
                    <button disabled={index === items.length - 1} onClick={() => move(index, 1)} className="rounded p-1 hover:bg-hover disabled:opacity-30" title="Move down">
                      <ArrowDown size={14} />
                    </button>
                    <button onClick={() => set({ items: items.filter((i) => i.fieldId !== item.fieldId) })} className="rounded p-1 hover:bg-hover hover:text-danger" title="Remove question">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
              <QuestionPreview type={field.type} options={field.options?.map((o) => o.name) ?? []} />
              {!readOnly && (
                <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={item.required}
                    onChange={(e) => set({ items: items.map((i) => (i.fieldId === item.fieldId ? { ...i, required: e.target.checked } : i)) })}
                    className="accent-[var(--accent)]"
                  />
                  Required
                </label>
              )}
            </div>
          );
        })}

        {!readOnly && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              onClick={(e) => setAddMenu(e.currentTarget.getBoundingClientRect())}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
            >
              <Plus size={15} /> Add question
            </button>
            <label className="flex items-center gap-2 text-xs text-muted">
              Button text
              <input value={form.submitText} onChange={(e) => set({ submitText: e.target.value })} className="h-7 w-28 rounded-md border border-line bg-bg px-2 text-sm text-fg outline-none focus:border-accent" />
            </label>
          </div>
        )}
        <p className="text-center text-xs text-faint">Each response is added as a new row — open the Responses or Grid view to see them.</p>
      </div>

      <Menu anchor={addMenu} onClose={() => setAddMenu(null)}>
        {unused.length > 0 && (
          <>
            <MenuLabel>Existing properties</MenuLabel>
            {unused.map((f) => (
              <MenuItem key={f.id} icon={<FieldIcon type={fieldKind(f)} />} label={f.name} onClick={() => set({ items: [...items, { fieldId: f.id, required: false }] })} />
            ))}
            <MenuDivider />
          </>
        )}
        <MenuLabel>New question</MenuLabel>
        {FIELD_TYPES.filter((t) => FORM_FIELD_TYPES.has(t.type)).map((t) => (
          <MenuItem
            key={t.type}
            icon={<FieldIcon type={t.type} />}
            label={t.label}
            onClick={() => {
              const id = actions.addField(t.type as FieldType, 'Question');
              if (id) set({ items: [...items, { fieldId: id, required: false }] });
            }}
          />
        ))}
      </Menu>
    </div>
  );
}

function QuestionPreview({ type, options }: { type: FieldType; options: string[] }) {
  const box = 'mt-3 h-9 w-full rounded-md border border-line bg-bg px-3 text-sm leading-9 text-faint';
  if (type === 'checkbox') return <div className="mt-3 flex items-center gap-2 text-sm text-faint"><span className="size-4 rounded border border-faint" /> Yes</div>;
  if (type === 'select' || type === 'multi_select') {
    return (
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(options.length ? options : ['Add options in the Grid view']).map((o) => (
          <span key={o} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted">{o}</span>
        ))}
      </div>
    );
  }
  return <div className={box}>{type === 'date' ? 'Pick a date' : type === 'number' ? 'Number' : type === 'url' ? 'https://…' : 'Answer'}</div>;
}
