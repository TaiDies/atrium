import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Maximize, Network, Palette, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApp } from '../app/context';
import { type Anchor, IconButton, Popover, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { SidebarIcon } from '../notifications/Notifications';
import { type GraphStyle, GroupsPanel, Legend, PageGroupMenu, pageGroups } from './GraphColors';

// The workspace as a graph, like Obsidian's: every page a dot (bigger the more it's linked), lines for
// links and mentions, pages inside pages, and database relations. Hover to see a page's neighbours,
// click to open it, drag dots around, scroll or pinch to zoom. "Local" shows one page and what's
// within a few links of it. It's animated: the graph blooms open from the middle, hovering fades
// everything else and sends sparks along the page's links, and zooming and fitting glide.

type EdgeKind = 'link' | 'child' | 'relation';
interface GraphData {
  nodes: { id: string; title: string; icon: string; type: string; parentId?: string | null; group?: string | null }[];
  edges: { source: string; target: string; kind: EdgeKind }[];
  style?: GraphStyle;
}
/** The colours to draw with: each grouped dot's colour (and group), each kind of line, and the group lit up from the legend. */
interface Paint {
  dots: Map<string, string>;
  groupOf: Map<string, string>;
  lines: Partial<Record<EdgeKind, string>>;
  spotlight: string | null;
}

interface Node {
  id: string;
  label: string;
  icon: string;
  degree: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
  /** Animated 0–1: how lit (vs faded behind a hover), how highlighted, the name's visibility; and size. */
  lit: number;
  hi: number;
  label01: number;
  grow: number;
  /** When it appears as the graph opens (0 = first), and where it's drawn meanwhile. */
  delay: number;
  sx: number;
  sy: number;
}

const KINDS: { kind: EdgeKind; label: string }[] = [
  { kind: 'link', label: 'Links' },
  { kind: 'child', label: 'Sub-pages' },
  { kind: 'relation', label: 'Relations' },
];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function GraphPage() {
  const { workspace, sidebarOpen, toggleSidebar } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus');
  const [depth, setDepth] = useState(2);
  const [kinds, setKinds] = useState<Record<EdgeKind, boolean>>({ link: true, child: true, relation: true });
  const [query, setQuery] = useState('');
  const data = useQuery({ queryKey: ['graph', workspace.id], queryFn: () => api<GraphData>(`/api/workspaces/${workspace.id}/graph`) });

  // What's shown: the chosen kinds of lines, and (local graph) only what's near the focused page.
  const shown = useMemo(() => {
    if (!data.data) return null;
    const edges = data.data.edges.filter((e) => kinds[e.kind]);
    let keep: Set<string> | null = null;
    if (focus) {
      keep = new Set([focus]);
      let frontier = [focus];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const e of edges) {
          for (const [a, b] of [
            [e.source, e.target],
            [e.target, e.source],
          ]) {
            if (frontier.includes(a) && !keep.has(b)) {
              keep.add(b);
              next.push(b);
            }
          }
        }
        frontier = next;
      }
    }
    const nodes = data.data.nodes.filter((n) => !keep || keep.has(n.id));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [data.data, kinds, focus, depth]);

  const style = data.data?.style ?? { links: {}, groups: [] };
  const groupOf = useMemo(() => pageGroups(data.data?.nodes ?? [], data.data?.style), [data.data]);
  // The legend: hovering a group lights its pages up; clicking keeps it lit.
  const [legendHover, setLegendHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const spotlight = legendHover ?? pinned;
  const paint = useMemo<Paint>(
    () => ({
      dots: new Map([...groupOf].map(([id, g]) => [id, g.color])),
      groupOf: new Map([...groupOf].map(([id, g]) => [id, g.id])),
      lines: data.data?.style?.links ?? {},
      spotlight,
    }),
    [groupOf, data.data, spotlight],
  );
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of shown?.nodes ?? []) {
      const g = groupOf.get(n.id);
      if (g) c.set(g.id, (c.get(g.id) ?? 0) + 1);
    }
    return c;
  }, [groupOf, shown]);
  const [groupsAt, setGroupsAt] = useState<Anchor | null>(null);
  const [pageMenu, setPageMenu] = useState<{ id: string; at: Anchor } | null>(null);
  const menuPage = pageMenu ? data.data?.nodes.find((n) => n.id === pageMenu.id) : null;

  const focusTitle = focus ? (data.data?.nodes.find((n) => n.id === focus)?.title || 'Untitled') : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        {!sidebarOpen && (
          <IconButton onClick={toggleSidebar} title="Open sidebar">
            <SidebarIcon />
          </IconButton>
        )}
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Network size={19} className="text-muted" /> Graph
        </h1>
        {focus && (
          <span className="flex items-center gap-1 rounded-full bg-accent/10 py-0.5 ps-2.5 pe-1 text-sm text-accent">
            <span className="max-w-[180px] truncate" data-no-translate>
              {focusTitle}
            </span>
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="rounded bg-transparent text-xs" title="How many links away">
              {[1, 2, 3].map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? 'link' : 'links'} away
                </option>
              ))}
            </select>
            <button onClick={() => setParams({})} title="Show the whole workspace" className="rounded-full p-1 hover:bg-accent/15">
              <X size={13} />
            </button>
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              onClick={() => setKinds((k) => ({ ...k, [kind]: !k[kind] }))}
              className={clsx('h-8 rounded-lg px-2.5 text-xs', kinds[kind] ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-hover')}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={(e) => setGroupsAt(e.currentTarget.getBoundingClientRect())}
          className={clsx('flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs', groupsAt ? 'bg-hover text-fg' : 'text-muted hover:bg-hover')}
          title="Groups: what each colour means"
        >
          <Palette size={14} /> Groups
        </button>
        <Popover anchor={groupsAt} onClose={() => setGroupsAt(null)} align="end">
          <GroupsPanel workspaceId={workspace.id} style={style} />
        </Popover>
        <Popover anchor={pageMenu?.at ?? null} onClose={() => setPageMenu(null)}>
          {menuPage && (
            <PageGroupMenu
              workspaceId={workspace.id}
              style={style}
              page={{ id: menuPage.id, title: menuPage.title, group: menuPage.group ?? null, shownIn: groupOf.get(menuPage.id)?.id ?? null }}
              onDone={() => setPageMenu(null)}
            />
          )}
        </Popover>
        <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2 focus-within:border-accent">
          <Search size={14} className="text-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a page" className="w-32 bg-transparent text-sm outline-none sm:w-44" />
        </label>
      </header>
      <div className="relative min-h-0 flex-1">
        {data.isPending || !shown ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : shown.nodes.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">No pages to show yet.</p>
        ) : (
          <>
            <GraphCanvas
              key={`${focus ?? 'all'}-${depth}-${Object.values(kinds).join()}`}
              data={shown}
              paint={paint}
              focus={focus}
              query={query}
              onOpen={(id) => navigate(`/w/${workspace.id}/p/${id}`)}
              onColor={(id, at) => setPageMenu({ id, at })}
            />
            <Legend style={style} counts={counts} pinned={pinned} onHover={setLegendHover} onPin={setPinned} />
          </>
        )}
      </div>
    </div>
  );
}

function GraphCanvas({
  data,
  paint,
  focus,
  query,
  onOpen,
  onColor,
}: {
  data: GraphData;
  paint: Paint;
  focus: string | null;
  query: string;
  onOpen: (id: string) => void;
  onColor: (id: string, at: Anchor) => void;
}) {
  // Colours change without restarting the layout (or replaying the opening bloom).
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const colorRef = useRef(onColor);
  colorRef.current = onColor;
  const dataRef = useRef(data);
  dataRef.current = data;
  const shape = useMemo(() => `${data.nodes.map((n) => n.id).join()}|${data.edges.map((e) => `${e.source}${e.target}${e.kind}`).join()}`, [data]);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  // The latest "open a page", without restarting the layout when it changes.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const [fitTick, setFitTick] = useState(0);

  useEffect(() => {
    const data = dataRef.current;
    const el = canvas.current!;
    const ctx = el.getContext('2d')!;
    const box = wrap.current!;

    // ----- the model -----
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const spread = Math.sqrt(data.nodes.length) * 40;
    const nodes: Node[] = data.nodes.map((n, i) => {
      const a = i * 2.39996;
      const d = spread * Math.sqrt((i + 0.5) / data.nodes.length);
      const deg = degree.get(n.id) ?? 0;
      return { id: n.id, label: n.title || 'Untitled', icon: n.icon, degree: deg, r: 4.5 + Math.sqrt(deg) * 2.4, x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0, fixed: false, lit: 1, hi: 0, label01: 0, grow: 1, delay: 0, sx: 0, sy: 0 };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = data.edges.map((e) => ({ a: byId.get(e.source)!, b: byId.get(e.target)!, kind: e.kind, on: 0 }));
    const neighbours = new Map<string, Set<string>>();
    for (const l of links) {
      if (!neighbours.has(l.a.id)) neighbours.set(l.a.id, new Set());
      if (!neighbours.has(l.b.id)) neighbours.set(l.b.id, new Set());
      neighbours.get(l.a.id)!.add(l.b.id);
      neighbours.get(l.b.id)!.add(l.a.id);
    }
    const focused = focus ? byId.get(focus) : null;
    if (focused) {
      focused.x = 0;
      focused.y = 0;
    }

    // ----- the view -----
    let width = 0;
    let height = 0;
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let alpha = 1;
    let hover: Node | null = null;
    let raf = 0;
    let fitted = false;
    // Animation state: the opening bloom, the fade behind a hover, a smooth zoom and the "fit" glide.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const INTRO = reduceMotion ? 0 : 1100;
    let born = 0;
    let lastFrame = 0;
    let dim = 0;
    let zoomTarget = 1;
    let zoomAt = { x: 0, y: 0 };
    let glide: { from: [number, number, number]; to: [number, number, number]; start: number } | null = null;
    let dragging: Node | null = null;
    const colors = { node: '', accent: '', line: '', text: '', faint: '', bg: '' };
    const readColors = () => {
      colors.accent = cssVar('--accent', '#7c5cff');
      colors.node = cssVar('--muted', '#888');
      colors.line = cssVar('--line', '#444');
      colors.text = cssVar('--fg', '#ddd');
      colors.faint = cssVar('--faint', '#666');
      colors.bg = cssVar('--bg', '#111');
    };
    readColors();

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = box.clientWidth;
      height = box.clientHeight;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!fitted) {
        panX = width / 2;
        panY = height / 2;
        fit(false);
      }
      draw();
    };

    const fit = (byHand = true) => {
      if (!nodes.length) return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
      }
      const w = Math.max(80, maxX - minX);
      const h = Math.max(80, maxY - minY);
      // Room around the edges for the names under the dots.
      const s = Math.max(0.15, Math.min(1.6, Math.min((width - 120) / w, (height - 90) / h)));
      const to: [number, number, number] = [s, width / 2 - ((minX + maxX) / 2) * s, height / 2 - ((minY + maxY) / 2) * s];
      if (byHand && !reduceMotion) {
        glide = { from: [scale, panX, panY], to, start: performance.now() };
        fitted = true;
        return;
      }
      [scale, panX, panY] = to;
      zoomTarget = scale;
      if (byHand) fitted = true;
    };

    // ----- the forces: dots push apart, lines pull together, everything drifts to the middle -----
    const step = () => {
      const n = nodes.length;
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.25;
          }
          if (d2 > 250000) continue;
          const f = (900 * alpha) / d2;
          const fx = dx * f;
          const fy = dy * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      for (const l of links) {
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = l.kind === 'child' ? 50 : 70;
        const f = ((d - rest) / d) * 0.06 * alpha;
        l.a.vx += dx * f;
        l.a.vy += dy * f;
        l.b.vx -= dx * f;
        l.b.vy -= dy * f;
      }
      for (const p of nodes) {
        // Pages with few links are pulled in more, so they don't drift off on their own.
        const pull = p.degree === 0 ? 0.03 : 0.008;
        p.vx -= p.x * pull * alpha;
        p.vy -= p.y * pull * alpha;
        if (p.fixed || p === focused) {
          p.vx = 0;
          p.vy = 0;
          continue;
        }
        p.vx *= 0.6;
        p.vy *= 0.6;
        p.x += Math.max(-20, Math.min(20, p.vx));
        p.y += Math.max(-20, Math.min(20, p.vy));
      }
      alpha = Math.max(0, alpha * 0.985);
    };

    const toWorld = (sx: number, sy: number) => ({ x: (sx - panX) / scale, y: (sy - panY) / scale });
    const hit = (sx: number, sy: number) => {
      const p = toWorld(sx, sy);
      let best: Node | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < Math.max(n.r + 4, 10 / scale) && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    function draw() {
      const now = performance.now();
      const dt = Math.min(100, lastFrame ? now - lastFrame : 16);
      lastFrame = now;
      // Animated values ease toward where they're going (about a tenth of a second).
      const k = reduceMotion ? 1 : 1 - Math.exp(-dt / 90);
      const intro = INTRO ? (now - born) / INTRO : 1;

      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(scale, scale);
      const q = queryRef.current.trim().toLowerCase();
      const active = dragging ?? hover;
      const near = active ? neighbours.get(active.id) : null;
      // A group lit up from the legend: its pages stay bright, the rest fade (a hovered dot wins).
      const spot = active ? null : paintRef.current.spotlight;
      const inSpot = (n: Node) => paintRef.current.groupOf.get(n.id) === spot;
      const lit = (n: Node) => (spot ? inSpot(n) : !active || n === active || !!near?.has(n.id));
      const matches = (n: Node) => !!q && n.label.toLowerCase().includes(q);
      dim += ((active || spot ? 1 : 0) - dim) * k;

      // Where each dot is drawn: while the graph opens, it travels out from the middle and pops in.
      const cx = focused ? focused.x : 0;
      const cy = focused ? focused.y : 0;
      for (const n of nodes) {
        const p = clamp01((intro - n.delay * 0.55) / 0.45);
        const e = easeOutCubic(p);
        n.sx = cx + (n.x - cx) * e;
        n.sy = cy + (n.y - cy) * e;
        n.lit += ((lit(n) ? 1 : 0) - n.lit) * k;
        n.hi += ((n === active || (active && near?.has(n.id)) || n === focused || matches(n) ? 1 : 0) - n.hi) * k;
        const size = n === active ? 1.45 : (active && near?.has(n.id)) || (spot && inSpot(n)) ? 1.2 : 1;
        n.grow = p < 1 ? size * Math.max(0, easeOutBack(p)) : n.grow + (size - n.grow) * k;
      }

      // Lines: faded behind a hover, the hovered page's lines lit and carrying sparks.
      for (const l of links) {
        const on = active && (l.a === active || l.b === active) ? 1 : 0;
        l.on += (on - l.on) * k;
        const appear = Math.min(clamp01((intro - l.a.delay * 0.55) / 0.45), clamp01((intro - l.b.delay * 0.55) / 0.45));
        if (appear <= 0) continue;
        const lineColor = paintRef.current.lines[l.kind];
        const base = lineColor ? 0.75 : l.kind === 'child' ? 0.35 : 0.55;
        const a0 = (base + (0.1 - base) * dim) * appear;
        if (l.kind === 'relation') ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.beginPath();
        ctx.moveTo(l.a.sx, l.a.sy);
        ctx.lineTo(l.b.sx, l.b.sy);
        if (l.on < 0.99) {
          ctx.lineWidth = 1 / scale;
          ctx.strokeStyle = lineColor ?? colors.faint;
          ctx.globalAlpha = a0 * (1 - l.on);
          ctx.stroke();
        }
        if (l.on > 0.01) {
          ctx.lineWidth = (1 + 0.8 * l.on) / scale;
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = 0.9 * l.on * appear;
          ctx.stroke();
        }
        ctx.setLineDash([]);
        if (l.on > 0.05 && active && !reduceMotion) {
          // Sparks running out from the hovered page along each of its lines.
          const [from, to] = l.a === active ? [l.a, l.b] : [l.b, l.a];
          ctx.fillStyle = colors.accent;
          for (let i = 0; i < 2; i++) {
            const t = (now / 1400 + i / 2 + (l.a.delay + l.b.delay) * 3) % 1;
            ctx.globalAlpha = l.on * Math.sin(t * Math.PI);
            ctx.beginPath();
            ctx.arc(from.sx + (to.sx - from.sx) * t, from.sy + (to.sy - from.sy) * t, 2.2 / scale, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Dots: grey, warming to the accent colour when highlighted; the hovered one grows and glows.
      for (const n of nodes) {
        const r = n.r * n.grow;
        if (r <= 0.05) continue;
        const alpha = 0.16 + 0.84 * n.lit;
        const own = paintRef.current.dots.get(n.id);
        if (n === active && !reduceMotion) {
          ctx.shadowColor = own ?? colors.accent;
          ctx.shadowBlur = 16;
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = own ?? colors.node;
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        // A coloured dot keeps its colour when highlighted (it grows and glows instead).
        if (n.hi > 0.01 && !own) {
          ctx.globalAlpha = alpha * n.hi;
          ctx.fillStyle = colors.accent;
          ctx.fill();
        }
        // Search matches, and the local graph's page, pulse with a ring.
        if (matches(n) || (n === focused && !active)) {
          const pulse = reduceMotion ? 0.5 : (Math.sin(now / 350) + 1) / 2;
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 1.6 / scale;
          ctx.globalAlpha = 0.35 + 0.5 * (1 - pulse);
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, r + (3 + 5 * pulse) / scale, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Names: when zoomed in, for well-linked pages, and around the one under the pointer. They fade
      // in and out, and keep a readable size on screen whatever the zoom.
      const fontSize = 10.5 / scale;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of nodes) {
        const important = n.degree >= 6 || n === focused;
        const show = n === active || near?.has(n.id) || matches(n) || (spot && inSpot(n)) || scale > 1.1 || (important && scale > 0.45) || nodes.length <= 40 || (nodes.length <= 120 && scale > 0.3);
        n.label01 += ((show ? 1 : 0) - n.label01) * k;
        if (n.label01 < 0.02 || n.grow < 0.3) continue;
        ctx.font = `${n === active ? 600 : 400} ${fontSize * (n === active ? 1.15 : 1)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.globalAlpha = n.label01 * (0.15 + (n === active ? 0.85 : 0.7) * n.lit);
        ctx.fillStyle = n === active ? colors.text : colors.faint;
        const text = `${n.icon ? `${n.icon} ` : ''}${n.label}`;
        ctx.fillText(text.length > 40 ? `${text.slice(0, 38)}…` : text, n.sx, n.sy + n.r * n.grow + (2 + 3 * (n.grow - 1)) / scale);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    const loop = () => {
      if (alpha > 0.005) {
        step();
        step();
      }
      // Until the view is moved by hand, keep everything in view (as it settles, and when resized).
      if (!fitted) fit(false);
      // "Fit" glides there; the wheel zooms smoothly around the pointer.
      if (glide) {
        const t = clamp01((performance.now() - glide.start) / 450);
        const e = easeInOut(t);
        scale = glide.from[0] + (glide.to[0] - glide.from[0]) * e;
        panX = glide.from[1] + (glide.to[1] - glide.from[1]) * e;
        panY = glide.from[2] + (glide.to[2] - glide.from[2]) * e;
        zoomTarget = scale;
        if (t >= 1) glide = null;
      } else if (Math.abs(zoomTarget - scale) > scale * 0.001) {
        const before = toWorld(zoomAt.x, zoomAt.y);
        scale += (zoomTarget - scale) * 0.22;
        panX = zoomAt.x - before.x * scale;
        panY = zoomAt.y - before.y * scale;
      }
      draw();
      raf = requestAnimationFrame(loop);
    };

    // ----- pointer: drag dots, pan, zoom (wheel and pinch), click to open -----
    const pointers = new Map<number, { x: number; y: number }>();
    let dragNode: Node | null = null;
    let moved = false;
    let pinch: { d: number; scale: number } | null = null;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      // Only the main button drags and opens (the right one is for the group menu).
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale };
        dragNode = dragging = null;
        glide = null;
        return;
      }
      dragNode = dragging = hit(p.x, p.y);
      glide = null;
      if (dragNode) {
        dragNode.fixed = true;
        alpha = Math.max(alpha, 0.3);
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        const h = hit(p.x, p.y);
        if (h !== hover) {
          hover = h;
          el.style.cursor = h ? 'pointer' : 'grab';
        }
        return;
      }
      pointers.set(e.pointerId, p);
      if (Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) moved = true;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const before = toWorld(mid.x, mid.y);
        scale = zoomTarget = Math.max(0.1, Math.min(6, pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)));
        panX = mid.x - before.x * scale;
        panY = mid.y - before.y * scale;
        return;
      }
      if (dragNode) {
        const w = toWorld(p.x, p.y);
        dragNode.x = w.x;
        dragNode.y = w.y;
        alpha = Math.max(alpha, 0.2);
      } else {
        panX += p.x - prev.x;
        panY += p.y - prev.y;
        fitted = true;
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (dragNode) {
        dragNode.fixed = false;
        if (!moved) openRef.current(dragNode.id);
      }
      dragNode = dragging = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt = local(e);
      glide = null;
      zoomTarget = Math.max(0.1, Math.min(6, zoomTarget * Math.exp(-e.deltaY * 0.0015)));
      if (reduceMotion) {
        const before = toWorld(zoomAt.x, zoomAt.y);
        scale = zoomTarget;
        panX = zoomAt.x - before.x * scale;
        panY = zoomAt.y - before.y * scale;
      }
      fitted = true;
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const n = hit(e.clientX - r.left, e.clientY - r.top);
      if (!n) return;
      // (On a phone this is a long press: lifting the finger afterwards mustn't open the page.)
      if (dragNode) dragNode.fixed = false;
      dragNode = dragging = null;
      colorRef.current(n.id, { x: e.clientX, y: e.clientY });
    };
    const onLeave = () => {
      if (!pointers.size) hover = null;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    const themeObserver = new MutationObserver(readColors);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-color'] });
    // Settle most of the layout before the first draw, so the graph opens already arranged.
    const started = performance.now();
    while (alpha > 0.05 && performance.now() - started < 200) step();
    // The bloom: dots near the middle (or the local graph's page) appear first, then ripple outward.
    const ox = focused ? focused.x : 0;
    const oy = focused ? focused.y : 0;
    const far = Math.max(1, ...nodes.map((n) => Math.hypot(n.x - ox, n.y - oy)));
    for (const n of nodes) n.delay = Math.hypot(n.x - ox, n.y - oy) / far;
    born = performance.now();
    resize();
    raf = requestAnimationFrame(loop);
    (el as HTMLCanvasElement & { __fit?: () => void }).__fit = () => fit();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
    };
  }, [shape, focus]);

  useEffect(() => {
    if (fitTick) (canvas.current as (HTMLCanvasElement & { __fit?: () => void }) | null)?.__fit?.();
  }, [fitTick]);

  return (
    <div ref={wrap} className="af-ltr absolute inset-0 touch-none overflow-hidden bg-bg">
      <canvas ref={canvas} className="block cursor-grab" aria-label="Graph of pages" />
      <button
        onClick={() => setFitTick((t) => t + 1)}
        title="Fit everything in view"
        className="absolute end-3 top-3 flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-muted shadow-sm hover:text-fg"
      >
        <Maximize size={16} />
      </button>
      <div className="pointer-events-none absolute start-3 bottom-3 rounded-lg bg-surface/80 px-2.5 py-1.5 text-[11px] text-muted backdrop-blur">
        {data.nodes.length} pages · {data.edges.length} connections
      </div>
    </div>
  );
}
