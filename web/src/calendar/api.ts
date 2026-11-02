import { useQuery } from '@tanstack/react-query';
import { api, type PageType } from '../lib/api';
import type { Location, PlaceTarget } from '../lib/placement';
import { queryClient } from '../lib/queries';
import type { RepeatRule } from './repeat';

export type EventColor = 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red' | 'aqua';
export type TaskStatus = 'todo' | 'doing' | 'done';

export const EVENT_COLORS: EventColor[] = ['blue', 'aqua', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'brown', 'gray'];

/** Swatch colours (fill and text) for events, matching the select-option palette. */
export const COLOR_HEX: Record<EventColor, string> = {
  gray: '#8a8f98',
  brown: '#a27763',
  orange: '#e8833a',
  yellow: '#d9a400',
  green: '#3aa76d',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#e05297',
  red: '#e5484d',
  aqua: '#14b8c4',
};

/** Reminder choices, in minutes before the start. */
export const REMINDERS: { value: number | null; label: string }[] = [
  { value: null, label: 'No reminder' },
  { value: 0, label: 'At the start' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
  { value: 1440, label: '1 day before' },
  { value: 2880, label: '2 days before' },
  { value: 10080, label: '1 week before' },
];

export const STATUS_LABELS: Record<TaskStatus, string> = { todo: 'To do', doing: 'In progress', done: 'Done' };

export interface CalendarEvent {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  color: EventColor;
  status: TaskStatus | null;
  repeat: RepeatRule | null;
  /** Minutes before the start to remind people (0 = at the start); null for none. */
  reminder: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  locations: Location[];
}

export interface CalendarCard {
  pageId: string;
  rowId: string;
  fieldId: string;
  fieldName: string;
  date: string;
  endDate: string | null;
  title: string;
  status: string | null;
  statusColor: string | null;
  pageTitle: string;
  pageIcon: string;
  pageType: PageType;
  repeat: RepeatRule | null;
}

export interface CalendarBlock {
  pageId: string;
  rowId: string | null;
  rowTitle: string | null;
  blockId: string;
  date: string;
  text: string;
  done: boolean | null;
  pageTitle: string;
  pageIcon: string;
  pageType: PageType;
}

export interface CalendarData {
  events: CalendarEvent[];
  cards: CalendarCard[];
  blocks: CalendarBlock[];
}

export type EventInput = Partial<Omit<CalendarEvent, 'id' | 'workspaceId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'locations'>>;

const calendarKey = (workspaceId: string) => ['calendar', workspaceId] as const;

export function useCalendar(workspaceId: string, from: string, to: string) {
  return useQuery({
    queryKey: [...calendarKey(workspaceId), from, to],
    queryFn: () => api<CalendarData>(`/api/workspaces/${workspaceId}/calendar?from=${from}&to=${to}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
}

export const refreshCalendar = (workspaceId: string) => queryClient.invalidateQueries({ queryKey: calendarKey(workspaceId) });

export function useEvent(eventId: string | null) {
  return useQuery({
    queryKey: ['event', eventId],
    queryFn: () => api<{ event: CalendarEvent }>(`/api/events/${eventId}`).then((r) => r.event),
    enabled: !!eventId,
  });
}

function afterChange(workspaceId: string, eventId?: string) {
  refreshCalendar(workspaceId);
  // Tasks and reminders come from events too.
  queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId] });
  queryClient.invalidateQueries({ queryKey: ['notifications'] });
  if (eventId) queryClient.invalidateQueries({ queryKey: ['event', eventId] });
}

export async function createEvent(workspaceId: string, input: EventInput & { startDate: string }, place?: PlaceTarget) {
  const { event } = await api<{ event: CalendarEvent }>(`/api/workspaces/${workspaceId}/events`, { method: 'POST', body: { ...input, place } });
  afterChange(workspaceId);
  return event;
}

export async function updateEvent(workspaceId: string, eventId: string, patch: EventInput) {
  const { event } = await api<{ event: CalendarEvent }>(`/api/events/${eventId}`, { method: 'PATCH', body: patch });
  afterChange(workspaceId, eventId);
  return event;
}

export async function deleteEvent(workspaceId: string, eventId: string) {
  await api(`/api/events/${eventId}`, { method: 'DELETE' });
  afterChange(workspaceId, eventId);
}

export async function placeEvent(workspaceId: string, eventId: string, target: PlaceTarget | null, keepExisting = false) {
  const r = await api<{ locations: Location[] }>(`/api/events/${eventId}/place`, { method: 'POST', body: { target, keepExisting } });
  afterChange(workspaceId, eventId);
  return r.locations;
}

// ---------- cards ----------

export interface CardField {
  id: string;
  name: string;
  type: string;
  primary?: boolean;
  options?: { id: string; name: string; color: string }[];
}

export interface CardDetail {
  id: string;
  cells: Record<string, unknown>;
  repeat: RepeatRule | null;
  fields: CardField[];
}

export function useCard(pageId: string | null, rowId: string | null) {
  return useQuery({
    queryKey: ['card', pageId, rowId],
    queryFn: () => api<{ row: CardDetail; canEdit: boolean }>(`/api/pages/${pageId}/rows/${rowId}`),
    enabled: !!pageId && !!rowId,
  });
}

export async function setCardCells(workspaceId: string, pageId: string, rowId: string, cells: Record<string, unknown>) {
  await api(`/api/pages/${pageId}/rows/${rowId}/cells`, { method: 'PATCH', body: { cells } });
  refreshCalendar(workspaceId);
  queryClient.invalidateQueries({ queryKey: ['card', pageId, rowId] });
}

export async function setCardRepeat(workspaceId: string, pageId: string, rowId: string, rule: RepeatRule | null) {
  await api(`/api/pages/${pageId}/rows/${rowId}/repeat`, { method: 'PUT', body: { rule } });
  refreshCalendar(workspaceId);
  queryClient.invalidateQueries({ queryKey: ['card', pageId, rowId] });
}
