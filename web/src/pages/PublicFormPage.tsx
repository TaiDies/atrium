import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useParams } from 'react-router';
import { Button, FullScreenSpinner } from '../components/ui';
import { api, APP_NAME } from '../lib/api';

interface PublicField {
  id: string;
  name: string;
  type: string;
  required: boolean;
  options?: { id: string; name: string }[];
}

interface PublicForm {
  title: string;
  description: string;
  submitText: string;
  fields: PublicField[];
}

/** A published form, filled in without an account. */
export function PublicFormPage() {
  const { pageId, viewId } = useParams();
  const form = useQuery({
    queryKey: ['public-form', pageId, viewId],
    queryFn: async () => (await api<{ form: PublicForm }>(`/api/public/forms/${pageId}/${viewId}`)).form,
    retry: false,
  });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  if (form.isPending) return <FullScreenSpinner />;
  if (!form.data) {
    return (
      <div className="flex min-h-full items-center justify-center bg-sidebar p-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">This form isn't available</h1>
          <p className="mt-1 text-sm text-muted">It may have been unpublished or deleted.</p>
        </div>
      </div>
    );
  }

  const f = form.data;
  const set = (id: string, v: unknown) => setValues((prev) => ({ ...prev, [id]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSending(true);
    try {
      await api(`/api/public/forms/${pageId}/${viewId}`, { method: 'POST', body: { values } });
      setDone(true);
      setValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your response');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-full bg-sidebar px-4 py-8 sm:py-14">
      <div className="mx-auto max-w-[640px]">
        {done ? (
          <div className="rounded-xl border-t-4 border-accent bg-surface p-8 text-center shadow-sm ring-1 ring-line">
            <CheckCircle2 size={40} className="mx-auto text-green-500" />
            <h1 className="mt-3 text-xl font-semibold">Thanks! Your response was recorded.</h1>
            <button onClick={() => setDone(false)} className="mt-4 text-sm font-medium text-accent hover:underline">
              Submit another response
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="rounded-xl border-t-4 border-accent bg-surface p-5 shadow-sm ring-1 ring-line sm:p-6">
              <h1 className="text-2xl font-bold">{f.title}</h1>
              {f.description && <p className="mt-2 text-sm whitespace-pre-wrap text-muted">{f.description}</p>}
              {f.fields.some((x) => x.required) && <p className="mt-3 text-xs text-danger">* Required</p>}
            </div>
            {f.fields.map((field) => (
              <div key={field.id} className="rounded-xl bg-surface p-5 shadow-sm ring-1 ring-line">
                <label className="block font-medium">
                  {field.name} {field.required && <span className="text-danger">*</span>}
                </label>
                <div className="mt-3">
                  <FieldInput field={field} value={values[field.id]} onChange={(v) => set(field.id, v)} />
                </div>
              </div>
            ))}
            {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              <Button type="submit" variant="primary" loading={sending} className="min-w-28">
                {f.submitText}
              </Button>
              <span className="text-xs text-faint">Powered by {APP_NAME}</span>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: PublicField; value: unknown; onChange: (v: unknown) => void }) {
  const input = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft sm:text-sm';
  switch (field.type) {
    case 'number':
      return <input type="number" inputMode="decimal" className={input} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} required={field.required} />;
    case 'date':
      return <input type="date" className={input} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} required={field.required} />;
    case 'url':
      return <input type="url" inputMode="url" placeholder="https://" className={input} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} required={field.required} />;
    case 'checkbox':
      return (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-[var(--accent)]" /> Yes
        </label>
      );
    case 'select':
    case 'multi_select': {
      const multi = field.type === 'multi_select';
      const selected = multi ? ((value as string[] | undefined) ?? []) : value;
      return (
        <div className="flex flex-wrap gap-2">
          {field.options?.map((o) => {
            const on = multi ? (selected as string[]).includes(o.id) : selected === o.id;
            return (
              <button
                type="button"
                key={o.id}
                onClick={() => onChange(multi ? (on ? (selected as string[]).filter((x) => x !== o.id) : [...(selected as string[]), o.id]) : on ? null : o.id)}
                className={clsx('rounded-full border px-3.5 py-1.5 text-sm transition-colors', on ? 'border-accent bg-accent text-white' : 'border-line hover:bg-hover')}
              >
                {o.name}
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return <textarea rows={3} className={input} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} required={field.required} placeholder="Your answer" />;
  }
}
