import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Dialog, Spinner, toastError } from '../components/ui';
import { api } from '../lib/api';
import { downloadBlob } from '../office/shared';

// A page's stats as a spreadsheet: every card, task and dated to-do on the page, day by day — what was
// planned, what's done and when it was finished, and whether that was early, on time or late (or is
// overdue). A plan with dates is shown from its first day to its last all at once; a task that
// repeats forever carries the days on past that, up to today. It downloads as an Excel file.

interface StatItem {
  key: string;
  kind: 'card' | 'task' | 'todo';
  title: string;
  date: string | null;
  time: string | null;
  done: boolean | null;
  doneAt: string | null;
  status: string | null;
  detail: string | null;
  forever: boolean;
}

interface Stats {
  title: string;
  kind: 'database' | 'document';
  today: string;
  items: StatItem[];
}

type Timing = 'early' | 'on-time' | 'late' | 'done' | 'overdue' | 'due-today' | 'upcoming' | 'no-date' | 'open';

const KIND_LABEL: Record<StatItem['kind'], string> = { card: 'Card', task: 'Task', todo: 'To-do' };
const TIMING_LABEL: Record<Timing, string> = {
  early: 'Early',
  'on-time': 'On time',
  late: 'Late',
  done: 'Done',
  overdue: 'Overdue',
  'due-today': 'Due today',
  upcoming: 'Upcoming',
  'no-date': 'No date',
  open: 'Not done',
};
const TIMING_CLASS: Record<Timing, string> = {
  early: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  'on-time': 'bg-green-500/15 text-green-700 dark:text-green-300',
  late: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  done: 'bg-green-500/15 text-green-700 dark:text-green-300',
  overdue: 'bg-red-500/15 text-red-600 dark:text-red-300',
  'due-today': 'bg-accent/15 text-accent',
  upcoming: 'bg-hover text-muted',
  'no-date': 'bg-hover text-muted',
  open: 'bg-hover text-muted',
};

const pad = (n: number) => String(n).padStart(2, '0');
/** The local day (YYYY-MM-DD) of a moment. */
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const toDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
const addDays = (day: string, n: number) => {
  const d = toDate(day);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dayLabel = (day: string) => toDate(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeLabel = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Early, on time or late for what's done; overdue, due today or upcoming for what isn't. */
function timingOf(item: StatItem, today: string): { timing: Timing; by: number } {
  if (item.done) {
    if (!item.date || !item.doneAt) return { timing: 'done', by: 0 };
    const diff = daysBetween(item.date, localDay(item.doneAt));
    return diff < 0 ? { timing: 'early', by: -diff } : diff > 0 ? { timing: 'late', by: diff } : { timing: 'on-time', by: 0 };
  }
  if (!item.date) return { timing: item.done === null ? 'no-date' : 'open', by: 0 };
  if (item.date < today) return { timing: 'overdue', by: daysBetween(item.date, today) };
  return item.date === today ? { timing: 'due-today', by: 0 } : { timing: 'upcoming', by: 0 };
}

function timingText(t: { timing: Timing; by: number }) {
  if (t.by && (t.timing === 'early' || t.timing === 'late' || t.timing === 'overdue')) return `${TIMING_LABEL[t.timing]} by ${t.by} day${t.by === 1 ? '' : 's'}`;
  return TIMING_LABEL[t.timing];
}

interface DayRow {
  day: string;
  items: (StatItem & { t: { timing: Timing; by: number } })[];
  done: number;
  notDone: number;
  overdue: number;
  early: number;
  late: number;
}

function useSheet(stats: Stats | undefined) {
  return useMemo(() => {
    if (!stats) return null;
    const today = stats.today;
    const rows = stats.items.map((i) => ({ ...i, t: timingOf(i, today) }));
    const dated = rows.filter((r) => r.date);
    // The plan's days: first to last dated item; a task that repeats forever carries on to today.
    let days: string[] = [];
    if (dated.length) {
      const first = dated.reduce((m, r) => (r.date! < m ? r.date! : m), dated[0].date!);
      const planned = dated.filter((r) => !r.forever);
      let last = planned.length ? planned.reduce((m, r) => (r.date! > m ? r.date! : m), planned[0].date!) : today;
      if (dated.some((r) => r.forever) && today > last) last = today;
      const count = Math.min(1500, daysBetween(first, last) + 1);
      days = Array.from({ length: Math.max(0, count) }, (_, i) => addDays(first, i));
    }
    const byDay: DayRow[] = days.map((day) => {
      const items = rows.filter((r) => r.date === day);
      return {
        day,
        items,
        done: items.filter((i) => i.done).length,
        notDone: items.filter((i) => !i.done).length,
        overdue: items.filter((i) => i.t.timing === 'overdue').length,
        early: items.filter((i) => i.t.timing === 'early').length,
        late: items.filter((i) => i.t.timing === 'late').length,
      };
    });
    const all = [...rows].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.title.localeCompare(b.title));
    const count = (t: Timing) => rows.filter((r) => r.t.timing === t).length;
    const done = rows.filter((r) => r.done).length;
    const summary = {
      total: rows.length,
      done,
      notDone: rows.length - done,
      overdue: count('overdue'),
      early: count('early'),
      onTime: count('on-time'),
      late: count('late'),
      percent: rows.length ? Math.round((done / rows.length) * 100) : 0,
    };
    return { today, byDay, all, summary };
  }, [stats]);
}

export function StatsSheet({ pageId, title, onClose }: { pageId: string; title: string; onClose: () => void }) {
  const stats = useQuery({ queryKey: ['page-stats', pageId], queryFn: () => api<Stats>(`/api/pages/${pageId}/stats`), staleTime: 0 });
  const sheet = useSheet(stats.data);
  const [tab, setTab] = useState<'days' | 'items'>('days');
  const [busy, setBusy] = useState(false);

  const exportExcel = async () => {
    if (!sheet) return;
    setBusy(true);
    try {
      downloadBlob(await toExcel(title, sheet), `${(title || 'Page').replace(/[\\/:*?"<>|]+/g, ' ').trim()} - stats.xlsx`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const s = sheet?.summary;
  return (
    <Dialog open onClose={onClose} title={`Stats · ${title || 'Untitled'}`} width={1100} maxHeight="92vh" top="4vh">
      <div className="flex min-h-0 flex-col gap-3 px-5 pb-5">
        {stats.isPending ? (
          <Spinner />
        ) : !sheet || !s ? (
          <p className="text-sm text-muted">These stats couldn't be loaded.</p>
        ) : s.total === 0 ? (
          <p className="text-sm text-muted">There's nothing to count on this page yet: no cards, tasks or dated to-dos.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Chip label="Done" value={`${s.done} of ${s.total} (${s.percent}%)`} tone="text-green-600 dark:text-green-400" />
              <Chip label="Not done" value={s.notDone} />
              <Chip label="Overdue" value={s.overdue} tone={s.overdue ? 'text-red-500' : undefined} />
              <Chip label="Early" value={s.early} tone="text-sky-500" />
              <Chip label="On time" value={s.onTime} />
              <Chip label="Late" value={s.late} tone={s.late ? 'text-amber-500' : undefined} />
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-line p-0.5 text-sm">
                {(['days', 'items'] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)} className={clsx('h-7 rounded-md px-3', tab === t ? 'bg-active font-medium' : 'text-muted hover:text-fg')}>
                    {t === 'days' ? 'By day' : 'Everything'}
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              <Button size="sm" onClick={() => void exportExcel()} loading={busy}>
                <Download size={14} /> Download for Excel
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line" style={{ maxHeight: '62vh' }}>
              {tab === 'days' ? <DaysTable rows={sheet.byDay} today={sheet.today} /> : <ItemsTable rows={sheet.all} />}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Chip({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-1.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('text-sm font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

const TH = 'sticky top-0 z-10 border-b border-line bg-surface px-2.5 py-2 text-start text-xs font-semibold text-muted whitespace-nowrap';
const TD = 'border-b border-line/70 px-2.5 py-1.5 align-top';

function DaysTable({ rows, today }: { rows: DayRow[]; today: string }) {
  if (!rows.length) return <p className="p-4 text-sm text-muted">Nothing here has a date, so there are no days to show. See Everything.</p>;
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th className={TH}>Day</th>
          <th className={clsx(TH, 'text-end')}>Planned</th>
          <th className={clsx(TH, 'text-end')}>Done</th>
          <th className={clsx(TH, 'text-end')}>Not done</th>
          <th className={clsx(TH, 'text-end')}>Overdue</th>
          <th className={clsx(TH, 'text-end')}>Early</th>
          <th className={clsx(TH, 'text-end')}>Late</th>
          <th className={TH}>What was planned</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.day} className={clsx(r.day === today && 'bg-accent/10', r.day > today && 'text-muted')}>
            <td className={clsx(TD, 'whitespace-nowrap font-medium')}>
              {dayLabel(r.day)}
              {r.day === today && <span className="ms-1.5 rounded bg-accent px-1 text-[10px] text-white">Today</span>}
            </td>
            <td className={clsx(TD, 'text-end tabular-nums')}>{r.items.length || ''}</td>
            <td className={clsx(TD, 'text-end tabular-nums text-green-600 dark:text-green-400')}>{r.done || ''}</td>
            <td className={clsx(TD, 'text-end tabular-nums')}>{r.notDone || ''}</td>
            <td className={clsx(TD, 'text-end tabular-nums text-red-500')}>{r.overdue || ''}</td>
            <td className={clsx(TD, 'text-end tabular-nums text-sky-500')}>{r.early || ''}</td>
            <td className={clsx(TD, 'text-end tabular-nums text-amber-500')}>{r.late || ''}</td>
            <td className={TD}>
              {r.items.length === 0 ? (
                <span className="text-faint">—</span>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {r.items.map((i) => (
                    <span key={i.key} className="flex flex-wrap items-center gap-1.5">
                      <span className={clsx('size-2 shrink-0 rounded-full', i.done ? 'bg-green-500' : i.t.timing === 'overdue' ? 'bg-red-500' : 'bg-line')} />
                      <span className={clsx(i.done && 'text-muted')}>{i.title}</span>
                      {i.detail && <span className="text-xs text-faint">· {i.detail}</span>}
                      {i.doneAt && <span className="text-xs text-faint">· done {timeLabel(i.doneAt)}</span>}
                    </span>
                  ))}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemsTable({ rows }: { rows: (StatItem & { t: { timing: Timing; by: number } })[] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th className={TH}>Due</th>
          <th className={TH}>Item</th>
          <th className={TH}>Kind</th>
          <th className={TH}>Status</th>
          <th className={TH}>Finished</th>
          <th className={TH}>Timing</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className={clsx(TD, 'whitespace-nowrap')}>
              {r.date ? dayLabel(r.date) : <span className="text-faint">No date</span>}
              {r.time && <span className="ms-1 text-xs text-faint">{r.time.slice(0, 5)}</span>}
            </td>
            <td className={TD}>
              {r.title}
              {r.detail && <div className="text-xs text-faint">{r.detail}</div>}
            </td>
            <td className={clsx(TD, 'whitespace-nowrap text-muted')}>{KIND_LABEL[r.kind]}</td>
            <td className={clsx(TD, 'whitespace-nowrap')}>{r.status ?? (r.done ? 'Done' : r.done === false ? 'Not done' : '—')}</td>
            <td className={clsx(TD, 'whitespace-nowrap text-muted')}>{r.doneAt ? timeLabel(r.doneAt) : r.done ? 'Time not recorded' : ''}</td>
            <td className={TD}>
              <span className={clsx('whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium', TIMING_CLASS[r.t.timing])}>{timingText(r.t)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The two sheets as an Excel workbook: days (one row each) and everything (one row per item). */
async function toExcel(title: string, sheet: NonNullable<ReturnType<typeof useSheet>>): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Atrium';
  wb.created = new Date();
  const style = (ws: import('exceljs').Worksheet) => {
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B4BD6' } };
    head.alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  };

  const days = wb.addWorksheet('By day');
  days.columns = [
    { header: 'Day', key: 'day', width: 14, style: { numFmt: 'ddd d mmm yyyy' } },
    { header: 'Planned', key: 'planned', width: 10 },
    { header: 'Done', key: 'done', width: 8 },
    { header: 'Not done', key: 'notDone', width: 10 },
    { header: 'Overdue', key: 'overdue', width: 10 },
    { header: 'Early', key: 'early', width: 8 },
    { header: 'Late', key: 'late', width: 8 },
    { header: 'What was planned', key: 'items', width: 80 },
  ];
  for (const r of sheet.byDay) {
    const row = days.addRow({
      day: toDate(r.day),
      planned: r.items.length,
      done: r.done,
      notDone: r.notDone,
      overdue: r.overdue,
      early: r.early,
      late: r.late,
      items: r.items.map((i) => `${i.done ? '✓' : '✗'} ${i.title}${i.detail ? ` (${i.detail})` : ''}`).join('\n'),
    });
    row.getCell('items').alignment = { wrapText: true, vertical: 'top' };
    if (r.day === sheet.today) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FF' } };
  }
  style(days);

  const items = wb.addWorksheet('Everything');
  items.columns = [
    { header: 'Due', key: 'date', width: 14, style: { numFmt: 'ddd d mmm yyyy' } },
    { header: 'Time', key: 'time', width: 8 },
    { header: 'Item', key: 'title', width: 50 },
    { header: 'Path', key: 'detail', width: 40 },
    { header: 'Kind', key: 'kind', width: 8 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Done', key: 'done', width: 8 },
    { header: 'Finished at', key: 'doneAt', width: 20, style: { numFmt: 'd mmm yyyy hh:mm' } },
    { header: 'Timing', key: 'timing', width: 18 },
    { header: 'Days early (−) or late (+)', key: 'offset', width: 14 },
  ];
  for (const r of sheet.all) {
    items.addRow({
      date: r.date ? toDate(r.date) : null,
      time: r.time?.slice(0, 5) ?? '',
      title: r.title,
      detail: r.detail ?? '',
      kind: KIND_LABEL[r.kind],
      status: r.status ?? (r.done ? 'Done' : r.done === false ? 'Not done' : ''),
      done: r.done ? 'Yes' : r.done === false ? 'No' : '',
      doneAt: r.doneAt ? new Date(r.doneAt) : null,
      timing: timingText(r.t),
      offset: r.t.timing === 'early' ? -r.t.by : r.t.timing === 'late' ? r.t.by : r.t.timing === 'on-time' ? 0 : null,
    });
  }
  style(items);

  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: title || 'Page', key: 'k', width: 22 },
    { header: '', key: 'v', width: 14 },
  ];
  const s = sheet.summary;
  for (const [k, v] of [
    ['Everything', s.total],
    ['Done', s.done],
    ['Not done', s.notDone],
    ['Overdue', s.overdue],
    ['Early', s.early],
    ['On time', s.onTime],
    ['Late', s.late],
    ['Done (%)', s.percent],
  ] as const)
    summary.addRow({ k, v });
  summary.getRow(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export { Table2 as StatsIcon };
