import * as Y from 'yjs';

// Presentations live in the file's Yjs document: "deck" (size and theme) and "slides", an array of
// slide maps whose "elements" arrays hold one map per text box, shape, picture, table or line. Each
// property is its own key, so two people moving different things never overwrite each other.

export type ShapeType =
  | 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'rtTriangle' | 'diamond' | 'pentagon' | 'hexagon' | 'octagon'
  | 'parallelogram' | 'trapezoid' | 'chevron' | 'star5' | 'heart' | 'rightArrow' | 'leftArrow' | 'upArrow' | 'downArrow'
  | 'cloud' | 'plus' | 'callout';

export type ElementType = 'text' | 'shape' | 'image' | 'table' | 'line';

export interface SlideElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  opacity: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  shape?: ShapeType;
  /** Rich text (text boxes, shapes and table cells use simple HTML). */
  html?: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  align: 'left' | 'center' | 'right' | 'justify';
  valign: 'top' | 'middle' | 'bottom';
  src?: string;
  /** Table cells as HTML, rows × columns. */
  rows?: string[][];
  headerRow?: boolean;
  /** Lines: an arrowhead at the end. */
  arrow?: boolean;
  flipH?: boolean;
  flipV?: boolean;
  link?: string;
}

export interface Slide {
  id: string;
  background: string | null;
  backgroundImage: string | null;
  notes: string;
  transition: 'none' | 'fade' | 'push' | 'zoom';
  hidden: boolean;
  elements: SlideElement[];
}

export interface Theme {
  id: string;
  label: string;
  background: string;
  title: string;
  text: string;
  accent: string;
  font: string;
  headingFont: string;
}

export const THEMES: Theme[] = [
  { id: 'simple', label: 'Simple', background: '#ffffff', title: '#1f1f1f', text: '#3c3c3c', accent: '#4472c4', font: 'Calibri', headingFont: 'Calibri' },
  { id: 'dark', label: 'Dark', background: '#1e1f24', title: '#ffffff', text: '#d9dbe1', accent: '#7c9cff', font: 'Segoe UI', headingFont: 'Segoe UI' },
  { id: 'ocean', label: 'Ocean', background: '#0f3b57', title: '#ffffff', text: '#d4ecf7', accent: '#40c4ff', font: 'Arial', headingFont: 'Georgia' },
  { id: 'sunset', label: 'Sunset', background: '#fff4ec', title: '#7a2e12', text: '#4b2b1f', accent: '#f0603a', font: 'Trebuchet MS', headingFont: 'Trebuchet MS' },
  { id: 'forest', label: 'Forest', background: '#f2f7f2', title: '#1d4d2f', text: '#2f3f33', accent: '#2e9a5b', font: 'Verdana', headingFont: 'Georgia' },
  { id: 'mono', label: 'Monochrome', background: '#f5f5f5', title: '#000000', text: '#333333', accent: '#000000', font: 'Helvetica', headingFont: 'Helvetica' },
  { id: 'plum', label: 'Plum', background: '#2b1638', title: '#f4e9ff', text: '#e1d1ee', accent: '#c084fc', font: 'Tahoma', headingFont: 'Garamond' },
];

export interface Deck {
  width: number;
  height: number;
  theme: string;
}

export const DEFAULT_DECK: Deck = { width: 1280, height: 720, theme: 'simple' };

export const LAYOUTS = [
  { id: 'title', label: 'Title slide' },
  { id: 'content', label: 'Title and content' },
  { id: 'two', label: 'Two contents' },
  { id: 'section', label: 'Section header' },
  { id: 'titleOnly', label: 'Title only' },
  { id: 'blank', label: 'Blank' },
] as const;

export type LayoutId = (typeof LAYOUTS)[number]['id'];

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export function baseElement(type: ElementType, patch: Partial<SlideElement> = {}): SlideElement {
  return {
    id: newId(),
    type,
    x: 100,
    y: 100,
    w: 300,
    h: 120,
    rot: 0,
    opacity: 1,
    fill: null,
    stroke: null,
    strokeWidth: 2,
    fontSize: 28,
    fontFamily: '',
    color: '',
    align: 'left',
    valign: 'top',
    ...patch,
  };
}

/** Placeholder text boxes for a new slide of the given layout. */
export function layoutElements(layout: LayoutId, deck: Deck): SlideElement[] {
  const W = deck.width;
  const H = deck.height;
  const title = (patch: Partial<SlideElement>) => baseElement('text', { html: '<p>Click to add a title</p>', fontSize: 48, align: 'left', valign: 'middle', ...patch });
  const body = (patch: Partial<SlideElement>) => baseElement('text', { html: '<ul><li>Click to add text</li></ul>', fontSize: 26, ...patch });
  switch (layout) {
    case 'title':
      return [
        title({ x: W * 0.1, y: H * 0.3, w: W * 0.8, h: H * 0.22, fontSize: 60, align: 'center', html: '<p>Click to add a title</p>' }),
        baseElement('text', { x: W * 0.15, y: H * 0.55, w: W * 0.7, h: H * 0.12, fontSize: 28, align: 'center', html: '<p>Click to add a subtitle</p>' }),
      ];
    case 'content':
      return [title({ x: W * 0.06, y: H * 0.05, w: W * 0.88, h: H * 0.16 }), body({ x: W * 0.06, y: H * 0.25, w: W * 0.88, h: H * 0.66 })];
    case 'two':
      return [
        title({ x: W * 0.06, y: H * 0.05, w: W * 0.88, h: H * 0.16 }),
        body({ x: W * 0.06, y: H * 0.25, w: W * 0.43, h: H * 0.66 }),
        body({ x: W * 0.51, y: H * 0.25, w: W * 0.43, h: H * 0.66 }),
      ];
    case 'section':
      return [
        title({ x: W * 0.08, y: H * 0.38, w: W * 0.84, h: H * 0.2, fontSize: 54 }),
        baseElement('text', { x: W * 0.08, y: H * 0.6, w: W * 0.84, h: H * 0.1, fontSize: 24, html: '<p>Section description</p>' }),
      ];
    case 'titleOnly':
      return [title({ x: W * 0.06, y: H * 0.05, w: W * 0.88, h: H * 0.16 })];
    default:
      return [];
  }
}

export function newSlide(layout: LayoutId, deck: Deck): Slide {
  return { id: newId(), background: null, backgroundImage: null, notes: '', transition: 'none', hidden: false, elements: layoutElements(layout, deck) };
}

// ---------- Yjs <-> plain objects ----------

export function elementMap(el: SlideElement): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(el)) if (v !== undefined) m.set(k, v);
  return m;
}

export function slideMap(slide: Slide): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(slide)) {
    if (k === 'elements') continue;
    m.set(k, v);
  }
  const els = new Y.Array<Y.Map<unknown>>();
  els.push(slide.elements.map(elementMap));
  m.set('elements', els);
  return m;
}

export function readSlides(arr: Y.Array<Y.Map<unknown>>): Slide[] {
  return arr.toArray().map((m) => {
    const els = m.get('elements');
    return {
      id: String(m.get('id')),
      background: (m.get('background') as string | null) ?? null,
      backgroundImage: (m.get('backgroundImage') as string | null) ?? null,
      notes: String(m.get('notes') ?? ''),
      transition: (m.get('transition') as Slide['transition']) ?? 'none',
      hidden: !!m.get('hidden'),
      elements: els instanceof Y.Array ? els.toArray().map((e) => (e as Y.Map<unknown>).toJSON() as SlideElement) : [],
    };
  });
}

export function readDeck(map: Y.Map<unknown>): Deck {
  return { width: Number(map.get('width') ?? DEFAULT_DECK.width), height: Number(map.get('height') ?? DEFAULT_DECK.height), theme: String(map.get('theme') ?? DEFAULT_DECK.theme) };
}

export const themeOf = (deck: Deck) => THEMES.find((t) => t.id === deck.theme) ?? THEMES[0];

/** SVG path for a shape filling a w × h box. */
export function shapePath(shape: ShapeType, w: number, h: number): string {
  const pts = (list: [number, number][]) => `M ${list.map(([x, y]) => `${x * w} ${y * h}`).join(' L ')} Z`;
  switch (shape) {
    case 'rect':
      return pts([[0, 0], [1, 0], [1, 1], [0, 1]]);
    case 'roundRect': {
      const r = Math.min(w, h) * 0.16;
      return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    }
    case 'ellipse':
      return `M 0 ${h / 2} A ${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2} A ${w / 2} ${h / 2} 0 1 0 0 ${h / 2} Z`;
    case 'triangle':
      return pts([[0.5, 0], [1, 1], [0, 1]]);
    case 'rtTriangle':
      return pts([[0, 0], [1, 1], [0, 1]]);
    case 'diamond':
      return pts([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case 'pentagon':
      return pts([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]);
    case 'hexagon':
      return pts([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    case 'octagon':
      return pts([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]);
    case 'parallelogram':
      return pts([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]);
    case 'trapezoid':
      return pts([[0.2, 0], [0.8, 0], [1, 1], [0, 1]]);
    case 'chevron':
      return pts([[0, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0, 1], [0.25, 0.5]]);
    case 'star5': {
      const out: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.2 : 0.5;
        out.push([0.5 + r * Math.cos(a), 0.52 + r * Math.sin(a)]);
      }
      return pts(out);
    }
    case 'heart':
      return `M ${w / 2} ${h * 0.3} C ${w / 2} ${h * 0.05}, 0 ${h * 0.05}, 0 ${h * 0.35} C 0 ${h * 0.65}, ${w / 2} ${h * 0.8}, ${w / 2} ${h} C ${w / 2} ${h * 0.8}, ${w} ${h * 0.65}, ${w} ${h * 0.35} C ${w} ${h * 0.05}, ${w / 2} ${h * 0.05}, ${w / 2} ${h * 0.3} Z`;
    case 'rightArrow':
      return pts([[0, 0.3], [0.65, 0.3], [0.65, 0], [1, 0.5], [0.65, 1], [0.65, 0.7], [0, 0.7]]);
    case 'leftArrow':
      return pts([[1, 0.3], [0.35, 0.3], [0.35, 0], [0, 0.5], [0.35, 1], [0.35, 0.7], [1, 0.7]]);
    case 'upArrow':
      return pts([[0.3, 1], [0.3, 0.35], [0, 0.35], [0.5, 0], [1, 0.35], [0.7, 0.35], [0.7, 1]]);
    case 'downArrow':
      return pts([[0.3, 0], [0.3, 0.65], [0, 0.65], [0.5, 1], [1, 0.65], [0.7, 0.65], [0.7, 0]]);
    case 'plus':
      return pts([[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]]);
    case 'callout':
      return pts([[0, 0], [1, 0], [1, 0.75], [0.4, 0.75], [0.2, 1], [0.25, 0.75], [0, 0.75]]);
    case 'cloud':
      return `M ${w * 0.25} ${h * 0.85} C ${w * 0.02} ${h * 0.85}, 0 ${h * 0.5}, ${w * 0.2} ${h * 0.45} C ${w * 0.15} ${h * 0.15}, ${w * 0.45} ${h * 0.05}, ${w * 0.55} ${h * 0.25} C ${w * 0.65} ${h * 0.05}, ${w * 0.95} ${h * 0.15}, ${w * 0.85} ${h * 0.45} C ${w} ${h * 0.5}, ${w} ${h * 0.85}, ${w * 0.75} ${h * 0.85} Z`;
    default:
      return pts([[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
}

export const SHAPES: { shape: ShapeType; label: string }[] = [
  { shape: 'rect', label: 'Rectangle' },
  { shape: 'roundRect', label: 'Rounded rectangle' },
  { shape: 'ellipse', label: 'Ellipse' },
  { shape: 'triangle', label: 'Triangle' },
  { shape: 'rtTriangle', label: 'Right triangle' },
  { shape: 'diamond', label: 'Diamond' },
  { shape: 'pentagon', label: 'Pentagon' },
  { shape: 'hexagon', label: 'Hexagon' },
  { shape: 'octagon', label: 'Octagon' },
  { shape: 'parallelogram', label: 'Parallelogram' },
  { shape: 'trapezoid', label: 'Trapezoid' },
  { shape: 'chevron', label: 'Chevron' },
  { shape: 'star5', label: 'Star' },
  { shape: 'heart', label: 'Heart' },
  { shape: 'plus', label: 'Plus' },
  { shape: 'cloud', label: 'Cloud' },
  { shape: 'callout', label: 'Speech bubble' },
  { shape: 'rightArrow', label: 'Right arrow' },
  { shape: 'leftArrow', label: 'Left arrow' },
  { shape: 'upArrow', label: 'Up arrow' },
  { shape: 'downArrow', label: 'Down arrow' },
];
