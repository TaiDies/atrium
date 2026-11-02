import { useEffect, useRef, useState } from 'react';
import {
  centerOf,
  HIGHLIGHTER_OPACITY,
  hits,
  type InkItem,
  isText,
  recognizeShape,
  scaleAbout,
  shapeFromDrag,
  type ShapeKind,
  simplify,
  snapAngle,
  type Stroke,
  strokePath,
  TEXT_FONT,
  TEXT_LINE_HEIGHT,
  type TextItem,
  type Tool,
} from './ink';
import { InkItems } from './InkSvg';

export type InkMode = 'read' | Tool;

export interface InkSettings {
  mode: InkMode;
  color: string;
  width: number;
  finger: boolean;
  shape: ShapeKind;
  /** Hold still at the end of a stroke to turn it into a clean shape. */
  detectShapes: boolean;
  textColor: string;
  textSize: number;
}

export interface InkActions {
  add: (item: InkItem) => void;
  update: (id: string, item: InkItem) => void;
  remove: (id: string) => void;
  eraseAt: (page: number, x: number, y: number, radius: number) => void;
}

const ERASER_RADIUS = 0.012;
const HOLD_MS = 550;
const HOLD_SLOP = 0.004; // how far the pointer may drift and still count as holding still

type Point = [number, number];

type Gesture =
  | {
      kind: 'free';
      pointerId: number;
      points: number[];
      last: Point;
      shift: boolean;
      still: Point;
      timer?: ReturnType<typeof setTimeout>;
      snapped?: { shape: ShapeKind; base: number[]; center: Point; reach: number; points: number[] };
    }
  | { kind: 'shape'; pointerId: number; start: Point; last: Point; shift: boolean }
  | { kind: 'erase'; pointerId: number }
  | { kind: 'text'; pointerId: number; start: Point; item: TextItem | null; moved: boolean };

interface Editing {
  /** Identifies this typing session, so finishing it twice (tap elsewhere, then blur) saves once. */
  session: string;
  id: string | null;
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
}

/**
 * The handwriting on one page, and — while a tool is picked — drawing on it:
 * freehand strokes (Shift for a straight line; hold still to snap to a shape and then drag to resize),
 * shapes dragged out with the Shapes tool (Shift for squares, circles and 45° lines), typed text, and erasing.
 */
export function InkLayer({
  page,
  aspect,
  pxWidth,
  items,
  ink,
  actions,
  onPen,
}: {
  page: number;
  aspect: number;
  pxWidth: number;
  items: InkItem[];
  ink: InkSettings | null;
  actions: InkActions;
  onPen: () => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef<SVGPathElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const active = !!ink && ink.mode !== 'read';
  const settings = useRef(ink);
  settings.current = ink;

  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const r = svg.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width];
  };

  const showLive = (s: Pick<Stroke, 'points' | 'shape' | 'width'>, color: string, highlighter: boolean) => {
    const path = live.current!;
    path.setAttribute('d', strokePath(s));
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', String(s.width));
    path.setAttribute('stroke-opacity', highlighter ? String(HIGHLIGHTER_OPACITY) : '1');
    path.classList.toggle('ink-highlight', highlighter);
    path.style.display = '';
  };
  const hideLive = () => {
    if (live.current) live.current.style.display = 'none';
  };

  /** Redraws the stroke in progress (after a move, or when Shift is pressed or released). */
  const render = () => {
    const g = gesture.current;
    const s = settings.current;
    if (!g || !s) return;
    if (g.kind === 'free') {
      const highlighter = s.mode === 'highlighter';
      if (g.snapped) {
        let points: number[];
        if (g.snapped.shape === 'line') {
          const [x1, y1] = [g.snapped.base[0], g.snapped.base[1]];
          points = [x1, y1, ...(g.shift ? snapAngle(x1, y1, g.last[0], g.last[1]) : g.last)];
        } else {
          // Resize around the shape's centre as the pointer moves closer or further away.
          const reach = Math.hypot(g.last[0] - g.snapped.center[0], g.last[1] - g.snapped.center[1]);
          const k = g.snapped.reach > 0.005 ? Math.max(0.1, Math.min(10, reach / g.snapped.reach)) : 1;
          points = scaleAbout(g.snapped.base, g.snapped.center[0], g.snapped.center[1], k);
        }
        g.snapped.points = points;
        showLive({ points, shape: g.snapped.shape, width: s.width }, s.color, highlighter);
      } else if (g.shift) {
        showLive({ points: [g.points[0], g.points[1], ...g.last], shape: 'line', width: s.width }, s.color, highlighter);
      } else {
        showLive({ points: g.points, width: s.width }, s.color, highlighter);
      }
    } else if (g.kind === 'shape') {
      const points = shapeFromDrag(s.shape, g.start[0], g.start[1], g.last[0], g.last[1], g.shift);
      showLive({ points, shape: s.shape === 'polygon' ? 'polygon' : s.shape, width: s.width }, s.color, false);
    }
  };

  const armHold = (g: Extract<Gesture, { kind: 'free' }>) => {
    clearTimeout(g.timer);
    if (!settings.current?.detectShapes || g.snapped) return;
    g.timer = setTimeout(() => {
      if (gesture.current !== g || g.snapped || g.shift) return;
      const found = recognizeShape(g.points);
      if (!found) return;
      const center = found.shape === 'line' ? ([found.points[0], found.points[1]] as Point) : centerOf(found.points);
      g.snapped = {
        shape: found.shape,
        base: found.points,
        center,
        reach: Math.hypot(g.last[0] - center[0], g.last[1] - center[1]),
        points: found.points,
      };
      navigator.vibrate?.(12);
      render();
    }, HOLD_MS);
  };

  // Pressing or releasing Shift mid-stroke updates it straight away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const g = gesture.current;
      if (e.key !== 'Shift' || !g || (g.kind !== 'free' && g.kind !== 'shape')) return;
      g.shift = e.type === 'keydown';
      if (g.kind === 'free') armHold(g);
      render();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  });

  const textAt = (x: number, y: number) => [...items].reverse().find((i): i is TextItem => isText(i) && hits(i, x, y, 0.004)) ?? null;

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (editing) {
      // Tapping elsewhere finishes the text being typed.
      e.preventDefault();
      commit(editing.session, editing.text);
      return;
    }
    if (!ink || !active || e.button > 0) return;
    if (e.pointerType === 'pen') onPen();
    else if (e.pointerType === 'touch' && !ink.finger) return; // fingers scroll
    e.preventDefault();
    try {
      svg.current!.setPointerCapture(e.pointerId);
    } catch {
      // Not a capturable pointer; drawing still works while it stays over the page.
    }
    const p = toPage(e);
    switch (ink.mode) {
      case 'eraser':
        gesture.current = { kind: 'erase', pointerId: e.pointerId };
        actions.eraseAt(page, p[0], p[1], ERASER_RADIUS);
        break;
      case 'text':
        gesture.current = { kind: 'text', pointerId: e.pointerId, start: p, item: textAt(p[0], p[1]), moved: false };
        break;
      case 'shape':
        gesture.current = { kind: 'shape', pointerId: e.pointerId, start: p, last: p, shift: e.shiftKey };
        render();
        break;
      default: {
        const g: Gesture = { kind: 'free', pointerId: e.pointerId, points: [...p], last: p, shift: e.shiftKey, still: p };
        gesture.current = g;
        armHold(g);
        render();
      }
    }
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const native = e.nativeEvent;
    const events = typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length ? native.getCoalescedEvents() : [native];
    if (g.kind === 'erase') {
      for (const ev of events) {
        const [x, y] = toPage(ev);
        actions.eraseAt(page, x, y, ERASER_RADIUS);
      }
      return;
    }
    const p = toPage(e);
    if (g.kind === 'text') {
      if (Math.hypot(p[0] - g.start[0], p[1] - g.start[1]) > 0.006) g.moved = true;
      if (g.moved && g.item) {
        // Dragging a text box moves it (shown live, saved on release).
        const moved = { ...g.item, x: g.item.x + p[0] - g.start[0], y: g.item.y + p[1] - g.start[1] };
        actions.update(g.item.id, moved);
        g.item = moved;
        g.start = p;
      }
      return;
    }
    if (g.kind === 'shape') {
      g.last = p;
      g.shift = e.shiftKey;
      render();
      return;
    }
    if (!g.snapped) for (const ev of events) g.points.push(...toPage(ev));
    g.last = p;
    g.shift = e.shiftKey;
    // Moving more than a little restarts the "hold still" timer.
    if (Math.hypot(p[0] - g.still[0], p[1] - g.still[1]) > HOLD_SLOP) {
      g.still = p;
      armHold(g);
    }
    render();
  };

  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    const s = settings.current;
    if (!g || !s || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    hideLive();
    const id = crypto.randomUUID();
    if (g.kind === 'free') {
      clearTimeout(g.timer);
      const tool = s.mode === 'highlighter' ? 'highlighter' : 'pen';
      if (g.snapped) {
        actions.add({ id, page, tool, color: s.color, width: s.width, shape: g.snapped.shape, points: simplify(g.snapped.points, 0) });
      } else if (g.shift && g.points.length >= 2) {
        actions.add({ id, page, tool, color: s.color, width: s.width, shape: 'line', points: simplify([g.points[0], g.points[1], ...g.last], 0) });
      } else if (g.points.length >= 2) {
        actions.add({ id, page, tool, color: s.color, width: s.width, points: simplify(g.points) });
      }
    } else if (g.kind === 'shape') {
      if (Math.hypot(g.last[0] - g.start[0], g.last[1] - g.start[1]) < 0.004) return;
      const points = shapeFromDrag(s.shape, g.start[0], g.start[1], g.last[0], g.last[1], g.shift);
      actions.add({ id, page, tool: 'pen', color: s.color, width: s.width, shape: s.shape, points: simplify(points, 0) });
    } else if (g.kind === 'text' && !g.moved) {
      // A tap: edit the text that's there, or start a new one.
      const session = crypto.randomUUID();
      if (g.item) setEditing({ session, id: g.item.id, x: g.item.x, y: g.item.y, text: g.item.text, color: g.item.color, size: g.item.size });
      else setEditing({ session, id: null, x: g.start[0], y: g.start[1] - s.textSize * 0.6, text: '', color: s.textColor, size: s.textSize });
    }
  };

  const commit = (session: string, text: string) => {
    const editing = editingRef.current;
    if (!editing || editing.session !== session) return;
    editingRef.current = null;
    const value = text.replace(/\s+$/, '');
    if (editing.id) {
      if (!value) actions.remove(editing.id);
      else {
        const old = items.find((i) => i.id === editing.id);
        if (old && isText(old) && old.text !== value) actions.update(editing.id, { ...old, text: value });
      }
    } else if (value) {
      actions.add({ id: crypto.randomUUID(), page, tool: 'text', color: editing.color, size: editing.size, x: editing.x, y: editing.y, text: value });
    }
    setEditing(null);
  };

  // Leaving the text tool finishes whatever is being typed.
  useEffect(() => {
    if (ink?.mode !== 'text' && editing) (document.activeElement as HTMLElement | null)?.blur();
  }, [ink?.mode, editing]);

  return (
    <div className="absolute inset-0" style={{ pointerEvents: active ? 'auto' : 'none' }}>
      <svg
        ref={svg}
        viewBox={`0 0 1 ${aspect}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
        style={{
          touchAction: active ? (ink!.finger ? 'none' : 'pan-x pan-y pinch-zoom') : undefined,
          cursor: ink?.mode === 'eraser' ? 'cell' : ink?.mode === 'text' ? 'text' : active ? 'crosshair' : undefined,
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <InkItems items={items} hiddenId={editing?.id} />
        <path ref={live} fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'none' }} />
      </svg>
      {editing && (
        <TextEditor
          key={editing.session}
          editing={editing}
          pxWidth={pxWidth}
          onChange={(text) => setEditing((e) => (e && e.session === editing.session ? { ...e, text } : e))}
          onDone={(text) => commit(editing.session, text)}
        />
      )}
    </div>
  );
}

function TextEditor({ editing, pxWidth, onChange, onDone }: { editing: Editing; pxWidth: number; onChange: (text: string) => void; onDone: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = editing.text;
  const finish = () => onDone(ref.current?.value ?? text);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const lines = text.split('\n');
  const size = editing.size * pxWidth;
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation(); // typing here never triggers tool shortcuts
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          finish();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      placeholder="Type…"
      rows={lines.length}
      cols={Math.max(6, ...lines.map((l) => l.length + 1))}
      spellCheck
      className="absolute resize-none overflow-hidden rounded-sm border-0 bg-transparent p-0 outline-2 outline-offset-2 outline-accent/70 outline-dashed placeholder:text-black/30"
      style={{
        left: editing.x * pxWidth,
        top: editing.y * pxWidth,
        fontSize: size,
        lineHeight: TEXT_LINE_HEIGHT,
        fontFamily: TEXT_FONT,
        color: editing.color,
        minWidth: Math.max(80, size * 4),
        // Grows with the text where supported; rows/cols size it elsewhere.
        fieldSizing: 'content',
      }}
    />
  );
}
