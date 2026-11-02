import clsx from 'clsx';
import { CalendarCheck2, CalendarDays, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useApp } from '../app/context';
import { LocationList, PlacePicker } from '../components/Placement';
import { Button, confirmDialog, Dialog, IconButton, Input, toast, toastError } from '../components/ui';
import type { PlaceTarget } from '../lib/placement';
import {
  type CalendarEvent,
  COLOR_HEX,
  createEvent,
  deleteEvent,
  EVENT_COLORS,
  type EventColor,
  type EventInput,
  placeEvent,
  REMINDERS,
  STATUS_LABELS,
  type TaskStatus,
  updateEvent,
  useEvent,
} from './api';
import { RepeatEditor } from './RepeatEditor';
import type { RepeatRule } from './repeat';

export interface EventDraft {
  startDate: string;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
  title?: string;
  status?: TaskStatus | null;
}

const input = 'h-9 rounded-lg border border-line bg-surface px-2 text-sm';

/**
 * Creating or editing a calendar event or task. A new event can be put straight onto a page
 * (`place`, used by the "/" menu); an existing one shows where it's used and can be moved.
 */
export function EventDialog({
  eventId,
  draft,
  place,
  onClose,
  onCreated,
}: {
  eventId: string | null;
  draft?: EventDraft;
  place?: PlaceTarget;
  onClose: () => void;
  onCreated?: (event: CalendarEvent) => void;
}) {
  const { workspace, user } = useApp();
  const [id, setId] = useState(eventId);
  const existing = useEvent(id);
  const ev = existing.data;
  const [form, setForm] = useState<Required<Omit<EventInput, 'repeat'>> & { repeat: RepeatRule | null }>({
    title: draft?.title ?? '',
    description: '',
    startDate: draft?.startDate ?? new Date().toISOString().slice(0, 10),
    startTime: draft?.startTime ?? null,
    endDate: draft?.endDate ?? null,
    endTime: draft?.endTime ?? null,
    color: 'blue',
    status: draft?.status ?? null,
    repeat: null,
    reminder: null,
  });
  const [saving, setSaving] = useState(false);

  // Fill the form once the event has loaded.
  useEffect(() => {
    if (!ev) return;
    setForm({
      title: ev.title,
      description: ev.description,
      startDate: ev.startDate,
      startTime: ev.startTime,
      endDate: ev.endDate,
      endTime: ev.endTime,
      color: ev.color,
      status: ev.status,
      repeat: ev.repeat,
      reminder: ev.reminder,
    });
  }, [ev?.id, ev?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const allDay = form.startTime === null;
  const isTask = form.status !== null;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (form.endDate && form.endDate < form.startDate) return toast('The end is before the start', 'error');
    setSaving(true);
    try {
      const body: EventInput = { ...form, endTime: allDay ? null : form.endTime, title: form.title.trim() };
      if (id) {
        await updateEvent(workspace.id, id, body);
        toast('Saved');
        onClose();
      } else {
        const created = await createEvent(workspace.id, { ...body, startDate: form.startDate }, place);
        onCreated?.(created);
        if (place) onClose();
        else {
          // Stay open so it can be attached to a page straight away.
          setId(created.id);
          toast('Event added');
        }
      }
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id) return onClose();
    const ok = await confirmDialog({
      title: `Delete “${form.title || 'Untitled'}”?`,
      message: ev?.locations.length ? 'It will also be removed from the pages and cards it is on.' : undefined,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteEvent(workspace.id, id);
      toast('Deleted');
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  const canDelete = !id || workspace.role === 'owner' || ev?.createdBy === user.id;

  return (
    <Dialog open onClose={onClose} width={600} top="5vh" maxHeight="90vh" className="flex flex-col">
      <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          {isTask ? <CalendarCheck2 size={17} className="text-muted" /> : <CalendarDays size={17} className="text-muted" />}
          <h2 className="flex-1 text-[15px] font-semibold">{id ? (isTask ? 'Task' : 'Event') : isTask ? 'New task' : 'New event'}</h2>
          <IconButton type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Input autoFocus={!id} value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Title" className="h-11 w-full text-base font-medium" maxLength={500} />

          <div className="flex flex-wrap gap-2">
            <div className="inline-flex rounded-lg border border-line p-0.5">
              {(['event', 'task'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set({ status: k === 'task' ? (form.status ?? 'todo') : null, repeat: form.repeat && k === 'task' ? { ...form.repeat, resetStatus: form.repeat.resetStatus ?? 'todo' } : form.repeat })}
                  className={clsx('h-8 rounded-md px-3 text-sm', (k === 'task') === isTask ? 'bg-active font-medium' : 'text-muted hover:text-fg')}
                >
                  {k === 'task' ? 'Task' : 'Event'}
                </button>
              ))}
            </div>
            {isTask && (
              <div className="inline-flex rounded-lg border border-line p-0.5">
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((s) => (
                  <button key={s} type="button" onClick={() => set({ status: s })} className={clsx('h-8 rounded-md px-3 text-sm', form.status === s ? 'bg-active font-medium' : 'text-muted hover:text-fg')}>
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => set(e.target.checked ? { startTime: null, endTime: null } : { startTime: '09:00', endTime: '10:00' })}
              />
              All day
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-xs text-muted">Starts</span>
                <div className="flex gap-2">
                  <input type="date" value={form.startDate} onChange={(e) => e.target.value && set({ startDate: e.target.value })} className={clsx(input, 'min-w-0 flex-1')} required />
                  {!allDay && <input type="time" value={form.startTime ?? ''} onChange={(e) => set({ startTime: e.target.value || null })} className={clsx(input, 'w-28')} />}
                </div>
              </div>
              <div>
                <span className="mb-1 block text-xs text-muted">Ends</span>
                <div className="flex gap-2">
                  <input
                    type="date"
                    min={form.startDate}
                    value={form.endDate ?? ''}
                    onChange={(e) => set({ endDate: e.target.value || null })}
                    className={clsx(input, 'min-w-0 flex-1')}
                  />
                  {!allDay && <input type="time" value={form.endTime ?? ''} onChange={(e) => set({ endTime: e.target.value || null })} className={clsx(input, 'w-28')} />}
                </div>
              </div>
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs text-muted">Color</span>
            <div className="flex flex-wrap gap-2">
              {EVENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set({ color: c as EventColor })}
                  aria-label={c}
                  className={clsx('size-7 rounded-full ring-offset-2 ring-offset-surface', form.color === c && 'ring-2 ring-fg')}
                  style={{ background: COLOR_HEX[c] }}
                />
              ))}
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs text-muted">Reminder{allDay ? ' (all-day events remind from 9:00)' : ''}</span>
            <select
              value={form.reminder === null ? '' : String(form.reminder)}
              onChange={(e) => set({ reminder: e.target.value === '' ? null : Number(e.target.value) })}
              className={clsx(input, 'w-full sm:w-64')}
            >
              {REMINDERS.map((r) => (
                <option key={r.label} value={r.value === null ? '' : String(r.value)}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <textarea
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Notes"
            rows={3}
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />

          <RepeatEditor value={form.repeat} onChange={(repeat) => set({ repeat })} defaultStart={form.startDate} kind={isTask ? 'task' : 'event'} />

          {id && ev && (
            <>
              <LocationList
                locations={ev.locations}
                empty="Not on any page. Attach it to a block below, or leave it on the calendar only."
                onOpen={onClose}
                onRemoveAll={async () => {
                  try {
                    await placeEvent(workspace.id, id, null);
                    toast('Removed from pages');
                  } catch (err) {
                    toastError(err);
                  }
                }}
              />
              <PlacePicker
                title={ev.locations.length ? 'Move to a block' : 'Attach to a block'}
                hasLocations={ev.locations.length > 0}
                hideBlock={(b) => b.type === 'event' && b.text === ev.title}
                onPlace={async (target, keep) => {
                  try {
                    await placeEvent(workspace.id, id, target, keep);
                    toast(keep ? 'Added to the page' : 'Moved');
                  } catch (err) {
                    toastError(err);
                    throw err;
                  }
                }}
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          {canDelete && id && (
            <Button type="button" variant="ghost" onClick={remove} className="text-danger">
              <Trash2 size={15} /> Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="ghost" onClick={onClose}>
            {id ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : id ? 'Save' : 'Add'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
