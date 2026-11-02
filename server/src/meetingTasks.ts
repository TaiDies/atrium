import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from './db.js';
import { pushTo } from './live.js';
import { meetingAccess } from './meetingAccess.js';
import { notify } from './notify.js';
import { HttpError, idParams, parse } from './util.js';

// Meeting tasks: for one person, several, or everyone in the meeting. Only those people and whoever
// made the task see it; only those people can tick it — each their own part — and it's finished when
// all of them have. Whoever made it (or runs the meeting) changes who it's for. Each person it's for can
// put it in the calendar, from the meeting's start to the task's due date.

export interface TaskView {
  id: string;
  title: string;
  notes: string;
  dueAt: string | null;
  priority: 'low' | 'normal' | 'high';
  forEveryone: boolean;
  createdBy: string | null;
  people: { userId: string; doneAt: string | null }[];
  /** Whether it's for me, whether I've done my part, and my calendar event. */
  mine: boolean;
  myDone: boolean;
  myEventId: string | null;
  doneCount: number;
  total: number;
  done: boolean;
  canEdit: boolean;
}

interface TaskRow {
  id: string;
  meeting_id: string;
  title: string;
  notes: string;
  due_at: string | null;
  priority: TaskView['priority'];
  for_everyone: boolean;
  created_by: string | null;
}

/** The tasks of a meeting this person may see, with everyone's progress. */
export async function tasksFor(meetingId: string, userId: string, canManage: boolean, memberIds: string[]): Promise<TaskView[]> {
  const tasks = await query<TaskRow>('select id, meeting_id, title, notes, due_at, priority, for_everyone, created_by from meeting_tasks where meeting_id = $1 order by position, created_at', [meetingId]);
  if (!tasks.length) return [];
  const people = await query<{ task_id: string; user_id: string; done_at: string | null; event_id: string | null }>(
    'select task_id, user_id, done_at, event_id from meeting_task_people where task_id = any($1)',
    [tasks.map((t) => t.id)],
  );
  const out: TaskView[] = [];
  for (const t of tasks) {
    const rows = people.filter((p) => p.task_id === t.id);
    // An everyone task is for everyone in the meeting; otherwise for the people it names.
    const forIds = t.for_everyone ? memberIds : rows.map((r) => r.user_id);
    const mine = forIds.includes(userId);
    if (!mine && t.created_by !== userId) continue;
    const doneOf = (id: string) => rows.find((r) => r.user_id === id)?.done_at ?? null;
    const doneCount = forIds.filter((id) => doneOf(id)).length;
    const me = rows.find((r) => r.user_id === userId);
    out.push({
      id: t.id,
      title: t.title,
      notes: t.notes,
      dueAt: t.due_at,
      priority: t.priority,
      forEveryone: t.for_everyone,
      createdBy: t.created_by,
      people: forIds.map((id) => ({ userId: id, doneAt: doneOf(id) })),
      mine,
      myDone: !!me?.done_at,
      myEventId: me?.event_id ?? null,
      doneCount,
      total: forIds.length,
      done: forIds.length > 0 && doneCount === forIds.length,
      canEdit: t.created_by === userId || canManage,
    });
  }
  return out;
}

/** Everyone in a meeting (the host and members who didn't say no). */
export async function meetingPeople(meetingId: string, hostId: string | null) {
  const rows = await query<{ user_id: string }>(`select user_id from meeting_members where meeting_id = $1 and status <> 'declined'`, [meetingId]);
  return [...new Set([...(hostId ? [hostId] : []), ...rows.map((r) => r.user_id)])];
}

const taskBody = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(4000).default(''),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  /** Nobody named = everyone. */
  assigneeIds: z.array(z.uuid()).max(300).default([]),
  forEveryone: z.boolean().optional(),
});
export type NewTask = z.infer<typeof taskBody>;
export const newTaskSchema = taskBody;

/** Adds a task (in a transaction or not) and tells the people it's for. */
export async function addTask(meeting: { id: string; title: string; workspace_id: string; code: string }, by: { id: string; name: string }, t: NewTask, position?: number) {
  const everyone = t.forEveryone ?? t.assigneeIds.length === 0;
  const id = await tx(async (c) => {
    const row = await one<{ id: string }>(
      `insert into meeting_tasks (meeting_id, title, notes, due_at, priority, for_everyone, position, created_by)
       values ($1, $2, $3, $4, $5, $6, coalesce($7, (select coalesce(max(position) + 1, 0) from meeting_tasks where meeting_id = $1)), $8) returning id`,
      [meeting.id, t.title, t.notes, t.dueAt, t.priority, everyone, position ?? null, by.id],
      c,
    );
    if (!everyone) for (const u of new Set(t.assigneeIds)) await query('insert into meeting_task_people (task_id, user_id) values ($1, $2) on conflict do nothing', [row!.id, u], c);
    return row!.id;
  });
  if (!everyone) {
    for (const u of new Set(t.assigneeIds)) {
      if (u !== by.id) await notify(u, { kind: 'assigned', title: `${by.name} gave you a task in “${meeting.title}”`, body: t.title, link: `/w/${meeting.workspace_id}/meet/${meeting.code}` });
    }
  }
  return id;
}

async function changed(meetingId: string) {
  const members = (await query<{ user_id: string }>('select user_id from meeting_members where meeting_id = $1', [meetingId])).map((r) => r.user_id);
  pushTo(members, { t: 'meeting-tasks', meetingId });
}

/** The task, its meeting, and what this person may do with it. */
async function taskFor(userId: string, taskId: string) {
  const t = await one<TaskRow>('select id, meeting_id, title, notes, due_at, priority, for_everyone, created_by from meeting_tasks where id = $1', [taskId]);
  if (!t) throw new HttpError(404, 'Task not found');
  const a = await meetingAccess(userId, t.meeting_id);
  const people = await meetingPeople(a.meeting.id, a.meeting.host_id);
  const named = (await query<{ user_id: string }>('select user_id from meeting_task_people where task_id = $1', [taskId])).map((r) => r.user_id);
  const forIds = t.for_everyone ? people : named;
  const mine = forIds.includes(userId);
  if (!mine && t.created_by !== userId) throw new HttpError(404, 'Task not found');
  return { t, a, mine, canEdit: t.created_by === userId || a.canManage };
}

export async function meetingTaskRoutes(app: FastifyInstance) {
  app.post('/meetings/:code/tasks', async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.params);
    const a = await meetingAccess(req.user.id, code);
    if (!a.members.some((m) => m.user_id === req.user.id) && !a.canManage) throw new HttpError(403, "You're not in this meeting");
    const body = parse(taskBody, req.body);
    // Only people in the meeting.
    const people = await meetingPeople(a.meeting.id, a.meeting.host_id);
    body.assigneeIds = body.assigneeIds.filter((u) => people.includes(u));
    const id = await addTask(a.meeting, req.user, body);
    await changed(a.meeting.id);
    return { id };
  });

  // Changing a task (whoever made it, or whoever runs the meeting).
  app.patch('/meeting-tasks/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { t, a, canEdit } = await taskFor(req.user.id, id);
    if (!canEdit) throw new HttpError(403, 'Only whoever made the task can change it');
    const b = parse(taskBody.partial(), req.body);
    await query(
      `update meeting_tasks set title = coalesce($2, title), notes = coalesce($3, notes), priority = coalesce($4, priority),
              due_at = case when $6 then $5::timestamptz else due_at end, for_everyone = coalesce($7, for_everyone) where id = $1`,
      [id, b.title ?? null, b.notes ?? null, b.priority ?? null, b.dueAt ?? null, b.dueAt !== undefined, b.forEveryone ?? null],
    );
    if (b.assigneeIds) {
      const people = await meetingPeople(a.meeting.id, a.meeting.host_id);
      const keep = [...new Set(b.assigneeIds.filter((u) => people.includes(u)))];
      const before = (await query<{ user_id: string }>('select user_id from meeting_task_people where task_id = $1', [id])).map((r) => r.user_id);
      await query('delete from meeting_task_people where task_id = $1 and not (user_id = any($2))', [id, keep]);
      for (const u of keep) await query('insert into meeting_task_people (task_id, user_id) values ($1, $2) on conflict do nothing', [id, u]);
      if (!b.forEveryone && keep.length) await query('update meeting_tasks set for_everyone = false where id = $1', [id]);
      for (const u of keep.filter((x) => !before.includes(x) && x !== req.user.id)) {
        await notify(u, { kind: 'assigned', title: `${req.user.name} gave you a task in “${a.meeting.title}”`, body: b.title ?? t.title, link: `/w/${a.meeting.workspace_id}/meet/${a.meeting.code}` });
      }
    }
    await changed(a.meeting.id);
    return { ok: true };
  });

  // Ticking my part (only people the task is for).
  app.post('/meeting-tasks/:id/done', async (req) => {
    const { id } = parse(idParams, req.params);
    const { a, mine } = await taskFor(req.user.id, id);
    if (!mine) throw new HttpError(403, "This task isn't yours to finish");
    const { done } = parse(z.object({ done: z.boolean() }), req.body);
    await query(
      `insert into meeting_task_people (task_id, user_id, done_at) values ($1, $2, case when $3 then now() end)
       on conflict (task_id, user_id) do update set done_at = case when $3 then now() end`,
      [id, req.user.id, done],
    );
    await changed(a.meeting.id);
    return { ok: true };
  });

  // Putting it in the calendar: from the meeting's start to the task's due date (the app works out the
  // wall-clock dates and times, as the calendar keeps them).
  app.post('/meeting-tasks/:id/calendar', async (req) => {
    const { id } = parse(idParams, req.params);
    const { t, a, mine } = await taskFor(req.user.id, id);
    if (!mine) throw new HttpError(403, 'Only people the task is for can add it to their calendar');
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const time = z.string().regex(/^\d{2}:\d{2}$/).nullable();
    const b = parse(z.object({ startDate: date, startTime: time, endDate: date.nullable(), endTime: time }), req.body);
    const ev = await one<{ id: string }>(
      `insert into events (workspace_id, title, description, start_date, start_time, end_date, end_time, color, status, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'purple', 'todo', $8) returning id`,
      [a.meeting.workspace_id, t.title, `From the meeting “${a.meeting.title}”${t.notes ? `\n\n${t.notes}` : ''}`, b.startDate, b.startTime, b.endDate, b.endTime, req.user.id],
    );
    await query(
      `insert into meeting_task_people (task_id, user_id, event_id) values ($1, $2, $3) on conflict (task_id, user_id) do update set event_id = $3`,
      [id, req.user.id, ev!.id],
    );
    await changed(a.meeting.id);
    return { eventId: ev!.id };
  });

  app.delete('/meeting-tasks/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { a, canEdit } = await taskFor(req.user.id, id);
    if (!canEdit) throw new HttpError(403, 'Only whoever made the task can remove it');
    await query('delete from meeting_tasks where id = $1', [id]);
    await changed(a.meeting.id);
    return { ok: true };
  });
}
