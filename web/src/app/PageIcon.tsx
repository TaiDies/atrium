import { CalendarDays, ChartColumn, FileText, GanttChart, KanbanSquare, LayoutGrid, List, Newspaper, PenLine, Table2 } from 'lucide-react';
import type { PageSummary, PageType } from '../lib/api';

const ICONS = {
  document: FileText,
  grid: Table2,
  board: KanbanSquare,
  calendar: CalendarDays,
  timeline: GanttChart,
  chart: ChartColumn,
  form: PenLine,
  list: List,
  gallery: LayoutGrid,
  feed: Newspaper,
} satisfies Record<PageType, unknown>;

export function PageTypeIcon({ type, size = 16, className = 'shrink-0 text-muted' }: { type: PageType; size?: number; className?: string }) {
  const Icon = ICONS[type] ?? FileText;
  return <Icon size={size} strokeWidth={1.75} className={className} />;
}

export function PageIcon({ page, size = 16 }: { page: Pick<PageSummary, 'icon' | 'type'>; size?: number }) {
  if (page.icon) {
    return (
      <span className="inline-flex shrink-0 items-center justify-center leading-none" style={{ width: size + 2, fontSize: size - 1 }}>
        {page.icon}
      </span>
    );
  }
  return <PageTypeIcon type={page.type} size={size} />;
}
