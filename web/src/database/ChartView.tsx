import clsx from 'clsx';
import { useDb } from './context';
import { type ChartKind, type ChartSettings, OPTION_COLORS, valueToText, type View, viewRows } from './model';

const PALETTE = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#84cc16', '#f97316'];
const SOLID: Record<string, string> = { purple: '#9c70ff', pink: '#ee69b4', lightpink: '#ffa2bd', orange: '#ff914d', yellow: '#f5c230', lime: '#a8de42', green: '#3dc378', aqua: '#40cdde', blue: '#4c89ff', gray: '#969696' };

export function ChartView({ view, embedded }: { view: View; embedded?: boolean }) {
  const { db, actions, readOnly } = useDb();
  const settings: ChartSettings = view.chart ?? { kind: 'bar', groupBy: null, metric: 'count', valueField: null };
  const set = (patch: Partial<ChartSettings>) => actions.updateView(view.id, { chart: { ...settings, ...patch } });
  const group = db.fields.find((f) => f.id === settings.groupBy);
  const value = db.fields.find((f) => f.id === settings.valueField && f.type === 'number');
  const rows = viewRows(db, view);

  // Bucket rows by the group property; options keep their order and colour.
  const buckets = new Map<string, { label: string; color: string; values: number[] }>();
  if (group?.options) group.options.forEach((o, i) => buckets.set(o.id, { label: o.name, color: SOLID[o.color] ?? PALETTE[i % PALETTE.length], values: [] }));
  for (const r of rows) {
    const raw = group ? r.cells[group.id] : null;
    const keys = Array.isArray(raw) ? raw.map(String) : [group?.type === 'checkbox' ? (raw ? 'Yes' : 'No') : raw ? String(raw) : ''];
    for (const key of keys.length ? keys : ['']) {
      if (!buckets.has(key)) {
        const label = key === '' ? `No ${group?.name ?? 'value'}` : group ? valueToText(group, group.type === 'date' ? key : raw) || key : key;
        buckets.set(key, { label, color: PALETTE[buckets.size % PALETTE.length], values: [] });
      }
      buckets.get(key)!.values.push(value ? Number(r.cells[value.id] ?? 0) || 0 : 1);
    }
  }
  const data = [...buckets.values()].map((b) => ({
    ...b,
    y: settings.metric === 'count' || !value ? b.values.length : settings.metric === 'sum' ? b.values.reduce((a, c) => a + c, 0) : b.values.length ? b.values.reduce((a, c) => a + c, 0) / b.values.length : 0,
  }));
  const max = Math.max(1, ...data.map((d) => d.y));
  const total = data.reduce((a, d) => a + d.y, 0) || 1;
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  const select = 'h-8 rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent';
  return (
    <div className={clsx('pt-3 pb-8', !embedded && 'px-6 sm:px-[54px]')}>
      {!readOnly && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
          <select value={settings.kind} onChange={(e) => set({ kind: e.target.value as ChartKind })} className={select}>
            <option value="bar">Bar</option>
            <option value="hbar">Horizontal bar</option>
            <option value="line">Line</option>
            <option value="pie">Pie</option>
            <option value="donut">Donut</option>
          </select>
          grouped by
          <select value={settings.groupBy ?? ''} onChange={(e) => set({ groupBy: e.target.value || null })} className={select}>
            <option value="">Choose…</option>
            {db.fields.filter((f) => !f.primary).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          showing
          <select value={settings.metric} onChange={(e) => set({ metric: e.target.value as ChartSettings['metric'] })} className={select}>
            <option value="count">Count</option>
            <option value="sum">Sum of</option>
            <option value="avg">Average of</option>
          </select>
          {settings.metric !== 'count' && (
            <select value={settings.valueField ?? ''} onChange={(e) => set({ valueField: e.target.value || null })} className={select}>
              <option value="">Number property…</option>
              {db.fields.filter((f) => f.type === 'number').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
        </div>
      )}
      {data.length === 0 ? (
        <div className="py-12 text-center text-sm text-faint">No data to chart.</div>
      ) : settings.kind === 'pie' || settings.kind === 'donut' ? (
        <div className="flex flex-wrap items-center gap-8">
          <svg viewBox="-110 -110 220 220" className="size-64">
            {(() => {
              let angle = -Math.PI / 2;
              return data.map((d) => {
                const a = (d.y / total) * Math.PI * 2;
                const x1 = Math.cos(angle) * 100, y1 = Math.sin(angle) * 100;
                angle += a;
                const x2 = Math.cos(angle) * 100, y2 = Math.sin(angle) * 100;
                const path = a >= Math.PI * 2 - 1e-6 ? 'M0,-100 A100,100 0 1 1 -0.01,-100 Z' : `M0,0 L${x1},${y1} A100,100 0 ${a > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`;
                return <path key={d.label} d={path} fill={d.color}><title>{`${d.label}: ${fmt(d.y)}`}</title></path>;
              });
            })()}
            {settings.kind === 'donut' && <circle r="58" fill="var(--bg)" />}
          </svg>
          <ul className="space-y-1.5 text-sm">
            {data.map((d) => (
              <li key={d.label} className="flex items-center gap-2">
                <span className="size-3 rounded-sm" style={{ background: d.color }} /> {d.label} <span className="text-faint">{fmt(d.y)} · {Math.round((d.y / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : settings.kind === 'hbar' ? (
        <div className="max-w-3xl space-y-2">
          {data.map((d) => (
            <div key={d.label} className="flex items-center gap-3 text-sm">
              <span className="w-32 shrink-0 truncate text-end text-muted">{d.label}</span>
              <div className="h-6 flex-1 rounded bg-hover"><div className="h-full rounded" style={{ width: `${(d.y / max) * 100}%`, background: d.color }} /></div>
              <span className="w-12 text-xs text-muted">{fmt(d.y)}</span>
            </div>
          ))}
        </div>
      ) : (
        <svg viewBox={`0 0 ${Math.max(400, data.length * 80)} 260`} className="h-72 w-full max-w-4xl">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => <line key={t} x1="0" x2="100%" y1={20 + 200 * (1 - t)} y2={20 + 200 * (1 - t)} stroke="var(--line)" />)}
          {settings.kind === 'line' && (
            <polyline fill="none" stroke="var(--accent)" strokeWidth="3" points={data.map((d, i) => `${i * 80 + 40},${20 + 200 * (1 - d.y / max)}`).join(' ')} />
          )}
          {data.map((d, i) => (
            <g key={d.label}>
              {settings.kind === 'bar' ? (
                <rect x={i * 80 + 16} y={20 + 200 * (1 - d.y / max)} width="48" height={200 * (d.y / max)} rx="4" fill={OPTION_COLORS[d.color] ? d.color : d.color}><title>{`${d.label}: ${fmt(d.y)}`}</title></rect>
              ) : (
                <circle cx={i * 80 + 40} cy={20 + 200 * (1 - d.y / max)} r="5" fill="var(--accent)"><title>{`${d.label}: ${fmt(d.y)}`}</title></circle>
              )}
              <text x={i * 80 + 40} y={14 + 200 * (1 - d.y / max)} textAnchor="middle" fontSize="11" fill="var(--muted)">{fmt(d.y)}</text>
              <text x={i * 80 + 40} y="242" textAnchor="middle" fontSize="11" fill="var(--muted)">{d.label.length > 12 ? `${d.label.slice(0, 11)}…` : d.label}</text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
