import { ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../app/context';
import { PageIcon } from '../app/PageIcon';
import { Button, Dialog, IconButton, toast, toastError } from '../components/ui';
import { locationPath } from '../lib/placement';
import { type CalendarCard, setCardCells, setCardRepeat, useCard } from './api';
import { RepeatEditor } from './RepeatEditor';
import type { RepeatRule } from './repeat';

/** A database card seen from the calendar: its date, status and repeat settings. */
export function CardDialog({ card, onClose }: { card: CalendarCard; onClose: () => void }) {
  const { workspace, pages } = useApp();
  const navigate = useNavigate();
  const detail = useCard(card.pageId, card.rowId);
  const [rule, setRule] = useState<RepeatRule | null>(null);
  const [date, setDate] = useState(card.date);
  const [saving, setSaving] = useState(false);
  const page = pages.find((p) => p.id === card.pageId);
  const fields = detail.data?.row.fields ?? [];
  const canEdit = detail.data?.canEdit ?? false;

  useEffect(() => {
    if (detail.data) setRule(detail.data.row.repeat);
  }, [detail.data]);

  const save = async () => {
    setSaving(true);
    try {
      if (date !== card.date) await setCardCells(workspace.id, card.pageId, card.rowId, { [card.fieldId]: date });
      const before = JSON.stringify(detail.data?.row.repeat ?? null);
      if (JSON.stringify(rule) !== before) await setCardRepeat(workspace.id, card.pageId, card.rowId, rule ? { ...rule, dateField: rule.dateField ?? card.fieldId } : null);
      toast('Saved');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} width={600} top="6vh" maxHeight="88vh" className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        {page && <PageIcon page={page} size={17} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{card.title || 'Untitled'}</div>
          <div className="truncate text-xs text-muted">
            {card.pageTitle || 'Untitled'} · {card.fieldName}
          </div>
        </div>
        <IconButton onClick={onClose} aria-label="Close">
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">{card.fieldName}</span>
            <input type="date" value={date} disabled={!canEdit} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
          </label>
          {card.status && (
            <div>
              <span className="mb-1 block text-xs text-muted">Status</span>
              <span className="inline-flex h-9 items-center rounded-lg bg-sidebar px-3 text-sm">{card.status}</span>
            </div>
          )}
          <span className="flex-1" />
          <Button
            onClick={() => {
              onClose();
              navigate(locationPath(workspace.id, { pageId: card.pageId, rowId: card.rowId }));
            }}
          >
            <ExternalLink size={15} /> Open card
          </Button>
        </div>
        {detail.isPending ? (
          <div className="py-6 text-center text-sm text-muted">Loading…</div>
        ) : canEdit ? (
          <RepeatEditor value={rule} onChange={setRule} defaultStart={card.date} kind="card" fields={fields} />
        ) : (
          <div className="rounded-lg bg-sidebar px-3 py-2 text-sm text-muted">You can only view this database.</div>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {canEdit && (
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
    </Dialog>
  );
}

/** "Repeat…" from a card's menu: makes the card come back on a schedule, resetting its status. */
export function CardRepeatDialog({ pageId, rowId, onClose }: { pageId: string; rowId: string; onClose: () => void }) {
  const { workspace } = useApp();
  const detail = useCard(pageId, rowId);
  const [rule, setRule] = useState<RepeatRule | null>(null);
  const [saving, setSaving] = useState(false);
  const row = detail.data?.row;
  const firstDate = row?.fields.find((f) => f.type === 'date');
  const current = firstDate && typeof row?.cells[firstDate.id] === 'string' ? (row.cells[firstDate.id] as string) : new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (row) setRule(row.repeat);
  }, [row]);

  const save = async () => {
    setSaving(true);
    try {
      await setCardRepeat(workspace.id, pageId, rowId, rule);
      toast(rule ? 'This card now repeats' : 'Stopped repeating');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} width={600} top="8vh" maxHeight="84vh" className="flex flex-col">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-[15px] font-semibold">Repeat this card</h2>
        <IconButton onClick={onClose} aria-label="Close">
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {detail.isPending ? (
          <div className="py-6 text-center text-sm text-muted">Loading…</div>
        ) : detail.data?.canEdit ? (
          <RepeatEditor value={rule} onChange={setRule} defaultStart={current} kind="card" fields={row?.fields ?? []} />
        ) : (
          <div className="text-sm text-muted">You can only view this database.</div>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {detail.data?.canEdit && (
          <Button variant="primary" onClick={save} disabled={saving || (!!rule && !rule.dateField)}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
