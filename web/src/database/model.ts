import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { getDirectory } from '../lib/directory';

export type FieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'checklist'
  | 'media'
  | 'created_time'
  | 'last_edited'
  | 'relation'
  | 'rollup'
  | 'formula'
  | 'person'
  | 'email'
  | 'phone'
  | 'unique_id'
  | 'created_by'
  | 'edited_by'
  | 'button'
  /** The tasks placed inside each card's page, with whether they're done (filled in while reading). */
  | 'tasks'
  /** Text written by the AI from the property's prompt, the card's other properties and its page. */
  | 'ai'
  /** Only in menus: makes a single select set up as a status (see `Field.status`). */
  | 'status';

/** Properties worked out from other values (never typed in). */
export const COMPUTED_TYPES = new Set<FieldType>(['rollup', 'formula', 'created_time', 'last_edited', 'created_by', 'edited_by', 'unique_id', 'button', 'tasks']);

/** Status groups: every status option belongs to one. */
export type StatusGroup = 'todo' | 'doing' | 'done';
export const STATUS_GROUPS: { group: StatusGroup; label: string }[] = [
  { group: 'todo', label: 'To-do' },
  { group: 'doing', label: 'In progress' },
  { group: 'done', label: 'Complete' },
];

/** What a button property does when clicked. Values "@today", "@now" and "@me" are filled in then. */
export type ButtonAction = { type: 'set'; fieldId: string; value: unknown } | { type: 'url'; url: string };

export interface ButtonConfig {
  label: string;
  actions: ButtonAction[];
}

/** A relation links cards to cards of another database (by id). */
export interface RelationConfig {
  /** The other database's page. */
  pageId: string;
  /** Two-way relations: the matching property in the other database. */
  pairedFieldId?: string | null;
  /** This is the "linked from" side: its values come from the paired property over there. */
  reverse?: boolean;
}

export type RollupFn =
  | 'count'
  | 'count_values'
  | 'count_unique'
  | 'sum'
  | 'average'
  | 'min'
  | 'max'
  | 'percent_checked'
  | 'percent_done'
  | 'earliest'
  | 'latest'
  | 'show';

/** A rollup sums up a property of the cards linked through a relation. */
export interface RollupConfig {
  relationField: string | null;
  targetField: string | null;
  fn: RollupFn;
}

export type ViewType = 'grid' | 'board' | 'calendar' | 'timeline' | 'chart' | 'form' | 'list' | 'gallery' | 'feed';

export const VIEW_TYPES: { type: ViewType; label: string }[] = [
  { type: 'grid', label: 'Grid' },
  { type: 'board', label: 'Board' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'timeline', label: 'Timeline' },
  { type: 'chart', label: 'Chart' },
  { type: 'form', label: 'Form builder' },
  { type: 'list', label: 'List' },
  { type: 'gallery', label: 'Gallery' },
  { type: 'feed', label: 'Feed' },
];

export type ChartKind = 'bar' | 'hbar' | 'line' | 'pie' | 'donut';

export interface ChartSettings {
  kind: ChartKind;
  groupBy: string | null;
  metric: 'count' | 'sum' | 'avg';
  valueField: string | null;
}

export interface FormSettings {
  published: boolean;
  title: string;
  description: string;
  submitText: string;
  items: { fieldId: string; required: boolean }[];
}

export interface SelectOption {
  id: string;
  name: string;
  color: string;
  /** Status properties: which group the option is in. */
  group?: StatusGroup;
}

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  primary?: boolean;
  options?: SelectOption[];
  width?: number;
  relation?: RelationConfig;
  rollup?: RollupConfig;
  /** The formula, for formula properties (see formula.ts). */
  formula?: string;
  /** A single select used as a status: its options are grouped into to-do, in progress and complete. */
  status?: boolean;
  /** Unique ID properties: text shown before the number (e.g. "TASK"), and the next number to give. */
  prefix?: string;
  nextId?: number;
  button?: ButtonConfig;
  /** Files & media: also show every file attached inside the card's page. */
  autoFiles?: boolean;
  /** Status properties set up before "taskDone": move the card between To-do / In progress / Complete. */
  followTasks?: boolean;
  /** Status and single-select properties: the option the card is set to once all the tasks in it are done… */
  taskDone?: string;
  /** …and the one it goes back to when a task is reopened (none: it stays). */
  taskUndone?: string;
  /** Checkbox and status/select properties: properties to fill in when a card is marked done (see DoneQuestions). */
  askOnDone?: { fieldId: string; required?: boolean }[];
  /** AI autofill properties: what the AI should write for each card. */
  aiPrompt?: string;
  /** Worked out while reading (not stored): titles of linked cards, for relations. */
  titles?: Map<string, string>;
}

export interface MediaItem {
  url: string;
  name: string;
  type: string;
}

export interface TaskItem {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  startDate: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Row {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Who added the card and who changed it last (user ids). */
  createdBy?: string;
  updatedBy?: string;
  cells: Record<string, unknown>;
  /** Set when the card repeats (see calendar/repeat.ts). */
  repeat?: unknown;
}

export interface Sort {
  fieldId: string;
  dir: 'asc' | 'desc';
}

export type FilterOp = 'contains' | 'not_contains' | 'is' | 'is_not' | 'is_empty' | 'is_not_empty' | 'gt' | 'lt';

export interface Filter {
  id: string;
  fieldId: string;
  op: FilterOp;
  value?: unknown;
}

export interface View {
  id: string;
  name: string;
  type: ViewType;
  groupBy: string | null;
  dateField: string | null;
  /** Timeline: optional end date (start is `dateField`). */
  endField: string | null;
  /** Gallery: the files & media property used as each card's cover. */
  coverField: string | null;
  chart: ChartSettings | null;
  form: FormSettings | null;
  sorts: Sort[];
  filters: Filter[];
  /** Whether a row must match every filter ('and') or any of them ('or'). */
  filterMode: 'and' | 'or';
  hidden: string[];
  /** Grid totals: the calculation under each property. */
  calcs: Record<string, string>;
  /** Board: a second property that splits the board into rows (swimlanes). */
  subGroupBy: string | null;
}

/** A card template: the properties and body a new card starts with. Its body is the card document "tpl_…". */
export interface CardTemplate {
  id: string;
  name: string;
  cells: Record<string, unknown>;
  /** Used by the New button. */
  isDefault: boolean;
}

/** Settings for the whole database. */
export interface DatabaseSettings {
  /** Sub-items: each card can have a parent card (stored) and lists its sub-items (worked out). */
  subItems?: { parentField: string; childField: string } | null;
  /** Dependencies: cards blocked by other cards (stored), and what each blocks (worked out). */
  dependencies?: { blockedByField: string; blockingField: string } | null;
  /** Locked: views and properties can't be changed (cards still can). */
  locked?: boolean;
  automations?: Automation[];
}

/** "When … then …" rules the server runs on the database. */
export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { type: 'added' } | { type: 'changed'; fieldId: string; value?: unknown };
  actions: ({ type: 'set'; fieldId: string; value: unknown } | { type: 'notify'; userIds: string[]; personField?: string | null; message: string })[];
}

export interface DatabaseState {
  fields: Field[];
  rows: Row[];
  views: View[];
  templates: CardTemplate[];
  settings: DatabaseSettings;
}

export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'number', label: 'Number' },
  { type: 'status', label: 'Status' },
  { type: 'select', label: 'Single select' },
  { type: 'multi_select', label: 'Multi-select' },
  { type: 'person', label: 'Person' },
  { type: 'date', label: 'Date' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'url', label: 'URL' },
  { type: 'email', label: 'Email' },
  { type: 'phone', label: 'Phone' },
  { type: 'checklist', label: 'Checklist' },
  { type: 'tasks', label: 'Tasks' },
  { type: 'ai', label: 'AI autofill' },
  { type: 'media', label: 'Files & media' },
  { type: 'created_time', label: 'Created time' },
  { type: 'last_edited', label: 'Last edited' },
  { type: 'created_by', label: 'Created by' },
  { type: 'edited_by', label: 'Last edited by' },
  { type: 'unique_id', label: 'ID' },
  { type: 'button', label: 'Button' },
  { type: 'relation', label: 'Relation' },
  { type: 'rollup', label: 'Rollup' },
  { type: 'formula', label: 'Formula' },
];

export const OPTION_COLORS: Record<string, string> = {
  purple: 'rgba(156, 112, 255, 0.28)',
  pink: 'rgba(238, 105, 180, 0.28)',
  lightpink: 'rgba(255, 162, 189, 0.3)',
  orange: 'rgba(255, 145, 77, 0.3)',
  yellow: 'rgba(255, 206, 54, 0.35)',
  lime: 'rgba(168, 222, 66, 0.32)',
  green: 'rgba(61, 195, 120, 0.3)',
  aqua: 'rgba(64, 205, 222, 0.3)',
  blue: 'rgba(76, 137, 255, 0.3)',
  gray: 'rgba(150, 150, 150, 0.25)',
};

/** Property types a public form can ask for. */
export const FORM_FIELD_TYPES = new Set<FieldType>(['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url']);

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

const colorKeys = Object.keys(OPTION_COLORS);
export const nextColor = (n: number) => colorKeys[n % (colorKeys.length - 1)];

type YRecord = Y.Map<unknown>;

function ymap(entries: Record<string, unknown>) {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

function readFields(arr: Y.Array<YRecord>): Field[] {
  return arr
    .toArray()
    .filter((m): m is YRecord => m instanceof Y.Map)
    .map((m) => ({
      id: String(m.get('id')),
      name: String(m.get('name') ?? ''),
      type: (m.get('type') as FieldType) ?? 'text',
      primary: m.get('primary') === true,
      options: (m.get('options') as SelectOption[] | undefined) ?? [],
      width: (m.get('width') as number | undefined) ?? 180,
      relation: (m.get('relation') as RelationConfig | undefined) ?? undefined,
      rollup: (m.get('rollup') as RollupConfig | undefined) ?? undefined,
      formula: (m.get('formula') as string | undefined) ?? undefined,
      status: m.get('status') === true || undefined,
      prefix: (m.get('prefix') as string | undefined) ?? undefined,
      nextId: (m.get('nextId') as number | undefined) ?? undefined,
      button: (m.get('button') as ButtonConfig | undefined) ?? undefined,
      autoFiles: m.get('autoFiles') === true || undefined,
      followTasks: m.get('followTasks') === true || undefined,
      taskDone: typeof m.get('taskDone') === 'string' ? (m.get('taskDone') as string) : undefined,
      taskUndone: typeof m.get('taskUndone') === 'string' ? (m.get('taskUndone') as string) : undefined,
      aiPrompt: typeof m.get('aiPrompt') === 'string' ? (m.get('aiPrompt') as string) : undefined,
      askOnDone: Array.isArray(m.get('askOnDone')) ? (m.get('askOnDone') as Field['askOnDone']) : undefined,
    }));
}

/** The options a new status property starts with. */
export const defaultStatusOptions = (): SelectOption[] => [
  { id: newId(), name: 'Not started', color: 'gray', group: 'todo' },
  { id: newId(), name: 'In progress', color: 'blue', group: 'doing' },
  { id: newId(), name: 'Done', color: 'green', group: 'done' },
];

/** The person using the app (for "created by" and "last edited by"). */
const me = () => getDirectory()?.user.id;

function readRows(arr: Y.Array<YRecord>): Row[] {
  return arr
    .toArray()
    .filter((m): m is YRecord => m instanceof Y.Map)
    .map((m) => {
      const cells = m.get('cells');
      return {
        id: String(m.get('id')),
        createdAt: Number(m.get('createdAt') ?? 0),
        updatedAt: Number(m.get('updatedAt') ?? 0),
        cells: cells instanceof Y.Map ? (cells.toJSON() as Record<string, unknown>) : {},
        repeat: m.get('repeat') ?? undefined,
        createdBy: (m.get('createdBy') as string | undefined) ?? undefined,
        updatedBy: (m.get('updatedBy') as string | undefined) ?? undefined,
      };
    });
}

function readTemplates(arr: Y.Array<YRecord>): CardTemplate[] {
  return arr
    .toArray()
    .filter((m): m is YRecord => m instanceof Y.Map)
    .map((m) => {
      const cells = m.get('cells');
      return {
        id: String(m.get('id')),
        name: String(m.get('name') ?? ''),
        cells: cells instanceof Y.Map ? (cells.toJSON() as Record<string, unknown>) : {},
        isDefault: m.get('isDefault') === true,
      };
    });
}

/** A card template shown as a row, for editing it in the card view. */
export const templateAsRow = (t: CardTemplate): Row => ({ id: t.id, createdAt: 0, updatedAt: 0, cells: t.cells });

function readViews(arr: Y.Array<YRecord>): View[] {
  return arr
    .toArray()
    .filter((m): m is YRecord => m instanceof Y.Map)
    .map((m) => ({
      id: String(m.get('id')),
      name: String(m.get('name') ?? ''),
      type: (m.get('type') as ViewType) ?? 'grid',
      groupBy: (m.get('groupBy') as string | null) ?? null,
      dateField: (m.get('dateField') as string | null) ?? null,
      endField: (m.get('endField') as string | null) ?? null,
      coverField: (m.get('coverField') as string | null) ?? null,
      chart: (m.get('chart') as ChartSettings | null) ?? null,
      form: (m.get('form') as FormSettings | null) ?? null,
      sorts: (m.get('sorts') as Sort[] | undefined) ?? [],
      filters: (m.get('filters') as Filter[] | undefined) ?? [],
      filterMode: m.get('filterMode') === 'or' ? 'or' : 'and',
      hidden: (m.get('hidden') as string[] | undefined) ?? [],
      calcs: (m.get('calcs') as Record<string, string> | undefined) ?? {},
      subGroupBy: (m.get('subGroupBy') as string | null | undefined) ?? null,
    }));
}

/** Converts boards created before databases existed (columns of cards) into a database. */
function migrateLegacyBoard(doc: Y.Doc) {
  const columns = doc.getArray<YRecord>('columns');
  const fields = doc.getArray<YRecord>('fields');
  if (fields.length > 0 || columns.length === 0) return;
  doc.transact(() => {
    const nameId = newId();
    const statusId = newId();
    const descId = newId();
    const options: SelectOption[] = [];
    const rows = doc.getArray<YRecord>('rows');
    columns.toArray().forEach((col, i) => {
      const optionId = newId();
      options.push({ id: optionId, name: String(col.get('title') ?? 'Untitled'), color: nextColor(i) });
      const cards = col.get('cards');
      if (!(cards instanceof Y.Array)) return;
      for (const card of cards.toArray()) {
        if (!(card instanceof Y.Map)) continue;
        const cells = new Y.Map<unknown>();
        cells.set(nameId, String(card.get('title') ?? ''));
        cells.set(statusId, optionId);
        if (card.get('description')) cells.set(descId, String(card.get('description')));
        rows.push([ymap({ id: newId(), createdAt: Date.now(), updatedAt: Date.now(), cells })]);
      }
    });
    fields.push([
      ymap({ id: nameId, name: 'Name', type: 'text', primary: true, width: 240 }),
      ymap({ id: statusId, name: 'Status', type: 'select', options, width: 160 }),
      ymap({ id: descId, name: 'Description', type: 'text', width: 240 }),
    ]);
    doc.getArray<YRecord>('views').push([
      ymap({ id: newId(), name: 'Board', type: 'board', groupBy: statusId, dateField: null, sorts: [], filters: [], hidden: [descId] }),
    ]);
    columns.delete(0, columns.length);
  });
}

function ensureMinimal(doc: Y.Doc, fallbackView: ViewType) {
  const fields = doc.getArray<YRecord>('fields');
  const views = doc.getArray<YRecord>('views');
  if (fields.length > 0 && views.length > 0) return;
  doc.transact(() => {
    if (fields.length === 0) fields.push([ymap({ id: newId(), name: 'Name', type: 'text', primary: true, width: 240 })]);
    if (views.length === 0) {
      views.push([ymap({ id: newId(), name: viewLabel(fallbackView), type: fallbackView, groupBy: null, dateField: null, sorts: [], filters: [], hidden: [] })]);
    }
  });
}

export function viewLabel(type: ViewType) {
  return VIEW_TYPES.find((v) => v.type === type)?.label.replace(' builder', '') ?? 'Grid';
}

/** Live, collaborative access to a database stored in a Yjs document. */
export function useDatabase(doc: Y.Doc, fallbackView: ViewType) {
  const arrays = useMemo(
    () => ({
      fields: doc.getArray<YRecord>('fields'),
      rows: doc.getArray<YRecord>('rows'),
      views: doc.getArray<YRecord>('views'),
      templates: doc.getArray<YRecord>('cardTemplates'),
      settings: doc.getMap<unknown>('dbSettings'),
    }),
    [doc],
  );

  const read = (): DatabaseState => ({
    fields: readFields(arrays.fields),
    rows: readRows(arrays.rows),
    views: readViews(arrays.views),
    templates: readTemplates(arrays.templates),
    settings: arrays.settings.toJSON() as DatabaseSettings,
  });
  const [state, setState] = useState<DatabaseState>(read);

  useEffect(() => {
    migrateLegacyBoard(doc);
    ensureMinimal(doc, fallbackView);
    const update = () => setState(read());
    arrays.fields.observeDeep(update);
    arrays.rows.observeDeep(update);
    arrays.views.observeDeep(update);
    arrays.templates.observeDeep(update);
    arrays.settings.observeDeep(update);
    update();
    return () => {
      arrays.fields.unobserveDeep(update);
      arrays.rows.unobserveDeep(update);
      arrays.views.unobserveDeep(update);
      arrays.templates.unobserveDeep(update);
      arrays.settings.unobserveDeep(update);
    };
  }, [arrays]);

  const actions = useMemo(() => createActions(doc, arrays), [doc, arrays]);
  return { db: state, actions };
}

function createActions(
  doc: Y.Doc,
  a: { fields: Y.Array<YRecord>; rows: Y.Array<YRecord>; views: Y.Array<YRecord>; templates: Y.Array<YRecord>; settings: Y.Map<unknown> },
) {
  const find = (arr: Y.Array<YRecord>, id: string) => {
    const index = arr.toArray().findIndex((m) => m.get('id') === id);
    return index < 0 ? null : { index, map: arr.get(index) };
  };
  // A key set to undefined is removed (so turning a setting off leaves nothing behind).
  const setAll = (m: YRecord, patch: Record<string, unknown>) => Object.entries(patch).forEach(([k, v]) => (v === undefined ? m.delete(k) : m.set(k, v)));
  const touch = (row: YRecord) => {
    row.set('updatedAt', Date.now());
    const user = me();
    if (user && row.get('updatedBy') !== user) row.set('updatedBy', user);
  };
  /** Gives a new card the next number of every unique ID property. */
  const numberRow = (cells: Y.Map<unknown>) => {
    for (const f of a.fields.toArray()) {
      if (f.get('type') !== 'unique_id') continue;
      const id = String(f.get('id'));
      if (cells.has(id)) continue;
      const next = (f.get('nextId') as number | undefined) ?? 1;
      cells.set(id, next);
      f.set('nextId', next + 1);
    }
  };

  const actions = {
    // ----- fields -----
    addField(type: FieldType = 'text', name?: string, index?: number, extra: Partial<Pick<Field, 'relation' | 'rollup' | 'formula'>> & { id?: string } = {}): string {
      const id = extra.id ?? newId();
      const count = a.fields.length;
      const status = type === 'status';
      const options = status ? defaultStatusOptions() : type === 'select' || type === 'multi_select' ? [] : undefined;
      const { id: _, ...config } = extra;
      const field = ymap({
        id,
        name: name ?? fieldTypeLabel(type),
        type: status ? 'select' : type,
        width: 180,
        ...(options ? { options } : {}),
        ...(status ? { status: true } : {}),
        ...(type === 'button' ? { button: { label: name ?? 'Button', actions: [] } } : {}),
        ...config,
      });
      doc.transact(() => {
        a.fields.insert(index === undefined ? count : Math.min(index, count), [field]);
        // Existing cards are numbered in their current order.
        if (type === 'unique_id') {
          let n = 1;
          for (const row of a.rows.toArray()) (row.get('cells') as Y.Map<unknown>).set(id, n++);
          field.set('nextId', n);
        }
      });
      return id;
    },
    updateField(id: string, patch: Partial<Omit<Field, 'id'>>) {
      const f = find(a.fields, id);
      if (!f) return;
      doc.transact(() => {
        if (patch.type && (patch.type === 'select' || patch.type === 'multi_select') && !f.map.get('options')) {
          f.map.set('options', []);
        }
        setAll(f.map, patch as Record<string, unknown>);
      });
    },
    changeFieldType(id: string, type: FieldType) {
      const f = find(a.fields, id);
      if (!f) return;
      const from = f.map.get('type') as FieldType;
      if (type === 'status') {
        // A select becomes a status: its options keep their names and are put into groups.
        doc.transact(() => {
          if (from !== 'select') actions.changeFieldType(id, 'select');
          const options = ((f.map.get('options') as SelectOption[] | undefined) ?? []).map((o) => ({ ...o, group: o.group ?? guessGroup(o.name) }));
          f.map.set('options', options.length ? options : defaultStatusOptions());
          f.map.set('status', true);
        });
        return;
      }
      if (from === 'select' && type === 'select' && f.map.get('status')) {
        f.map.delete('status');
        return;
      }
      if (from === type) return;
      doc.transact(() => {
        f.map.delete('status');
        let options = (f.map.get('options') as SelectOption[] | undefined) ?? [];
        // Convert existing values so data isn't lost when switching types.
        for (const row of a.rows.toArray()) {
          const cells = row.get('cells') as Y.Map<unknown>;
          const value = cells.get(id);
          if (value === undefined || value === null || value === '') continue;
          const text = valueToText({ id, name: '', type: from, options }, value);
          let next: unknown;
          if (type === 'text' || type === 'url') next = text;
          else if (type === 'number') next = Number.isFinite(Number(text)) ? Number(text) : null;
          else if (type === 'checkbox') next = text === 'Yes' || text === 'true' || !!value;
          else if (type === 'select' || type === 'multi_select') {
            const names = text.split(',').map((s) => s.trim()).filter(Boolean);
            const ids = names.map((n) => {
              let opt = options.find((o) => o.name === n);
              if (!opt) {
                opt = { id: newId(), name: n, color: nextColor(options.length) };
                options = [...options, opt];
              }
              return opt.id;
            });
            next = type === 'select' ? ids[0] ?? null : ids;
          } else if (type === 'date') next = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
          else next = null;
          cells.set(id, next);
        }
        f.map.set('type', type);
        if (type === 'select' || type === 'multi_select') f.map.set('options', options);
      });
    },
    deleteField(id: string) {
      const f = find(a.fields, id);
      if (!f || f.map.get('primary')) return;
      doc.transact(() => {
        a.fields.delete(f.index, 1);
        for (const row of a.rows.toArray()) (row.get('cells') as Y.Map<unknown>).delete(id);
        for (const view of a.views.toArray()) {
          if (view.get('groupBy') === id) view.set('groupBy', null);
          if (view.get('dateField') === id) view.set('dateField', null);
          if (view.get('endField') === id) view.set('endField', null);
          if (view.get('coverField') === id) view.set('coverField', null);
          const chart = view.get('chart') as ChartSettings | null;
          if (chart && (chart.groupBy === id || chart.valueField === id)) {
            view.set('chart', { ...chart, groupBy: chart.groupBy === id ? null : chart.groupBy, valueField: chart.valueField === id ? null : chart.valueField });
          }
          const form = view.get('form') as FormSettings | null;
          if (form?.items.some((i) => i.fieldId === id)) view.set('form', { ...form, items: form.items.filter((i) => i.fieldId !== id) });
          view.set('sorts', ((view.get('sorts') as Sort[]) ?? []).filter((s) => s.fieldId !== id));
          view.set('filters', ((view.get('filters') as Filter[]) ?? []).filter((s) => s.fieldId !== id));
        }
      });
    },
    duplicateField(id: string) {
      const f = find(a.fields, id);
      if (!f) return;
      const copyId = newId();
      doc.transact(() => {
        const json = f.map.toJSON();
        // A copy of a two-way relation is one-way (the other database only knows the original).
        if (json.relation) json.relation = { pageId: json.relation.pageId, reverse: json.relation.reverse, pairedFieldId: json.relation.reverse ? json.relation.pairedFieldId : null };
        a.fields.insert(f.index + 1, [ymap({ ...json, id: copyId, name: `${json.name} (copy)`, primary: false })]);
        for (const row of a.rows.toArray()) {
          const cells = row.get('cells') as Y.Map<unknown>;
          if (cells.has(id)) cells.set(copyId, structuredClone(cells.get(id)));
        }
      });
    },
    moveField(id: string, toIndex: number) {
      const f = find(a.fields, id);
      if (!f) return;
      doc.transact(() => {
        const json = f.map.toJSON();
        a.fields.delete(f.index, 1);
        const target = toIndex > f.index ? toIndex - 1 : toIndex;
        a.fields.insert(Math.max(0, Math.min(target, a.fields.length)), [ymap(json)]);
      });
    },

    // ----- select options -----
    addOption(fieldId: string, name: string): string {
      const f = find(a.fields, fieldId);
      const id = newId();
      if (!f) return id;
      const options = (f.map.get('options') as SelectOption[] | undefined) ?? [];
      // A new status goes in the group its name suggests.
      const group = f.map.get('status') ? { group: guessGroup(name) } : {};
      f.map.set('options', [...options, { id, name, color: nextColor(options.length), ...group }]);
      return id;
    },
    updateOption(fieldId: string, optionId: string, patch: Partial<Omit<SelectOption, 'id'>>) {
      const f = find(a.fields, fieldId);
      if (!f) return;
      const options = (f.map.get('options') as SelectOption[] | undefined) ?? [];
      f.map.set('options', options.map((o) => (o.id === optionId ? { ...o, ...patch } : o)));
    },
    deleteOption(fieldId: string, optionId: string) {
      const f = find(a.fields, fieldId);
      if (!f) return;
      doc.transact(() => {
        const options = (f.map.get('options') as SelectOption[] | undefined) ?? [];
        f.map.set('options', options.filter((o) => o.id !== optionId));
        for (const row of a.rows.toArray()) {
          const cells = row.get('cells') as Y.Map<unknown>;
          const v = cells.get(fieldId);
          if (v === optionId) cells.set(fieldId, null);
          else if (Array.isArray(v) && v.includes(optionId)) cells.set(fieldId, v.filter((x) => x !== optionId));
        }
      });
    },
    moveOption(fieldId: string, optionId: string, toIndex: number) {
      const f = find(a.fields, fieldId);
      if (!f) return;
      const options = [...((f.map.get('options') as SelectOption[] | undefined) ?? [])];
      const from = options.findIndex((o) => o.id === optionId);
      if (from < 0) return;
      const [opt] = options.splice(from, 1);
      options.splice(toIndex > from ? toIndex - 1 : toIndex, 0, opt);
      f.map.set('options', options);
    },

    // ----- rows -----
    addRow(cells: Record<string, unknown> = {}, index?: number): string {
      const id = newId();
      const ycells = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(cells)) ycells.set(k, v);
      const now = Date.now();
      const user = me();
      const row = ymap({ id, createdAt: now, updatedAt: now, cells: ycells, ...(user ? { createdBy: user, updatedBy: user } : {}) });
      doc.transact(() => {
        numberRow(ycells);
        a.rows.insert(index === undefined ? a.rows.length : Math.max(0, Math.min(index, a.rows.length)), [row]);
      });
      return id;
    },
    updateCell(rowId: string, fieldId: string, value: unknown) {
      // Card templates are edited like cards.
      const r = find(a.rows, rowId) ?? find(a.templates, rowId);
      if (!r) return;
      doc.transact(() => {
        (r.map.get('cells') as Y.Map<unknown>).set(fieldId, value);
        touch(r.map);
      });
    },
    deleteRow(rowId: string) {
      const r = find(a.rows, rowId);
      if (r) a.rows.delete(r.index, 1);
    },
    duplicateRow(rowId: string): string | null {
      const r = find(a.rows, rowId);
      if (!r) return null;
      const json = (r.map.get('cells') as Y.Map<unknown>).toJSON();
      for (const f of a.fields.toArray()) if (f.get('type') === 'unique_id') delete json[String(f.get('id'))];
      return actions.addRow(structuredClone(json), r.index + 1);
    },
    // ----- database settings -----
    setSetting<K extends keyof DatabaseSettings>(key: K, value: DatabaseSettings[K] | null) {
      if (value === undefined || value === null) a.settings.delete(key);
      else a.settings.set(key, value);
    },
    /**
     * A pair of linked properties within this database (e.g. "Parent item" and "Sub-items"): the first
     * is stored, the second lists the cards pointing at each card. `selfId` is this database's page.
     */
    addSelfRelation(selfId: string, storedName: string, listedName: string): { stored: string; listed: string } {
      const stored = newId();
      const listed = newId();
      doc.transact(() => {
        a.fields.push([ymap({ id: stored, name: storedName, type: 'relation', width: 180, relation: { pageId: selfId, pairedFieldId: listed } })]);
        a.fields.push([ymap({ id: listed, name: listedName, type: 'relation', width: 180, relation: { pageId: selfId, pairedFieldId: stored, reverse: true } })]);
      });
      return { stored, listed };
    },
    // ----- card templates -----
    addTemplate(name: string, cells: Record<string, unknown> = {}): string {
      const id = `tpl_${newId()}`;
      const ycells = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(cells)) ycells.set(k, v);
      a.templates.push([ymap({ id, name, cells: ycells, isDefault: false })]);
      return id;
    },
    renameTemplate(id: string, name: string) {
      find(a.templates, id)?.map.set('name', name);
    },
    deleteTemplate(id: string) {
      const t = find(a.templates, id);
      if (t) a.templates.delete(t.index, 1);
    },
    /** The template the New button uses (null: an empty card). */
    setDefaultTemplate(id: string | null) {
      doc.transact(() => a.templates.forEach((m) => m.set('isDefault', m.get('id') === id)));
    },
    /** Moves a row in the shared order (used by drag and drop in every view). */
    moveRow(rowId: string, toIndex: number, cellPatch?: Record<string, unknown>) {
      const r = find(a.rows, rowId);
      if (!r) return;
      doc.transact(() => {
        const json = r.map.toJSON() as { id: string; createdAt: number; updatedAt: number; cells: Record<string, unknown> };
        a.rows.delete(r.index, 1);
        const target = toIndex > r.index ? toIndex - 1 : toIndex;
        const cells = new Y.Map<unknown>();
        for (const [k, v] of Object.entries({ ...json.cells, ...cellPatch })) cells.set(k, v);
        a.rows.insert(Math.max(0, Math.min(target, a.rows.length)), [
          ymap({ id: json.id, createdAt: json.createdAt, updatedAt: cellPatch ? Date.now() : json.updatedAt, cells }),
        ]);
      });
    },

    // ----- views -----
    addView(type: ViewType): string {
      const id = newId();
      doc.transact(() => {
        const fields = readFields(a.fields);
        let groupBy: string | null = null;
        let dateField: string | null = null;
        if (type === 'board') {
          groupBy = fields.find((f) => f.type === 'select')?.id ?? null;
          if (!groupBy) {
            groupBy = newId();
            a.fields.push([
              ymap({
                id: groupBy,
                name: 'Status',
                type: 'select',
                width: 160,
                options: [
                  { id: newId(), name: 'To Do', color: 'purple' },
                  { id: newId(), name: 'Doing', color: 'orange' },
                  { id: newId(), name: 'Done', color: 'green' },
                ],
              }),
            ]);
          }
        }
        const dates = fields.filter((f) => f.type === 'date');
        if (type === 'calendar' || type === 'timeline') {
          dateField = dates[0]?.id ?? null;
          if (!dateField) {
            dateField = newId();
            a.fields.push([ymap({ id: dateField, name: type === 'timeline' ? 'Start' : 'Date', type: 'date', width: 160 })]);
          }
        }
        let endField: string | null = null;
        if (type === 'timeline') {
          endField = dates[1]?.id ?? null;
          if (!endField) {
            endField = newId();
            a.fields.push([ymap({ id: endField, name: 'End', type: 'date', width: 160 })]);
          }
        }
        let chart: ChartSettings | null = null;
        if (type === 'chart') {
          const group = fields.find((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'checkbox') ?? fields.find((f) => !f.primary);
          chart = { kind: 'bar', groupBy: group?.id ?? null, metric: 'count', valueField: fields.find((f) => f.type === 'number')?.id ?? null };
        }
        let form: FormSettings | null = null;
        if (type === 'form') {
          form = {
            published: false,
            title: 'Form',
            description: '',
            submitText: 'Submit',
            items: fields.filter((f) => FORM_FIELD_TYPES.has(f.type)).map((f) => ({ fieldId: f.id, required: !!f.primary })),
          };
        }
        const coverField = type === 'gallery' ? (fields.find((f) => f.type === 'media')?.id ?? null) : null;
        const sameType = readViews(a.views).filter((v) => v.type === type).length;
        a.views.push([
          ymap({
            id,
            name: sameType ? `${viewLabel(type)} ${sameType + 1}` : viewLabel(type),
            type,
            groupBy,
            dateField,
            endField,
            coverField,
            chart,
            form,
            sorts: [],
            filters: [],
            hidden: [],
          }),
        ]);
      });
      return id;
    },
    updateView(id: string, patch: Partial<Omit<View, 'id'>>) {
      const v = find(a.views, id);
      if (v) doc.transact(() => setAll(v.map, patch as Record<string, unknown>));
    },
    deleteView(id: string) {
      const v = find(a.views, id);
      if (v && a.views.length > 1) a.views.delete(v.index, 1);
    },
    duplicateView(id: string): string | null {
      const v = find(a.views, id);
      if (!v) return null;
      const copyId = newId();
      const json = v.map.toJSON();
      a.views.insert(v.index + 1, [ymap({ ...structuredClone(json), id: copyId, name: `${json.name} (copy)` })]);
      return copyId;
    },
  };
  return actions;
}

export type DatabaseActions = ReturnType<typeof createActions>;

export function fieldTypeLabel(type: FieldType) {
  return FIELD_TYPES.find((t) => t.type === type)?.label ?? 'Text';
}

/** A property's type as shown to people (a status is a select underneath). */
export const fieldKind = (field: Pick<Field, 'type' | 'status'>): FieldType => (field.type === 'select' && field.status ? 'status' : field.type);

/** Which status group an option probably belongs in, from its name. */
export function guessGroup(name: string): StatusGroup {
  if (/\b(done|complete|completed|finished|closed|resolved|shipped|published)\b/i.test(name)) return 'done';
  if (/\b(doing|progress|started|working|review|active|building|writing)\b/i.test(name)) return 'doing';
  return 'todo';
}

/** Whether a card counts as done by a status (or other select) value. */
export function isDoneOption(field: Field, value: unknown): boolean {
  const opt = field.options?.find((o) => o.id === value);
  if (!opt) return false;
  return field.status ? opt.group === 'done' : /\b(done|complete|completed|finished|closed|resolved)\b/i.test(opt.name);
}

/** "TASK-12" for unique IDs. */
export const formatUniqueId = (field: Field, value: unknown) => (typeof value === 'number' ? (field.prefix ? `${field.prefix}-${value}` : String(value)) : '');

/** People's names for person, created by and last edited by properties. */
export function personNames(ids: unknown): string {
  const members = getDirectory()?.members ?? [];
  const list = Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [];
  return list.map((id) => members.find((m) => m.id === id)?.name ?? '').filter(Boolean).join(', ');
}

export function primaryField(fields: Field[]) {
  return fields.find((f) => f.primary) ?? fields[0];
}

export function rowTitle(fields: Field[], row: Row) {
  const pf = primaryField(fields);
  const v = pf ? row.cells[pf.id] : '';
  return typeof v === 'string' ? v : '';
}

export function cellValue(field: Field, row: Row): unknown {
  if (field.type === 'created_time') return row.createdAt;
  if (field.type === 'last_edited') return row.updatedAt;
  if (field.type === 'created_by') return row.createdBy;
  if (field.type === 'edited_by') return row.updatedBy;
  return row.cells[field.id];
}

export function formatDate(value: unknown, withTime = false) {
  if (value === undefined || value === null || value === '') return '';
  const d = typeof value === 'number' ? new Date(value) : new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) });
}

/** A plain-text rendering of a cell, used for sorting, filtering and type conversion. */
export function valueToText(field: Field, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (field.type) {
    case 'select':
      return field.options?.find((o) => o.id === value)?.name ?? '';
    case 'multi_select':
      return Array.isArray(value) ? value.map((id) => field.options?.find((o) => o.id === id)?.name).filter(Boolean).join(', ') : '';
    case 'checkbox':
      return value ? 'Yes' : 'No';
    case 'date':
      return String(value).slice(0, 10);
    case 'created_time':
    case 'last_edited':
      return formatDate(value, true);
    case 'media':
      return Array.isArray(value) ? (value as MediaItem[]).map((m) => m.name).join(', ') : '';
    case 'checklist':
      return Array.isArray(value) ? (value as ChecklistItem[]).map((c) => c.text).join(', ') : '';
    case 'tasks':
      return Array.isArray(value) && value.length ? `${(value as TaskItem[]).filter((t) => t.status === 'done').length}/${value.length} done` : '';
    case 'relation':
      return Array.isArray(value) ? value.map((id) => field.titles?.get(String(id)) ?? '').filter(Boolean).join(', ') : '';
    case 'person':
    case 'created_by':
    case 'edited_by':
      return personNames(value);
    case 'unique_id':
      return formatUniqueId(field, value);
    case 'button':
      return '';
    case 'rollup':
    case 'formula':
      if (value && typeof value === 'object' && !Array.isArray(value)) return '';
      return Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
    default:
      return String(value);
  }
}

export function isEmptyValue(value: unknown) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) || value === false;
}

function compare(field: Field, a: unknown, b: unknown): number {
  const ea = isEmptyValue(a) && field.type !== 'checkbox';
  const eb = isEmptyValue(b) && field.type !== 'checkbox';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  switch (field.type) {
    case 'number':
    case 'created_time':
    case 'last_edited':
    case 'unique_id':
      return Number(a) - Number(b);
    case 'checkbox':
      return Number(!!a) - Number(!!b);
    case 'select': {
      const order = field.options?.map((o) => o.id) ?? [];
      return order.indexOf(a as string) - order.indexOf(b as string);
    }
    case 'checklist': {
      const pct = (v: unknown) => checklistProgress(v as ChecklistItem[]);
      return pct(a) - pct(b);
    }
    case 'tasks': {
      const pct = (v: unknown) => (Array.isArray(v) && v.length ? (v as TaskItem[]).filter((t) => t.status === 'done').length / v.length : -1);
      return pct(a) - pct(b);
    }
    case 'rollup':
    case 'formula':
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return valueToText(field, a).localeCompare(valueToText(field, b), undefined, { numeric: true, sensitivity: 'base' });
    default:
      return valueToText(field, a).localeCompare(valueToText(field, b), undefined, { numeric: true, sensitivity: 'base' });
  }
}

export function checklistProgress(items: ChecklistItem[] | undefined) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.filter((i) => i.done).length / items.length;
}

const personList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
/** "@me" in a person filter is whoever is looking at the view. */
const personFilterValue = (v: unknown) => (v === '@me' ? (me() ?? '') : String(v));

/** Relative dates a date filter can use, kept as words so they move with the calendar. */
export const RELATIVE_DATES: { value: string; label: string }[] = [
  { value: '@today', label: 'Today' },
  { value: '@tomorrow', label: 'Tomorrow' },
  { value: '@yesterday', label: 'Yesterday' },
  { value: '@this_week', label: 'This week' },
  { value: '@next_week', label: 'Next week' },
  { value: '@last_week', label: 'Last week' },
  { value: '@this_month', label: 'This month' },
  { value: '@next_month', label: 'Next month' },
  { value: '@last_month', label: 'Last month' },
  { value: '@next_7', label: 'Next 7 days' },
  { value: '@past_7', label: 'Past 7 days' },
  { value: '@next_30', label: 'Next 30 days' },
  { value: '@past_30', label: 'Past 30 days' },
];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The first and last day a filter's date value covers (a single day, or a relative period). */
export function dateRange(value: unknown): [string, string] | null {
  const v = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return [v.slice(0, 10), v.slice(0, 10)];
  const now = new Date();
  const day = (offset: number) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  // Weeks start on Monday.
  const weekStart = (offset: number) => {
    const back = (now.getDay() + 6) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back + offset * 7);
  };
  const week = (offset: number): [string, string] => {
    const start = weekStart(offset);
    return [iso(start), iso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6))];
  };
  const month = (offset: number): [string, string] => [iso(new Date(now.getFullYear(), now.getMonth() + offset, 1)), iso(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0))];
  switch (v) {
    case '@today':
      return [day(0), day(0)];
    case '@tomorrow':
      return [day(1), day(1)];
    case '@yesterday':
      return [day(-1), day(-1)];
    case '@this_week':
      return week(0);
    case '@next_week':
      return week(1);
    case '@last_week':
      return week(-1);
    case '@this_month':
      return month(0);
    case '@next_month':
      return month(1);
    case '@last_month':
      return month(-1);
    case '@next_7':
      return [day(0), day(7)];
    case '@past_7':
      return [day(-7), day(0)];
    case '@next_30':
      return [day(0), day(30)];
    case '@past_30':
      return [day(-30), day(0)];
    default:
      return null;
  }
}

const DATE_TYPES = new Set<FieldType>(['date', 'created_time', 'last_edited']);

/** A date cell as YYYY-MM-DD (created/edited times are timestamps). */
function dayOf(value: unknown): string {
  if (typeof value === 'number') return iso(new Date(value));
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function matches(field: Field, filter: Filter, value: unknown): boolean {
  if (DATE_TYPES.has(field.type) && ['is', 'is_not', 'gt', 'lt'].includes(filter.op)) {
    const d = dayOf(value);
    const range = dateRange(filter.value);
    if (!range) return true;
    if (!d) return filter.op === 'is_not';
    if (filter.op === 'is') return d >= range[0] && d <= range[1];
    if (filter.op === 'is_not') return d < range[0] || d > range[1];
    if (filter.op === 'lt') return d < range[0];
    return d > range[1];
  }
  const text = valueToText(field, value).toLowerCase();
  const needle = String(filter.value ?? '').toLowerCase();
  switch (filter.op) {
    case 'is_empty':
      return isEmptyValue(value);
    case 'is_not_empty':
      return !isEmptyValue(value);
    case 'contains':
      if (field.type === 'person' || field.type === 'created_by' || field.type === 'edited_by') return personList(value).includes(personFilterValue(filter.value));
      if (field.type === 'multi_select') return Array.isArray(value) && value.includes(filter.value);
      return text.includes(needle);
    case 'not_contains':
      if (field.type === 'person' || field.type === 'created_by' || field.type === 'edited_by') return !personList(value).includes(personFilterValue(filter.value));
      if (field.type === 'multi_select') return !(Array.isArray(value) && value.includes(filter.value));
      return !text.includes(needle);
    case 'is':
      if (field.type === 'checkbox') return !!value === !!filter.value;
      if (field.type === 'select') return value === filter.value;
      if (field.type === 'number' || field.type === 'unique_id') return Number(value) === Number(filter.value);
      return text === needle;
    case 'is_not':
      if (field.type === 'checkbox') return !!value !== !!filter.value;
      if (field.type === 'select') return value !== filter.value;
      return text !== needle;
    case 'gt':
      return field.type === 'date' ? text > needle : Number(value) > Number(filter.value);
    case 'lt':
      return field.type === 'date' ? (text !== '' && text < needle) : Number(value) < Number(filter.value);
  }
}

export function filterOpsFor(type: FieldType): { op: FilterOp; label: string; needsValue: boolean }[] {
  const empty = [
    { op: 'is_empty' as const, label: 'Is empty', needsValue: false },
    { op: 'is_not_empty' as const, label: 'Is not empty', needsValue: false },
  ];
  switch (type) {
    case 'checkbox':
      return [{ op: 'is', label: 'Is', needsValue: true }];
    case 'number':
      return [
        { op: 'is', label: '=', needsValue: true },
        { op: 'is_not', label: '≠', needsValue: true },
        { op: 'gt', label: '>', needsValue: true },
        { op: 'lt', label: '<', needsValue: true },
        ...empty,
      ];
    case 'date':
    case 'created_time':
    case 'last_edited':
      return [
        { op: 'is', label: 'Is', needsValue: true },
        { op: 'is_not', label: 'Is not', needsValue: true },
        { op: 'lt', label: 'Is before', needsValue: true },
        { op: 'gt', label: 'Is after', needsValue: true },
        ...empty,
      ];
    case 'select':
      return [{ op: 'is', label: 'Is', needsValue: true }, { op: 'is_not', label: 'Is not', needsValue: true }, ...empty];
    case 'multi_select':
      return [{ op: 'contains', label: 'Contains', needsValue: true }, { op: 'not_contains', label: 'Does not contain', needsValue: true }, ...empty];
    case 'relation':
      return [{ op: 'contains', label: 'Contains', needsValue: true }, { op: 'not_contains', label: 'Does not contain', needsValue: true }, ...empty];
    case 'person':
    case 'created_by':
    case 'edited_by':
      return [{ op: 'contains', label: 'Is', needsValue: true }, { op: 'not_contains', label: 'Is not', needsValue: true }, ...empty];
    case 'unique_id':
      return [
        { op: 'is', label: '=', needsValue: true },
        { op: 'gt', label: '>', needsValue: true },
        { op: 'lt', label: '<', needsValue: true },
      ];
    case 'button':
      return [];
    case 'rollup':
    case 'formula':
      return [
        { op: 'is', label: 'Is', needsValue: true },
        { op: 'is_not', label: 'Is not', needsValue: true },
        { op: 'contains', label: 'Contains', needsValue: true },
        { op: 'gt', label: '>', needsValue: true },
        { op: 'lt', label: '<', needsValue: true },
        ...empty,
      ];
    default:
      return [
        { op: 'contains', label: 'Contains', needsValue: true },
        { op: 'not_contains', label: 'Does not contain', needsValue: true },
        { op: 'is', label: 'Is', needsValue: true },
        { op: 'is_not', label: 'Is not', needsValue: true },
        ...empty,
      ];
  }
}

/** Rows as a view shows them: filtered, then sorted (stable, so manual order is kept for ties). */
export function viewRows(db: DatabaseState, view: View): Row[] {
  const byId = new Map(db.fields.map((f) => [f.id, f]));
  let rows = db.rows;
  // Filters that are filled in; "or" keeps a row matching any of them, "and" one matching all.
  const active = view.filters.flatMap((filter) => {
    const field = byId.get(filter.fieldId);
    if (!field) return [];
    const op = filterOpsFor(field.type).find((o) => o.op === filter.op);
    if (op?.needsValue && (filter.value === undefined || filter.value === '' || filter.value === null)) return [];
    return [{ field, filter }];
  });
  if (active.length) {
    const test = (r: Row) => (f: (typeof active)[number]) => matches(f.field, f.filter, cellValue(f.field, r));
    rows = rows.filter((r) => (view.filterMode === 'or' ? active.some(test(r)) : active.every(test(r))));
  }
  const sorts = view.sorts.filter((s) => byId.has(s.fieldId));
  if (sorts.length) {
    rows = rows
      .map((r, i) => ({ r, i }))
      .sort((x, y) => {
        for (const s of sorts) {
          const f = byId.get(s.fieldId)!;
          const c = compare(f, cellValue(f, x.r), cellValue(f, y.r));
          if (c !== 0) return s.dir === 'asc' ? c : -c;
        }
        return x.i - y.i;
      })
      .map((x) => x.r);
  }
  return rows;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
