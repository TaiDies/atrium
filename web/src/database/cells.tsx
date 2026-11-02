import clsx from 'clsx';
import {
  AlignLeft,
  ArrowUpRight,
  Calendar,
  CheckSquare,
  CircleChevronDown,
  CircleDot,
  Fingerprint,
  Mail,
  MousePointerClick,
  Phone,
  UserRound,
  UserRoundPen,
  UserRoundPlus,
  Clock,
  Download,
  ExternalLink,
  FileIcon,
  FunctionSquare,
  Hash,
  History,
  Link2,
  ListChecks,
  ListTodo,
  MoreHorizontal,
  Paperclip,
  Plus,
  Sigma,
  Trash2,
  Upload,
  X,
  Sparkles,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Anchor, Popover, Spinner, toastError } from '../components/ui';
import { downloadUrl, uploadFile, viewerUrl } from '../lib/api';
import { useOpenFile } from '../lib/openFile';
import { useDb } from './context';
import { TasksBar, TasksList } from './TasksCell';
import { AiFillButton } from './AiFill';
import { ComputedValue, RelationPicker, RelationValue } from './computedCells';
import { ButtonCell, PeopleValue, PersonPicker } from './peopleCells';
import {
  type ChecklistItem,
  type TaskItem,
  cellValue,
  checklistProgress,
  formatUniqueId,
  STATUS_GROUPS,
  type Field,
  type FieldType,
  formatDate,
  type MediaItem,
  newId,
  OPTION_COLORS,
  type Row,
  type SelectOption,
} from './model';

export function FieldIcon({ type, size = 14, className }: { type: FieldType; size?: number; className?: string }) {
  const props = { size, className: clsx('shrink-0', className), strokeWidth: 1.8 };
  switch (type) {
    case 'number':
      return <Hash {...props} />;
    case 'select':
      return <CircleChevronDown {...props} />;
    case 'multi_select':
      return <ListTodo {...props} />;
    case 'date':
      return <Calendar {...props} />;
    case 'checkbox':
      return <CheckSquare {...props} />;
    case 'url':
      return <Link2 {...props} />;
    case 'checklist':
      return <ListChecks {...props} />;
    case 'media':
      return <Paperclip {...props} />;
    case 'tasks':
      return <ListTodo {...props} />;
    case 'ai':
      return <Sparkles {...props} />;
    case 'created_time':
      return <Clock {...props} />;
    case 'last_edited':
      return <History {...props} />;
    case 'relation':
      return <ArrowUpRight {...props} />;
    case 'rollup':
      return <Sigma {...props} />;
    case 'formula':
      return <FunctionSquare {...props} />;
    case 'status':
      return <CircleDot {...props} />;
    case 'person':
      return <UserRound {...props} />;
    case 'email':
      return <Mail {...props} />;
    case 'phone':
      return <Phone {...props} />;
    case 'unique_id':
      return <Fingerprint {...props} />;
    case 'created_by':
      return <UserRoundPlus {...props} />;
    case 'edited_by':
      return <UserRoundPen {...props} />;
    case 'button':
      return <MousePointerClick {...props} />;
    default:
      return <AlignLeft {...props} />;
  }
}

export function OptionTag({ option, onRemove, className }: { option: SelectOption; onRemove?: () => void; className?: string }) {
  return (
    <span
      className={clsx('inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-px text-[12.5px] leading-5 text-fg', className)}
      style={{ background: OPTION_COLORS[option.color] ?? OPTION_COLORS.gray }}
    >
      <span className="truncate">{option.name || 'Untitled'}</span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="opacity-60 hover:opacity-100"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function isImage(item: MediaItem) {
  return item.type.startsWith('image/');
}

/** Compact, read-only rendering of a cell (board cards, calendar). */
export function CellDisplay({ field, row }: { field: Field; row: Row }) {
  const value = cellValue(field, row);
  switch (field.type) {
    case 'person':
    case 'created_by':
    case 'edited_by':
      return <PeopleValue ids={value} compact />;
    case 'unique_id':
      return value !== undefined ? <span className="text-xs text-muted tabular-nums">{formatUniqueId(field, value)}</span> : null;
    case 'button':
      return <ButtonCell field={field} row={row} />;
    case 'email':
    case 'phone':
      return value ? <span className="truncate text-xs text-accent underline">{String(value)}</span> : null;
    case 'select': {
      const opt = field.options?.find((o) => o.id === value);
      return opt ? <OptionTag option={opt} /> : null;
    }
    case 'multi_select': {
      const opts = Array.isArray(value) ? field.options?.filter((o) => value.includes(o.id)) ?? [] : [];
      return opts.length ? (
        <span className="flex flex-wrap gap-1">
          {opts.map((o) => (
            <OptionTag key={o.id} option={o} />
          ))}
        </span>
      ) : null;
    }
    case 'checkbox':
      return value ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <CheckSquare size={13} className="text-accent" /> {field.name}
        </span>
      ) : null;
    case 'date':
    case 'created_time':
    case 'last_edited':
      return value ? <span className="text-xs text-muted">{formatDate(value, field.type !== 'date')}</span> : null;
    case 'checklist':
      return Array.isArray(value) && value.length ? <ChecklistBar items={value as ChecklistItem[]} /> : null;
    case 'media':
      return Array.isArray(value) && value.length ? <MediaStrip items={value as MediaItem[]} /> : null;
    case 'tasks':
      return Array.isArray(value) && value.length ? <TasksBar items={value as TaskItem[]} /> : null;
    case 'url':
      return value ? <span className="truncate text-xs text-accent underline">{String(value)}</span> : null;
    case 'relation':
      return <RelationValue field={field} value={value} />;
    case 'rollup':
    case 'formula':
      return <ComputedValue value={value} />;
    default:
      return value !== undefined && value !== null && value !== '' ? <span className="text-xs break-words text-muted">{String(value)}</span> : null;
  }
}

function ChecklistBar({ items }: { items: ChecklistItem[] }) {
  const pct = Math.round(checklistProgress(items) * 100);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-active">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="shrink-0 text-xs text-muted">{pct}%</span>
    </span>
  );
}

function MediaStrip({ items }: { items: MediaItem[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {items.slice(0, 4).map((m) =>
        isImage(m) ? (
          <img key={m.url} src={m.url} alt={m.name} className="size-6 rounded object-cover" />
        ) : (
          <span key={m.url} className="inline-flex max-w-[120px] items-center gap-1 truncate rounded bg-active px-1.5 text-xs">
            <FileIcon size={11} /> <span className="truncate">{m.name}</span>
          </span>
        ),
      )}
      {items.length > 4 && <span className="text-xs text-muted">+{items.length - 4}</span>}
    </span>
  );
}

/**
 * Editable cell. `variant="grid"` fits a table cell; `variant="detail"` is the
 * roomier layout used on a row's page.
 */
export function CellEditor({ field, row, variant }: { field: Field; row: Row; variant: 'grid' | 'detail' }) {
  const { actions, readOnly, pageId } = useDb();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [editing, setEditing] = useState(false);

  // Viewers see values only; file cells still open so attachments can be viewed and downloaded.
  if (readOnly && field.type !== 'media') {
    return (
      <div className={clsx('flex min-h-[32px] w-full min-w-0 items-center', variant === 'grid' ? 'px-2 py-1' : 'px-2 py-1')}>
        <CellDisplay field={field} row={row} />
      </div>
    );
  }
  const ref = useRef<HTMLDivElement>(null);
  const value = row.cells[field.id];
  const set = (v: unknown) => actions.updateCell(row.id, field.id, v);
  const open = () => setAnchor(ref.current!.getBoundingClientRect());

  const shell = (children: ReactNode, onClick?: () => void, placeholder = variant === 'detail' ? 'Empty' : '') => (
    <div
      ref={ref}
      onClick={onClick}
      className={clsx(
        'flex min-h-[32px] w-full min-w-0 items-center',
        variant === 'grid' ? 'px-2 py-1' : 'rounded-md px-2 py-1 hover:bg-hover',
        onClick && 'cursor-pointer',
      )}
    >
      {children ?? (placeholder ? <span className="text-sm text-faint">{placeholder}</span> : null)}
    </div>
  );

  switch (field.type) {
    case 'ai': {
      if (editing) {
        return (
          <TextInput
            initial={value === undefined || value === null ? '' : String(value)}
            type="text"
            multiline={variant === 'detail'}
            onDone={(text) => {
              setEditing(false);
              if (text !== null) set(text);
            }}
          />
        );
      }
      const empty = value === undefined || value === null || value === '';
      return shell(
        empty ? (
          <AiFillButton pageId={pageId} fieldId={field.id} rowId={row.id} />
        ) : (
          <span className={clsx('text-sm', variant === 'grid' ? 'truncate' : 'break-words whitespace-pre-wrap')}>{String(value)}</span>
        ),
        () => setEditing(true),
      );
    }
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case 'number': {
      if (editing) {
        return (
          <TextInput
            initial={value === undefined || value === null ? '' : String(value)}
            type={field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
            multiline={field.type === 'text' && variant === 'detail'}
            onDone={(text) => {
              setEditing(false);
              if (text === null) return;
              if (field.type === 'number') set(text.trim() === '' ? null : Number(text));
              else set(text);
            }}
          />
        );
      }
      const empty = value === undefined || value === null || value === '';
      const link =
        field.type === 'email' ? `mailto:${value}` : field.type === 'phone' ? `tel:${String(value).replace(/[^\d+]/g, '')}` : /^https?:\/\//i.test(String(value)) ? String(value) : `https://${value}`;
      return shell(
        empty ? null : field.type === 'url' || field.type === 'email' || field.type === 'phone' ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="truncate text-sm text-accent underline"
          >
            {String(value)}
          </a>
        ) : (
          <span className={clsx('text-sm', variant === 'grid' ? 'truncate' : 'break-words whitespace-pre-wrap', field.type === 'number' && 'tabular-nums')}>
            {String(value)}
          </span>
        ),
        () => setEditing(true),
      );
    }

    case 'checkbox':
      return shell(
        <button
          onClick={(e) => {
            e.stopPropagation();
            set(!value);
          }}
          className={clsx(
            'flex size-4 items-center justify-center rounded border transition-colors',
            value ? 'border-accent bg-accent text-white' : 'border-faint hover:border-muted',
          )}
          aria-label={field.name}
        >
          {!!value && (
            <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2.5 6.5l2.5 2.5 4.5-5" />
            </svg>
          )}
        </button>,
      );

    case 'select':
    case 'multi_select': {
      const ids = field.type === 'select' ? (value ? [value as string] : []) : Array.isArray(value) ? (value as string[]) : [];
      const opts = ids.map((id) => field.options?.find((o) => o.id === id)).filter((o): o is SelectOption => !!o);
      return (
        <>
          {shell(
            opts.length ? (
              <span className={clsx('flex min-w-0 gap-1', variant === 'grid' ? 'overflow-hidden' : 'flex-wrap')}>
                {opts.map((o) => (
                  <OptionTag key={o.id} option={o} />
                ))}
              </span>
            ) : null,
            open,
          )}
          <OptionPicker anchor={anchor} onClose={() => setAnchor(null)} field={field} selected={ids} onChange={(next) => set(field.type === 'select' ? next[0] ?? null : next)} />
        </>
      );
    }

    case 'date':
      return (
        <>
          {shell(value ? <span className="text-sm">{formatDate(value)}</span> : null, open)}
          <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-60 p-3">
            <input
              type="date"
              autoFocus
              value={typeof value === 'string' ? value.slice(0, 10) : ''}
              onChange={(e) => set(e.target.value || null)}
              className="h-9 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
            />
            <div className="mt-2 flex justify-between">
              <button
                onClick={() => {
                  const d = new Date();
                  set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
                }}
                className="rounded px-2 py-1 text-xs text-accent hover:bg-hover"
              >
                Today
              </button>
              <button
                onClick={() => {
                  set(null);
                  setAnchor(null);
                }}
                className="rounded px-2 py-1 text-xs text-muted hover:bg-hover"
              >
                Clear
              </button>
            </div>
          </Popover>
        </>
      );

    case 'checklist':
      return (
        <>
          {shell(Array.isArray(value) && value.length ? <ChecklistBar items={value as ChecklistItem[]} /> : null, open)}
          <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-72 p-2">
            <ChecklistEditor items={(value as ChecklistItem[] | undefined) ?? []} onChange={set} />
          </Popover>
        </>
      );

    case 'media':
      return (
        <>
          {shell(Array.isArray(value) && value.length ? <MediaStrip items={value as MediaItem[]} /> : null, open)}
          <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-80 p-2">
            <MediaEditor items={(value as MediaItem[] | undefined) ?? []} onChange={set} readOnly={readOnly} />
          </Popover>
        </>
      );

    case 'tasks':
      return (
        <>
          {shell(Array.isArray(value) && value.length ? <TasksBar items={value as TaskItem[]} /> : null, open)}
          <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-80 p-1.5">
            <TasksList items={(value as TaskItem[] | undefined) ?? []} pageId={pageId} readOnly={readOnly} />
          </Popover>
        </>
      );

    case 'created_time':
      return shell(<span className="text-sm text-muted">{formatDate(row.createdAt, true)}</span>);
    case 'last_edited':
      return shell(<span className="text-sm text-muted">{formatDate(row.updatedAt, true)}</span>);
    case 'relation':
      return (
        <>
          {shell(Array.isArray(value) && value.length ? <RelationValue field={field} value={value} compact={variant === 'grid'} /> : null, open)}
          {anchor && <RelationPicker field={field} row={row} anchor={anchor} onClose={() => setAnchor(null)} />}
        </>
      );
    case 'rollup':
    case 'formula':
      return shell(value === undefined || value === null || value === '' ? null : <ComputedValue value={value} compact={variant === 'grid'} />);
    case 'person': {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      return (
        <>
          {shell(ids.length ? <PeopleValue ids={ids} compact={variant === 'grid'} /> : null, open)}
          <PersonPicker anchor={anchor} onClose={() => setAnchor(null)} selected={ids} onChange={set} />
        </>
      );
    }
    case 'created_by':
      return shell(row.createdBy ? <PeopleValue ids={row.createdBy} compact={variant === 'grid'} /> : null);
    case 'edited_by':
      return shell(row.updatedBy ? <PeopleValue ids={row.updatedBy} compact={variant === 'grid'} /> : null);
    case 'unique_id':
      return shell(value !== undefined ? <span className="text-sm text-muted tabular-nums">{formatUniqueId(field, value)}</span> : null);
    case 'button':
      return shell(<ButtonCell field={field} row={row} />);
  }
}

function TextInput({ initial, type, multiline, onDone }: { initial: string; type: 'text' | 'number' | 'email' | 'tel'; multiline?: boolean; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  const common = {
    autoFocus: true,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    onBlur: () => finish(value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
        e.preventDefault();
        finish(value);
      }
      if (e.key === 'Escape') finish(null);
    },
    className: 'w-full rounded-md border border-accent bg-bg px-2 py-1 text-sm outline-none',
  };
  return multiline ? <textarea rows={3} {...common} /> : <input type={type} {...common} />;
}

export function OptionPicker({
  anchor,
  onClose,
  field,
  selected,
  onChange,
}: {
  anchor: Anchor | null;
  onClose: () => void;
  field: Field;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { actions } = useDb();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const multi = field.type === 'multi_select';
  const options = field.options ?? [];
  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  const exact = options.some((o) => o.name.toLowerCase() === q);

  useEffect(() => {
    if (!anchor) {
      setQuery('');
      setEditing(null);
    }
  }, [anchor]);

  const toggle = (id: string) => {
    if (multi) onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else {
      onChange(selected[0] === id ? [] : [id]);
      onClose();
    }
  };
  const create = () => {
    if (!q) return;
    const id = actions.addOption(field.id, query.trim());
    onChange(multi ? [...selected, id] : [id]);
    setQuery('');
    if (!multi) onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} className="w-64 p-1.5">
      <div className="flex flex-wrap gap-1 px-1 pt-1 pb-1.5">
        {selected.map((id) => {
          const o = options.find((x) => x.id === id);
          return o ? <OptionTag key={id} option={o} onRemove={() => onChange(selected.filter((x) => x !== id))} /> : null;
        })}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (visible.length === 1 && q) toggle(visible[0].id);
              else if (!exact) create();
            }
          }}
          placeholder={options.length ? 'Search or create an option' : 'Type to create an option'}
          className="h-7 min-w-[100px] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-faint"
        />
      </div>
      <div className="mb-1 h-px bg-line" />
      <div className="max-h-64 overflow-y-auto">
        {(field.status ? STATUS_GROUPS.map((g) => ({ ...g, options: visible.filter((o) => (o.group ?? 'todo') === g.group) })) : [{ group: null, label: '', options: visible }]).map((g) => (
          <div key={g.group ?? 'all'}>
            {g.group && <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-faint">{g.label}</div>}
        {g.options.map((o) =>
          editing === o.id ? (
            <OptionEditor key={o.id} field={field} option={o} onDone={() => setEditing(null)} />
          ) : (
            <div key={o.id} data-menu-scope className="group flex items-center gap-1 rounded-md pe-1 hover:bg-hover">
              <button onClick={() => toggle(o.id)} className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-start">
                <OptionTag option={o} />
                {selected.includes(o.id) && <span className="ms-auto text-xs text-accent">✓</span>}
              </button>
              <button data-menu-button onClick={() => setEditing(o.id)} className="rounded p-1 text-muted hover-reveal opacity-0 group-hover:opacity-100 hover:bg-active" aria-label="Edit option">
                <MoreHorizontal size={14} />
              </button>
            </div>
          ),
        )}
          </div>
        ))}
        {q && !exact && (
          <button onClick={create} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-hover">
            <Plus size={14} className="text-muted" /> Create <OptionTag option={{ id: '', name: query.trim(), color: 'gray' }} />
          </button>
        )}
        {!q && options.length === 0 && <div className="px-2 py-2 text-xs text-faint">No options yet</div>}
      </div>
    </Popover>
  );
}

function OptionEditor({ field, option, onDone }: { field: Field; option: SelectOption; onDone: () => void }) {
  const { actions } = useDb();
  const [name, setName] = useState(option.name);
  return (
    <div className="m-1 rounded-md border border-line p-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== option.name && actions.updateOption(field.id, option.id, { name: name.trim() })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (name.trim()) actions.updateOption(field.id, option.id, { name: name.trim() });
            onDone();
          }
        }}
        className="h-7 w-full rounded border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
      />
      {field.status && (
        <select
          value={option.group ?? 'todo'}
          onChange={(e) => actions.updateOption(field.id, option.id, { group: e.target.value as SelectOption['group'] })}
          className="mt-2 h-7 w-full rounded border border-line bg-bg px-1.5 text-xs"
          aria-label="Group"
        >
          {STATUS_GROUPS.map((g) => (
            <option key={g.group} value={g.group}>
              {g.label}
            </option>
          ))}
        </select>
      )}
      <div className="mt-2 grid grid-cols-5 gap-1.5">
        {Object.entries(OPTION_COLORS).map(([key, bg]) => (
          <button
            key={key}
            title={key}
            onClick={() => actions.updateOption(field.id, option.id, { color: key })}
            className={clsx('h-5 rounded', option.color === key && 'ring-2 ring-accent')}
            style={{ background: bg }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between">
        <button onClick={() => actions.deleteOption(field.id, option.id)} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-danger hover:bg-danger/10">
          <Trash2 size={12} /> Delete
        </button>
        <button onClick={onDone} className="rounded px-2 py-1 text-xs text-muted hover:bg-hover">
          Done
        </button>
      </div>
    </div>
  );
}

function ChecklistEditor({ items, onChange }: { items: ChecklistItem[]; onChange: (items: ChecklistItem[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    if (!text.trim()) return;
    onChange([...items, { id: newId(), text: text.trim(), done: false }]);
    setText('');
  };
  return (
    <div>
      {items.length > 0 && (
        <div className="px-1 pb-2">
          <ChecklistBar items={items} />
        </div>
      )}
      {items.map((item) => (
        <div key={item.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
          <input type="checkbox" checked={item.done} onChange={() => onChange(items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))} className="accent-[var(--accent)]" />
          <input
            value={item.text}
            onChange={(e) => onChange(items.map((i) => (i.id === item.id ? { ...i, text: e.target.value } : i)))}
            className={clsx('min-w-0 flex-1 bg-transparent text-sm outline-none', item.done && 'text-muted line-through')}
          />
          <button onClick={() => onChange(items.filter((i) => i.id !== item.id))} className="text-muted hover-reveal opacity-0 group-hover:opacity-100 hover:text-danger">
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-2 px-1.5">
        <Plus size={14} className="text-muted" />
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add an item"
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </div>
    </div>
  );
}

function MediaEditor({ items, onChange, readOnly }: { items: MediaItem[]; onChange: (items: MediaItem[]) => void; readOnly?: boolean }) {
  const { workspaceId } = useDb();
  const openFile = useOpenFile();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const added: MediaItem[] = [];
      for (const file of Array.from(files)) {
        added.push({ url: await uploadFile(workspaceId, file), name: file.name, type: file.type || 'application/octet-stream' });
      }
      onChange([...items, ...added]);
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
    }
  };
  return (
    <div>
      {items.map((m) => (
        <div key={m.url} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
          {isImage(m) ? <img src={m.url} alt="" className="size-8 rounded object-cover" /> : <FileIcon size={16} className="text-muted" />}
          <a
            href={viewerUrl(m.url, m.name)}
            onClick={(e) => {
              if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
              e.preventDefault();
              openFile(m.url, m.name);
            }}
            className="min-w-0 flex-1 truncate text-sm hover:underline"
          >
            {m.name}
          </a>
          <a href={viewerUrl(m.url, m.name)} target="_blank" rel="noreferrer" className="rounded p-1 text-muted hover:bg-active hover:text-fg" title="Open in a new tab">
            <ExternalLink size={14} />
          </a>
          <a href={downloadUrl(m.url)} download={m.name} className="rounded p-1 text-muted hover:bg-active hover:text-fg" title="Download">
            <Download size={14} />
          </a>
          {!readOnly && (
            <button onClick={() => onChange(items.filter((i) => i.url !== m.url))} className="rounded p-1 text-muted hover:bg-active hover:text-danger" title="Remove">
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      {items.length === 0 && readOnly && <div className="px-2 py-2 text-xs text-faint">No files</div>}
      {!readOnly && (
        <>
          <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <button
            onClick={() => input.current?.click()}
            disabled={uploading}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-line py-2 text-sm text-muted hover:bg-hover"
          >
            {uploading ? <Spinner /> : <Upload size={14} />} Upload files
          </button>
        </>
      )}
    </div>
  );
}
