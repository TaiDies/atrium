import { accessMap, hiddenEvents } from './access.js';
import { config } from './config.js';
import { query } from './db.js';
import { addDays, isDate, today, validRule } from './repeat.js';

// Calendar files (.ics, RFC 5545): the feed other calendar apps subscribe to, and reading files people
// import. Times are "floating" (no time zone), like the app's own: 09:00 stays 09:00 wherever it's shown.

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const day = (d: string) => d.replace(/-/g, '');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const uidHost = () => config.appName.replace(/[^A-Za-z0-9.-]/g, '') || 'workspace';

/** Lines longer than 75 bytes are folded, as the format requires. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let n = 74;
    while (n > 1 && Buffer.byteLength(rest.slice(0, n)) > 74) n--;
    out.push(rest.slice(0, n));
    rest = ' ' + rest.slice(n);
  }
  out.push(rest);
  return out.join('\r\n');
}

function addHour(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return h >= 23 ? '23:59' : `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const timed = (date: string, time: string) => `${day(date)}T${time.replace(':', '')}00`;
const FREQ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' } as const;

interface FeedEvent {
  id: string;
  title: string;
  description: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  status: string | null;
  repeat: unknown;
  reminder: number | null;
  updatedAt: string;
}

/** Everything on this person's calendar in a workspace: events, tasks, dated cards and dated to-dos. */
export async function calendarFeed(userId: string, workspaceId: string, workspaceName: string): Promise<string> {
  const access = await accessMap(userId, workspaceId);
  const visible = (pageId: string) => (access.get(pageId) ?? 'none') !== 'none';
  // A year back and everything ahead (repeating events always).
  const from = addDays(today(), -365);
  const host = uidHost();
  const now = stamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${config.appName}//Calendar//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${workspaceName} (${config.appName})`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  const events = await query<FeedEvent>(
    `select id, title, description, to_char(start_date, 'YYYY-MM-DD') as "startDate", start_time as "startTime",
            to_char(end_date, 'YYYY-MM-DD') as "endDate", end_time as "endTime", status, repeat, reminder,
            to_char(updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') as "updatedAt"
       from events where workspace_id = $1 and (repeat is not null or coalesce(end_date, start_date) >= $2)`,
    [workspaceId, from],
  );
  const hidden = await hiddenEvents(userId, workspaceId, events.map((e) => e.id));
  for (const e of events.filter((x) => !hidden.has(x.id))) {
    const title = `${e.status ? (e.status === 'done' ? '✓ ' : '☐ ') : ''}${e.title || 'Untitled'}`;
    const ev = ['BEGIN:VEVENT', `UID:${e.id}@${host}`, `DTSTAMP:${now}`, `LAST-MODIFIED:${e.updatedAt}`, `SUMMARY:${esc(title)}`];
    if (e.startTime) {
      const endDate = e.endDate ?? e.startDate;
      const endTime = e.endTime ?? (endDate === e.startDate ? addHour(e.startTime) : e.startTime);
      ev.push(`DTSTART:${timed(e.startDate, e.startTime)}`, `DTEND:${timed(endDate, endTime)}`);
    } else {
      ev.push(`DTSTART;VALUE=DATE:${day(e.startDate)}`, `DTEND;VALUE=DATE:${day(addDays(e.endDate ?? e.startDate, 1))}`);
    }
    if (e.description) ev.push(`DESCRIPTION:${esc(e.description)}`);
    if (validRule(e.repeat)) {
      const r = e.repeat;
      // The end is a date for all-day events and a date with a time for timed ones, as calendar apps expect.
      const until = r.end ? `;UNTIL=${day(r.end)}${e.startTime ? 'T235959' : ''}` : '';
      ev.push(`RRULE:FREQ=${FREQ[r.unit]};INTERVAL=${r.every}${until}`);
    }
    if (e.status) ev.push(`CATEGORIES:${e.status === 'done' ? 'Done' : 'Task'}`);
    if (e.reminder !== null && e.reminder !== undefined) {
      ev.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title || 'Reminder')}`, `TRIGGER:-PT${e.reminder}M`, 'END:VALARM');
    }
    ev.push('END:VEVENT');
    lines.push(...ev);
  }

  const cards = await query<{ pageId: string; rowId: string; fieldId: string; date: string; endDate: string | null; title: string; status: string | null; pageTitle: string }>(
    `select d.page_id as "pageId", d.row_id as "rowId", d.field_id as "fieldId", to_char(d.date, 'YYYY-MM-DD') as date,
            to_char(d.end_date, 'YYYY-MM-DD') as "endDate", d.title, d.status, p.title as "pageTitle"
       from row_dates d join pages p on p.id = d.page_id and p.deleted_at is null and p.workspace_id = $1
      where coalesce(d.end_date, d.date) >= $2`,
    [workspaceId, from],
  );
  for (const c of cards.filter((c) => visible(c.pageId))) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:card-${c.pageId}-${c.rowId}-${c.fieldId}@${host}`,
      `DTSTAMP:${now}`,
      `SUMMARY:${esc(`${c.title || 'Untitled'}${c.status ? ` [${c.status}]` : ''}`)}`,
      `DTSTART;VALUE=DATE:${day(c.date)}`,
      `DTEND;VALUE=DATE:${day(addDays(c.endDate ?? c.date, 1))}`,
      `DESCRIPTION:${esc(`In ${c.pageTitle || 'Untitled'}`)}`,
      'END:VEVENT',
    );
  }

  const blocks = await query<{ pageId: string; rowId: string; blockId: string; date: string; text: string; done: boolean | null; time: string | null; pageTitle: string }>(
    `select b.page_id as "pageId", b.row_id as "rowId", b.block_id as "blockId", to_char(b.date, 'YYYY-MM-DD') as date, b.text, b.done, b.time,
            p.title as "pageTitle"
       from block_dates b join pages p on p.id = b.page_id and p.deleted_at is null and p.workspace_id = $1
      where b.date >= $2 and b.row_id not like 'tpl\\_%'`,
    [workspaceId, from],
  );
  for (const b of blocks.filter((b) => visible(b.pageId))) {
    const title = `${b.done === null ? '' : b.done ? '✓ ' : '☐ '}${b.text || 'Untitled'}`;
    const when =
      b.time && /^\d{2}:\d{2}$/.test(b.time)
        ? [`DTSTART:${timed(b.date, b.time)}`, `DTEND:${timed(b.date, addHour(b.time))}`]
        : [`DTSTART;VALUE=DATE:${day(b.date)}`, `DTEND;VALUE=DATE:${day(addDays(b.date, 1))}`];
    lines.push(
      'BEGIN:VEVENT',
      `UID:block-${b.pageId}-${b.rowId || 'page'}-${b.blockId}-${b.date}@${host}`,
      `DTSTAMP:${now}`,
      `SUMMARY:${esc(title.slice(0, 300))}`,
      ...when,
      `DESCRIPTION:${esc(`In ${b.pageTitle || 'Untitled'}`)}`,
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export interface ImportedEvent {
  title: string;
  description: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  repeat: { unit: 'day' | 'week' | 'month' | 'year'; every: number; start: string; end: string | null; when: 'date' } | null;
  reminder: number | null;
}

const unesc = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
type Prop = { params: string; value: string };

/** Reads the events in a calendar file (another app's export, or a saved subscription). */
export function parseIcs(text: string): ImportedEvent[] {
  // Continued lines (starting with a space or tab) are joined first.
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: ImportedEvent[] = [];
  let cur: Record<string, Prop> | null = null;
  let alarm: string | null = null;
  let inAlarm = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      alarm = null;
    } else if (line === 'BEGIN:VALARM') inAlarm = true;
    else if (line === 'END:VALARM') inAlarm = false;
    else if (line === 'END:VEVENT') {
      if (cur) {
        const ev = toEvent(cur, alarm);
        if (ev) out.push(ev);
      }
      cur = null;
    } else if (cur) {
      const m = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1].toUpperCase();
      if (inAlarm) {
        if (name === 'TRIGGER' && alarm === null) alarm = m[3];
      } else if (!(name in cur)) cur[name] = { params: m[2], value: m[3] };
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "20261110", "20261110T090000" or "20261110T090000Z" → date and time (UTC is shown in the server's time). */
function when(v: Prop | undefined): { date: string; time: string | null } | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z)?)?$/.exec(v.value.trim());
  if (!m) return null;
  let date = `${m[1]}-${m[2]}-${m[3]}`;
  let time = m[4] ? `${m[4]}:${m[5]}` : null;
  if (m[6] && time) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return isDate(date) ? { date, time } : null;
}

function toEvent(p: Record<string, Prop>, alarm: string | null): ImportedEvent | null {
  const start = when(p.DTSTART);
  if (!start) return null;
  let end = when(p.DTEND);
  // All-day ends are the day after the last day.
  if (end && !start.time && !end.time) end = { date: addDays(end.date, -1), time: null };
  if (end && end.date < start.date) end = null;
  let repeat: ImportedEvent['repeat'] = null;
  const rule = p.RRULE?.value;
  if (rule) {
    const parts = Object.fromEntries(rule.split(';').map((x) => x.split('=') as [string, string]));
    const unit = ({ DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as const)[parts.FREQ as 'DAILY'];
    const until = parts.UNTIL ? (when({ params: '', value: parts.UNTIL })?.date ?? null) : null;
    if (unit) repeat = { unit, every: Math.max(1, Math.min(999, Number(parts.INTERVAL) || 1)), start: start.date, end: until, when: 'date' };
  }
  const trig = alarm ? /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(alarm) : null;
  const reminder = trig ? Math.min(40320, ((Number(trig[1] ?? 0) * 7 + Number(trig[2] ?? 0)) * 24 + Number(trig[3] ?? 0)) * 60 + Number(trig[4] ?? 0)) : null;
  const sameDay = !end || end.date === start.date;
  return {
    title: unesc(p.SUMMARY?.value ?? '').slice(0, 500),
    description: unesc(p.DESCRIPTION?.value ?? '').slice(0, 10_000),
    startDate: start.date,
    startTime: start.time,
    endDate: end && !sameDay ? end.date : null,
    endTime: start.time && end?.time ? end.time : null,
    repeat,
    reminder,
  };
}
