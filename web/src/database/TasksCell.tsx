import clsx from 'clsx';
import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import { toastError } from '../components/ui';
import { api } from '../lib/api';
import { queryClient } from '../lib/queries';
import type { TaskItem } from './model';

const NEXT: Record<TaskItem['status'], TaskItem['status']> = { todo: 'done', doing: 'done', done: 'todo' };

function StatusIcon({ status }: { status: TaskItem['status'] }) {
  if (status === 'done') return <CheckCircle2 size={14} className="shrink-0 text-accent" />;
  if (status === 'doing') return <CircleDot size={14} className="shrink-0 text-amber-500" />;
  return <Circle size={14} className="shrink-0 text-faint" />;
}

/** A card's tasks at a glance: how many are done, as a bar and a count. */
export function TasksBar({ items }: { items: TaskItem[] }) {
  const done = items.filter((t) => t.status === 'done').length;
  const all = done === items.length;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted" title={items.map((t) => `${t.status === 'done' ? '✓' : '○'} ${t.title || 'Untitled'}`).join('\n')}>
      {all ? <CheckCircle2 size={13} className="text-accent" /> : <Circle size={13} className="text-faint" />}
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-hover">
        <span className={clsx('block h-full rounded-full', all ? 'bg-accent' : 'bg-accent/60')} style={{ width: `${(done / items.length) * 100}%` }} />
      </span>
      {done}/{items.length}
    </span>
  );
}

/** The list of a card's tasks; ticking one off marks it done everywhere (calendar, Today, the card). */
export function TasksList({ items, pageId, readOnly }: { items: TaskItem[]; pageId: string; readOnly?: boolean }) {
  if (!items.length) return <p className="px-1 py-1.5 text-xs text-muted">No tasks in this card yet. Add a task inside the card's page and it shows here.</p>;
  const toggle = async (t: TaskItem) => {
    try {
      await api(`/api/events/${t.id}`, { method: 'PATCH', body: { status: NEXT[t.status] } });
      queryClient.invalidateQueries({ queryKey: ['card-tasks', pageId] });
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div className="flex flex-col">
      {items.map((t) => (
        <button
          key={t.id}
          disabled={readOnly}
          onClick={() => toggle(t)}
          className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start text-sm hover:bg-hover disabled:cursor-default"
        >
          <StatusIcon status={t.status} />
          <span className={clsx('flex-1 truncate', t.status === 'done' && 'text-muted line-through')}>{t.title || 'Untitled'}</span>
          <span className="text-xs text-faint">{t.startDate}</span>
        </button>
      ))}
    </div>
  );
}
