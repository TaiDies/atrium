import clsx from 'clsx';
import {
  AlignCenter,
  AlignEndVertical,
  AlignHorizontalJustifyCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignStartVertical,
  AlignVerticalJustifyCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  BringToFront,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  ImagePlus,
  Italic,
  Layers,
  List,
  ListOrdered,
  Minus,
  MoveRight,
  Play,
  Plus,
  Redo2,
  SendToBack,
  Shapes as ShapesIcon,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import { forwardRef, type PointerEvent as RPointerEvent, type ReactNode, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { type Anchor, Avatar, Popover, toastError } from '../../components/ui';
import { uploadFile, type User } from '../../lib/api';
import type { CollabSession } from '../../lib/collab';
import { convertBytes, convertStored, type EditorHandle, extOf, fileBytes, type OfficeFile } from '../shared';
import {
  baseElement,
  type Deck,
  DEFAULT_DECK,
  elementMap,
  LAYOUTS,
  type LayoutId,
  newId,
  newSlide,
  readDeck,
  readSlides,
  shapePath,
  SHAPES,
  type ShapeType,
  type Slide,
  type SlideElement,
  slideMap,
  type Theme,
  themeOf,
  THEMES,
} from './model';
import { pptxToSlides, slidesToPptx } from './pptx';

const LOCAL = 'slides-local';
const FONTS = ['Calibri', 'Arial', 'Helvetica', 'Segoe UI', 'Georgia', 'Garamond', 'Times New Roman', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Comic Sans MS'];
const SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 54, 60, 72, 88, 96];
const SWATCHES = ['#000000', '#404040', '#7f7f7f', '#bfbfbf', '#ffffff', '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0', '#e5487a', '#f0603a', '#14b8a6', '#4472c4', '#ed7d31'];

/** Fills a new live presentation from the stored file (.pptx read here; .ppt, .odp, .key via the server). */
export async function loadPresentation(doc: Y.Doc, file: OfficeFile) {
  const upload = (blob: Blob, ext: string) => uploadFile(file.workspaceId, new File([blob], `slide-image.${ext}`, { type: blob.type }));
  let deck: Deck = DEFAULT_DECK;
  let slides: Slide[];
  if (file.size === 0) slides = [newSlide('title', deck)];
  else {
    const ext = extOf(file.name);
    const data = ['pptx', 'ppsx', 'potx', 'pptm'].includes(ext) ? await fileBytes(file) : await convertStored(file, 'pptx');
    ({ deck, slides } = await pptxToSlides(data, upload));
    if (!slides.length) slides = [newSlide('title', deck)];
  }
  doc.transact(() => {
    const d = doc.getMap('deck');
    d.set('width', deck.width);
    d.set('height', deck.height);
    d.set('theme', deck.theme);
    doc.getArray('slides').push(slides.map(slideMap));
  });
}

export const PRESENTATION_FORMATS = [
  { ext: 'pptx', label: 'PowerPoint (.pptx)' },
  { ext: 'odp', label: 'OpenDocument presentation (.odp)' },
  { ext: 'pdf', label: 'PDF (.pdf)' },
  { ext: 'ppt', label: 'PowerPoint 97–2003 (.ppt)' },
];

interface Props {
  file: OfficeFile;
  session: CollabSession;
  user: User;
  readOnly: boolean;
}

// Copied elements, shared across slides (and presentations open in this tab).
let clipboard: SlideElement[] = [];

export const SlidesEditor = forwardRef<EditorHandle, Props>(function SlidesEditor({ file, session, user, readOnly }, ref) {
  const slidesArr = useMemo(() => session.doc.getArray<Y.Map<unknown>>('slides'), [session]);
  const deckMap = useMemo(() => session.doc.getMap<unknown>('deck'), [session]);
  const undo = useMemo(() => new Y.UndoManager([slidesArr, deckMap], { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 }), [slidesArr, deckMap]);
  const [slides, setSlides] = useState<Slide[]>(() => readSlides(slidesArr));
  const [deck, setDeck] = useState<Deck>(() => readDeck(deckMap));
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [peers, setPeers] = useState<{ id: number; name: string; color: string; slideId?: string; ids: string[] }[]>([]);

  useEffect(() => {
    const read = () => setSlides(readSlides(slidesArr));
    slidesArr.observeDeep(read);
    const readD = () => setDeck(readDeck(deckMap));
    deckMap.observe(readD);
    return () => {
      slidesArr.unobserveDeep(read);
      deckMap.unobserve(readD);
      undo.destroy();
    };
  }, [slidesArr, deckMap, undo]);

  const slide = slides[Math.min(current, slides.length - 1)];
  const theme = themeOf(deck);
  useEffect(() => {
    if (current > slides.length - 1) setCurrent(Math.max(0, slides.length - 1));
  }, [slides.length, current]);

  // Presence: which slide each person is on and what they have selected.
  useEffect(() => {
    const aw = session.provider.awareness;
    if (!aw) return;
    aw.setLocalStateField('user', { name: user.name, color: user.color, id: user.id });
    const update = () => {
      const list: typeof peers = [];
      aw.getStates().forEach((s, id) => {
        const st = s as { user?: { name: string; color: string }; slides?: { slideId?: string; ids: string[] } };
        if (id === aw.clientID || !st.user) return;
        list.push({ id, name: st.user.name, color: st.user.color, slideId: st.slides?.slideId, ids: st.slides?.ids ?? [] });
      });
      setPeers(list);
    };
    aw.on('change', update);
    update();
    return () => aw.off('change', update);
  }, [session, user]);
  useEffect(() => {
    session.provider.awareness?.setLocalStateField('slides', { slideId: slide?.id, ids: selected });
  }, [session, slide?.id, selected]);

  // ---------- editing the shared document ----------
  const tx = (fn: () => void) => session.doc.transact(fn, LOCAL);
  const slideAt = (i: number) => slidesArr.get(i);
  const elsOf = (i: number) => slideAt(i)?.get('elements') as Y.Array<Y.Map<unknown>> | undefined;
  const findEl = (id: string, i = current) => elsOf(i)?.toArray().find((m) => m.get('id') === id);

  const updateEls = useCallback(
    (ids: string[], patch: Partial<SlideElement> | ((el: SlideElement) => Partial<SlideElement>)) => {
      if (readOnly) return;
      tx(() => {
        for (const id of ids) {
          const m = findEl(id);
          if (!m) continue;
          const p = typeof patch === 'function' ? patch(m.toJSON() as SlideElement) : patch;
          for (const [k, v] of Object.entries(p)) if (m.get(k) !== v) m.set(k, v);
        }
      });
    },
    [readOnly, current, slidesArr], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const addElements = (els: SlideElement[]) => {
    if (readOnly || !slide) return;
    tx(() => elsOf(current)?.push(els.map(elementMap)));
    setSelected(els.map((e) => e.id));
  };

  const removeElements = (ids: string[]) => {
    if (readOnly) return;
    tx(() => {
      const arr = elsOf(current);
      if (!arr) return;
      for (let i = arr.length - 1; i >= 0; i--) if (ids.includes(String(arr.get(i).get('id')))) arr.delete(i, 1);
    });
    setSelected([]);
    setEditing(null);
  };

  /** Moves elements in the stacking order (Y.Maps can't be moved, so they're recreated in place). */
  const restack = (ids: string[], where: 'front' | 'back' | 'forward' | 'backward') => {
    const arr = elsOf(current);
    if (!arr || readOnly) return;
    tx(() => {
      const list = arr.toArray().map((m) => m.toJSON() as SlideElement);
      const picked = list.filter((e) => ids.includes(e.id));
      const rest = list.filter((e) => !ids.includes(e.id));
      let next: SlideElement[];
      if (where === 'front') next = [...rest, ...picked];
      else if (where === 'back') next = [...picked, ...rest];
      else {
        next = [...list];
        const order = where === 'forward' ? [...picked].reverse() : picked;
        for (const p of order) {
          const i = next.findIndex((e) => e.id === p.id);
          const j = where === 'forward' ? Math.min(next.length - 1, i + 1) : Math.max(0, i - 1);
          next.splice(i, 1);
          next.splice(j, 0, p);
        }
      }
      arr.delete(0, arr.length);
      arr.push(next.map(elementMap));
    });
  };

  const addSlide = (layout: LayoutId, at = current + 1) => {
    if (readOnly) return;
    tx(() => slidesArr.insert(at, [slideMap(newSlide(layout, deck))]));
    setCurrent(at);
    setSelected([]);
  };
  const duplicateSlide = (i: number) => {
    const s = slides[i];
    if (!s || readOnly) return;
    tx(() => slidesArr.insert(i + 1, [slideMap({ ...s, id: newId(), elements: s.elements.map((e) => ({ ...e, id: newId() })) })]));
    setCurrent(i + 1);
  };
  const deleteSlide = (i: number) => {
    if (readOnly || slides.length <= 1) return;
    tx(() => slidesArr.delete(i, 1));
    setCurrent(Math.max(0, Math.min(i, slides.length - 2)));
    setSelected([]);
  };
  const moveSlide = (from: number, to: number) => {
    if (readOnly || from === to) return;
    const s = slides[from];
    tx(() => {
      slidesArr.delete(from, 1);
      slidesArr.insert(to, [slideMap(s)]);
    });
    setCurrent(to);
  };
  const setSlideProp = (i: number, patch: Partial<Omit<Slide, 'elements'>>) => {
    if (readOnly) return;
    tx(() => {
      const m = slideAt(i);
      if (m) for (const [k, v] of Object.entries(patch)) m.set(k, v);
    });
  };

  const exportPptx = () => slidesToPptx(deck, slides, file.name.replace(/\.[^.]+$/, ''));
  useImperativeHandle(ref, () => ({
    formats: PRESENTATION_FORMATS,
    exportAs: async (ext) => (ext === 'pptx' ? exportPptx() : convertBytes(file.workspaceId, 'presentation', 'pptx', ext, await exportPptx(), file.name)),
    exportOriginal: async () => {
      const ext = extOf(file.name);
      if (ext === 'pptx') return { blob: await exportPptx(), name: file.name };
      if (ext === 'odp' || ext === 'ppt') return { blob: await convertBytes(file.workspaceId, 'presentation', 'pptx', ext, await exportPptx(), file.name), name: file.name };
      return { blob: await exportPptx(), name: `${file.name.replace(/\.[^.]+$/, '')}.pptx` };
    },
  }));

  const uploadImage = async (f: File) => {
    try {
      const src = await uploadFile(file.workspaceId, f);
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 400, h: 300 });
        img.src = src;
      });
      const scale = Math.min(1, (deck.width * 0.6) / dims.w, (deck.height * 0.6) / dims.h);
      const w = dims.w * scale;
      const h = dims.h * scale;
      addElements([baseElement('image', { src, x: (deck.width - w) / 2, y: (deck.height - h) / 2, w, h })]);
    } catch (err) {
      toastError(err);
    }
  };

  // Keyboard shortcuts while the canvas has focus (not while typing in a text box).
  const onKey = (e: React.KeyboardEvent) => {
    if (editing || readOnly) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.shiftKey ? undo.redo() : undo.undo();
      e.preventDefault();
    } else if (mod && k === 'y') {
      undo.redo();
      e.preventDefault();
    } else if (mod && k === 'a') {
      setSelected(slide.elements.map((el) => el.id));
      e.preventDefault();
    } else if (mod && (k === 'c' || k === 'x') && selected.length) {
      clipboard = slide.elements.filter((el) => selected.includes(el.id)).map((el) => ({ ...el }));
      if (k === 'x') removeElements(selected);
      e.preventDefault();
    } else if (mod && k === 'v' && clipboard.length) {
      addElements(clipboard.map((el) => ({ ...el, id: newId(), x: el.x + 20, y: el.y + 20 })));
      clipboard = clipboard.map((el) => ({ ...el, x: el.x + 20, y: el.y + 20 }));
      e.preventDefault();
    } else if (mod && k === 'd' && selected.length) {
      addElements(slide.elements.filter((el) => selected.includes(el.id)).map((el) => ({ ...el, id: newId(), x: el.x + 20, y: el.y + 20 })));
      e.preventDefault();
    } else if ((k === 'delete' || k === 'backspace') && selected.length) {
      removeElements(selected);
      e.preventDefault();
    } else if (k.startsWith('arrow') && selected.length) {
      const step = e.shiftKey ? 10 : 1;
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
      const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
      updateEls(selected, (el) => ({ x: el.x + dx, y: el.y + dy }));
      e.preventDefault();
    } else if (k === 'escape') setSelected([]);
    else if (k === 'pagedown') setCurrent((c) => Math.min(slides.length - 1, c + 1));
    else if (k === 'pageup') setCurrent((c) => Math.max(0, c - 1));
    else if (k === 'f5') {
      setPresenting(e.shiftKey ? current : 0);
      e.preventDefault();
    }
  };

  if (!slide) return null;
  const sel = slide.elements.filter((e) => selected.includes(e.id));

  return (
    <div className="flex h-full flex-col bg-sidebar" onPaste={(e) => {
      const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
      if (f && !editing) {
        e.preventDefault();
        uploadImage(f);
      }
    }}>
      {!readOnly && (
        <SlidesToolbar
          deck={deck}
          slide={slide}
          selection={sel}
          editing={!!editing}
          canUndo={undo.canUndo()}
          canRedo={undo.canRedo()}
          onUndo={() => undo.undo()}
          onRedo={() => undo.redo()}
          onAddSlide={addSlide}
          onPresent={(fromCurrent) => setPresenting(fromCurrent ? current : 0)}
          onInsert={(el) => addElements([el])}
          onImage={uploadImage}
          onUpdate={(patch) => updateEls(selected, patch)}
          onUpdateEach={(fn) => updateEls(selected, fn)}
          onRestack={(where) => restack(selected, where)}
          onAlign={(how) => {
            if (!sel.length) return;
            const bounds = sel.length > 1 ? { x: Math.min(...sel.map((e) => e.x)), y: Math.min(...sel.map((e) => e.y)), r: Math.max(...sel.map((e) => e.x + e.w)), b: Math.max(...sel.map((e) => e.y + e.h)) } : { x: 0, y: 0, r: deck.width, b: deck.height };
            updateEls(selected, (el) => {
              if (how === 'left') return { x: bounds.x };
              if (how === 'center') return { x: (bounds.x + bounds.r) / 2 - el.w / 2 };
              if (how === 'right') return { x: bounds.r - el.w };
              if (how === 'top') return { y: bounds.y };
              if (how === 'middle') return { y: (bounds.y + bounds.b) / 2 - el.h / 2 };
              return { y: bounds.b - el.h };
            });
          }}
          onDistribute={(axis) => {
            if (sel.length < 3) return;
            const sorted = [...sel].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
            const first = sorted[0];
            const last = sorted[sorted.length - 1];
            const total = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y;
            const sizes = sorted.reduce((s, e) => s + (axis === 'h' ? e.w : e.h), 0);
            const gap = (total - sizes) / (sorted.length - 1);
            let pos = axis === 'h' ? first.x : first.y;
            const at = new Map<string, number>();
            for (const e of sorted) {
              at.set(e.id, pos);
              pos += (axis === 'h' ? e.w : e.h) + gap;
            }
            updateEls(selected, (el) => (axis === 'h' ? { x: at.get(el.id)! } : { y: at.get(el.id)! }));
          }}
          onDelete={() => removeElements(selected)}
          onSlide={(patch) => setSlideProp(current, patch)}
          onBackgroundImage={async (f) => {
            try {
              setSlideProp(current, { backgroundImage: await uploadFile(file.workspaceId, f) });
            } catch (err) {
              toastError(err);
            }
          }}
          onTheme={(id) => tx(() => deckMap.set('theme', id))}
          onSize={(w, h) => tx(() => (deckMap.set('width', w), deckMap.set('height', h)))}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <Thumbnails
          slides={slides}
          deck={deck}
          theme={theme}
          current={current}
          peers={peers}
          readOnly={readOnly}
          onSelect={(i) => {
            setCurrent(i);
            setSelected([]);
            setEditing(null);
          }}
          onMove={moveSlide}
          onDuplicate={duplicateSlide}
          onDelete={deleteSlide}
          onToggleHidden={(i) => setSlideProp(i, { hidden: !slides[i].hidden })}
          onAdd={() => addSlide('content', slides.length)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div tabIndex={0} onKeyDown={onKey} className="relative min-h-0 flex-1 outline-none">
            <Canvas
              key={slide.id}
              deck={deck}
              theme={theme}
              slide={slide}
              selected={selected}
              editing={editing}
              readOnly={readOnly}
              peers={peers.filter((p) => p.slideId === slide.id)}
              onSelect={setSelected}
              onEdit={setEditing}
              onChange={updateEls}
            />
          </div>
          <textarea
            value={slide.notes}
            readOnly={readOnly}
            onChange={(e) => setSlideProp(current, { notes: e.target.value })}
            placeholder={readOnly ? '' : 'Speaker notes'}
            className="h-20 shrink-0 resize-y border-t border-line bg-bg px-4 py-2 text-sm outline-none"
          />
        </div>
      </div>
      {presenting !== null && <Presenter slides={slides} deck={deck} theme={theme} start={presenting} onExit={(i) => (setPresenting(null), setCurrent(i))} />}
    </div>
  );
});

// ---------- rendering ----------

function textStyle(el: SlideElement, theme: Theme, isTitleSize = false): React.CSSProperties {
  return {
    fontSize: el.fontSize,
    fontFamily: el.fontFamily || (isTitleSize ? theme.headingFont : theme.font),
    color: el.color || (isTitleSize ? theme.title : theme.text),
    textAlign: el.align,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: el.valign === 'middle' ? 'center' : el.valign === 'bottom' ? 'flex-end' : 'flex-start',
    lineHeight: 1.2,
    padding: 8,
    overflowWrap: 'break-word',
  };
}

/** One element, drawn at its place on the slide (no interaction). */
function ElementBody({ el, theme, editingRef, onInput }: { el: SlideElement; theme: Theme; editingRef?: React.RefObject<HTMLDivElement | null>; onInput?: () => void }) {
  const title = el.fontSize >= 40;
  const editable = !!editingRef;
  const text = (html: string) =>
    editable ? (
      <div
        ref={editingRef}
        contentEditable
        suppressContentEditableWarning
        onInput={onInput}
        className="slide-text size-full outline-none"
        style={textStyle(el, theme, title)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    ) : (
      <div className="slide-text size-full" style={textStyle(el, theme, title)} dangerouslySetInnerHTML={{ __html: html }} />
    );
  if (el.type === 'image') return el.src ? <img src={el.src} alt="" draggable={false} className="size-full object-fill select-none" /> : null;
  if (el.type === 'line') {
    return (
      <svg width="100%" height="100%" viewBox={`0 0 ${Math.max(1, el.w)} ${Math.max(1, el.h)}`} preserveAspectRatio="none" className="overflow-visible">
        <defs>
          <marker id={`arrow-${el.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={el.stroke ?? '#404040'} />
          </marker>
        </defs>
        <line x1={0} y1={el.flipV ? el.h : 0} x2={el.w} y2={el.flipV ? 0 : el.h} stroke={el.stroke ?? '#404040'} strokeWidth={el.strokeWidth} markerEnd={el.arrow ? `url(#arrow-${el.id})` : undefined} />
      </svg>
    );
  }
  if (el.type === 'table') {
    const rows = el.rows ?? [];
    return (
      <table className="size-full table-fixed border-collapse" style={{ fontSize: el.fontSize, fontFamily: el.fontFamily || theme.font, color: el.color || theme.text }}>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="px-2 py-1 align-top"
                  style={{ border: `1px solid ${el.stroke ?? '#9aa0a6'}`, background: el.headerRow && r === 0 ? theme.accent : undefined, color: el.headerRow && r === 0 ? '#fff' : undefined, fontWeight: el.headerRow && r === 0 ? 600 : undefined }}
                  dangerouslySetInnerHTML={{ __html: cell }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (el.type === 'shape') {
    return (
      <div className="relative size-full">
        <svg width="100%" height="100%" viewBox={`0 0 ${Math.max(1, el.w)} ${Math.max(1, el.h)}`} preserveAspectRatio="none" className="absolute inset-0 overflow-visible">
          <path d={shapePath(el.shape ?? 'rect', el.w, el.h)} fill={el.fill ?? 'transparent'} stroke={el.stroke ?? 'none'} strokeWidth={el.stroke ? el.strokeWidth : 0} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="absolute inset-0">{text(el.html ?? '')}</div>
      </div>
    );
  }
  return <div className="size-full" style={{ background: el.fill ?? undefined, border: el.stroke ? `${el.strokeWidth}px solid ${el.stroke}` : undefined }}>{text(el.html ?? '')}</div>;
}

/** A whole slide drawn at its real size; the caller scales it. */
function SlideView({ slide, deck, theme, children }: { slide: Slide; deck: Deck; theme: Theme; children?: ReactNode }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        width: deck.width,
        height: deck.height,
        background: slide.background ?? theme.background,
        backgroundImage: slide.backgroundImage ? `url("${slide.backgroundImage}")` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {children ??
        slide.elements.map((el) => (
          <div key={el.id} className="absolute" style={{ left: el.x, top: el.y, width: el.w, height: el.h, transform: `rotate(${el.rot}deg) scale(${el.flipH ? -1 : 1}, 1)`, opacity: el.opacity }}>
            <ElementBody el={el} theme={theme} />
          </div>
        ))}
    </div>
  );
}

function useFit(ref: React.RefObject<HTMLDivElement | null>, deck: Deck, pad = 32) {
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.05, Math.min((el.clientWidth - pad * 2) / deck.width, (el.clientHeight - pad * 2) / deck.height)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, deck.width, deck.height, pad]);
  return scale;
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const handlePos: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

interface Gesture {
  kind: 'move' | 'resize' | 'rotate' | 'marquee';
  start: { x: number; y: number };
  els: SlideElement[];
  handle?: Handle;
  moved: boolean;
}

/** The slide being edited: selecting, moving, resizing, rotating and typing, with snapping guides. */
function Canvas({
  deck,
  theme,
  slide,
  selected,
  editing,
  readOnly,
  peers,
  onSelect,
  onEdit,
  onChange,
}: {
  deck: Deck;
  theme: Theme;
  slide: Slide;
  selected: string[];
  editing: string | null;
  readOnly: boolean;
  peers: { id: number; name: string; color: string; ids: string[] }[];
  onSelect: (ids: string[]) => void;
  onEdit: (id: string | null) => void;
  onChange: (ids: string[], patch: Partial<SlideElement> | ((el: SlideElement) => Partial<SlideElement>)) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const scale = useFit(host, deck);
  const gesture = useRef<Gesture | null>(null);
  const [live, setLive] = useState<Record<string, Partial<SlideElement>>>({});
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const toSlide = (e: { clientX: number; clientY: number }) => {
    const r = surface.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const commitText = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (!editing || !textRef.current) return;
    const html = textRef.current.innerHTML;
    onChange([editing], { html });
  }, [editing, onChange]);

  // Finishing a text edit saves it.
  useEffect(() => () => commitText(), [commitText]);
  useEffect(() => {
    if (editing && textRef.current) {
      textRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(textRef.current);
      range.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
    }
  }, [editing]);

  const snap = (els: SlideElement[], dx: number, dy: number) => {
    const others = slide.elements.filter((e) => !els.some((x) => x.id === e.id));
    const box = { x: Math.min(...els.map((e) => e.x)) + dx, y: Math.min(...els.map((e) => e.y)) + dy, r: Math.max(...els.map((e) => e.x + e.w)) + dx, b: Math.max(...els.map((e) => e.y + e.h)) + dy };
    const xs = [0, deck.width / 2, deck.width, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
    const ys = [0, deck.height / 2, deck.height, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
    const tol = 6 / scale;
    let sx = 0;
    let sy = 0;
    const gx: number[] = [];
    const gy: number[] = [];
    for (const edge of [box.x, (box.x + box.r) / 2, box.r]) {
      const hit = xs.find((x) => Math.abs(x - edge) < tol);
      if (hit !== undefined && !sx) {
        sx = hit - edge;
        gx.push(hit);
      }
    }
    for (const edge of [box.y, (box.y + box.b) / 2, box.b]) {
      const hit = ys.find((y) => Math.abs(y - edge) < tol);
      if (hit !== undefined && !sy) {
        sy = hit - edge;
        gy.push(hit);
      }
    }
    setGuides({ x: gx, y: gy });
    return { dx: dx + sx, dy: dy + sy };
  };

  const onElementDown = (e: RPointerEvent, el: SlideElement) => {
    if (readOnly || editing === el.id) return;
    e.stopPropagation();
    if (editing) {
      commitText();
      onEdit(null);
    }
    let ids = selected;
    if (e.shiftKey) ids = selected.includes(el.id) ? selected.filter((i) => i !== el.id) : [...selected, el.id];
    else if (!selected.includes(el.id)) ids = [el.id];
    onSelect(ids);
    surface.current!.setPointerCapture(e.pointerId);
    gesture.current = { kind: 'move', start: toSlide(e), els: slide.elements.filter((x) => ids.includes(x.id)), moved: false };
  };

  const onHandleDown = (e: RPointerEvent, el: SlideElement, handle: Handle | 'rotate') => {
    e.stopPropagation();
    surface.current!.setPointerCapture(e.pointerId);
    gesture.current = { kind: handle === 'rotate' ? 'rotate' : 'resize', handle: handle === 'rotate' ? undefined : handle, start: toSlide(e), els: [el], moved: false };
  };

  const onSurfaceDown = (e: RPointerEvent) => {
    if (editing) {
      commitText();
      onEdit(null);
    }
    if (readOnly) return;
    onSelect([]);
    surface.current!.setPointerCapture(e.pointerId);
    gesture.current = { kind: 'marquee', start: toSlide(e), els: [], moved: false };
  };

  const onMove = (e: RPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const p = toSlide(e);
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) * scale < 3) return;
    g.moved = true;
    if (g.kind === 'marquee') {
      const box = { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      setMarquee(box);
      onSelect(slide.elements.filter((el) => el.x < box.x + box.w && el.x + el.w > box.x && el.y < box.y + box.h && el.y + el.h > box.y).map((el) => el.id));
      return;
    }
    if (g.kind === 'move') {
      const s = e.altKey ? { dx, dy } : snap(g.els, dx, dy);
      setLive(Object.fromEntries(g.els.map((el) => [el.id, { x: el.x + s.dx, y: el.y + s.dy }])));
      return;
    }
    const el = g.els[0];
    if (g.kind === 'rotate') {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      let angle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
      if (e.shiftKey) angle = Math.round(angle / 15) * 15;
      setLive({ [el.id]: { rot: Math.round(((angle % 360) + 360) % 360) } });
      return;
    }
    const h = g.handle!;
    let { x, y, w, h: hh } = el;
    if (h.includes('e')) w = Math.max(10, el.w + dx);
    if (h.includes('s')) hh = Math.max(10, el.h + dy);
    if (h.includes('w')) {
      w = Math.max(10, el.w - dx);
      x = el.x + el.w - w;
    }
    if (h.includes('n')) {
      hh = Math.max(10, el.h - dy);
      y = el.y + el.h - hh;
    }
    // Corners keep the shape's proportions with Shift (and always for pictures).
    if ((e.shiftKey || el.type === 'image') && h.length === 2) {
      const ratio = el.w / el.h;
      if (w / hh > ratio) w = hh * ratio;
      else hh = w / ratio;
      if (h.includes('w')) x = el.x + el.w - w;
      if (h.includes('n')) y = el.y + el.h - hh;
    }
    setLive({ [el.id]: { x, y, w, h: hh } });
  };

  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setGuides({ x: [], y: [] });
    setMarquee(null);
    if (!g || !g.moved) return;
    const changes = live;
    setLive({});
    for (const [id, patch] of Object.entries(changes)) onChange([id], patch);
  };

  const shown = slide.elements.map((el) => ({ ...el, ...live[el.id] }));
  return (
    <div ref={host} className="absolute inset-0 flex items-center justify-center overflow-hidden">
      <div style={{ width: deck.width * scale, height: deck.height * scale }} className="relative shadow-pop">
        <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          <div ref={surface} onPointerDown={onSurfaceDown} onPointerMove={onMove} onPointerUp={onUp} className="touch-none">
            <SlideView slide={slide} deck={deck} theme={theme}>
              {shown.map((el) => {
                const isSel = selected.includes(el.id);
                const others = peers.filter((p) => p.ids.includes(el.id));
                return (
                  <div
                    key={el.id}
                    onPointerDown={(e) => onElementDown(e, el)}
                    onDoubleClick={() => !readOnly && (el.type === 'text' || el.type === 'shape') && onEdit(el.id)}
                    className={clsx('absolute', !readOnly && editing !== el.id && 'cursor-move')}
                    style={{ left: el.x, top: el.y, width: el.w, height: el.h, transform: `rotate(${el.rot}deg)`, opacity: el.opacity }}
                  >
                    <div className="size-full" style={{ transform: el.flipH ? 'scaleX(-1)' : undefined }}>
                      <ElementBody
                        el={el}
                        theme={theme}
                        editingRef={editing === el.id ? textRef : undefined}
                        onInput={() => {
                          clearTimeout(saveTimer.current);
                          saveTimer.current = setTimeout(commitText, 600);
                        }}
                      />
                    </div>
                    {others.map((p, i) => (
                      <div key={p.id} className="pointer-events-none absolute -inset-1 rounded-sm border-2" style={{ borderColor: p.color, margin: -i * 3 }}>
                        <span className="absolute -top-5 left-0 rounded px-1 text-[11px] whitespace-nowrap text-white" style={{ background: p.color, transform: `scale(${1 / scale})`, transformOrigin: '0 100%' }}>
                          {p.name}
                        </span>
                      </div>
                    ))}
                    {isSel && !readOnly && (
                      <>
                        <div className="pointer-events-none absolute -inset-px border border-accent" style={{ borderWidth: 1.5 / scale }} />
                        {editing !== el.id &&
                          HANDLES.map((h) => (
                            <div
                              key={h}
                              onPointerDown={(e) => onHandleDown(e, el, h)}
                              className="absolute rounded-sm border border-accent bg-white"
                              style={{
                                width: 10 / scale,
                                height: 10 / scale,
                                left: handlePos[h][0] * el.w - 5 / scale,
                                top: handlePos[h][1] * el.h - 5 / scale,
                                cursor: `${h}-resize`,
                              }}
                            />
                          ))}
                        {editing !== el.id && selected.length === 1 && (
                          <div
                            onPointerDown={(e) => onHandleDown(e, el, 'rotate')}
                            className="absolute rounded-full border border-accent bg-white"
                            style={{ width: 12 / scale, height: 12 / scale, left: el.w / 2 - 6 / scale, top: -28 / scale, cursor: 'grab' }}
                            title="Rotate (Shift: 15° steps)"
                          />
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              {guides.x.map((x) => (
                <div key={`gx${x}`} className="pointer-events-none absolute inset-y-0 bg-[#ff3d9a]" style={{ left: x, width: 1 / scale }} />
              ))}
              {guides.y.map((y) => (
                <div key={`gy${y}`} className="pointer-events-none absolute inset-x-0 bg-[#ff3d9a]" style={{ top: y, height: 1 / scale }} />
              ))}
              {marquee && <div className="pointer-events-none absolute border border-accent bg-accent/10" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
            </SlideView>
          </div>
        </div>
      </div>
    </div>
  );
}

function Thumbnails({
  slides,
  deck,
  theme,
  current,
  peers,
  readOnly,
  onSelect,
  onMove,
  onDuplicate,
  onDelete,
  onToggleHidden,
  onAdd,
}: {
  slides: Slide[];
  deck: Deck;
  theme: Theme;
  current: number;
  peers: { id: number; name: string; color: string; slideId?: string }[];
  readOnly: boolean;
  onSelect: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onDuplicate: (i: number) => void;
  onDelete: (i: number) => void;
  onToggleHidden: (i: number) => void;
  onAdd: () => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const width = 168;
  const scale = width / deck.width;
  return (
    <div className="flex w-[212px] shrink-0 flex-col border-r border-line bg-bg max-sm:w-[132px]">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {slides.map((s, i) => {
          const here = peers.filter((p) => p.slideId === s.id);
          return (
            <div
              key={s.id}
              draggable={!readOnly}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
              onDrop={() => {
                if (drag !== null) onMove(drag, i);
                setDrag(null);
                setOver(null);
              }}
              className={clsx('group flex gap-1.5', over === i && drag !== null && drag !== i && 'border-t-2 border-accent pt-1')}
            >
              <span className="w-4 shrink-0 pt-1 text-right text-xs text-faint tabular-nums">{i + 1}</span>
              <div className="relative min-w-0 flex-1">
                <button
                  onClick={() => onSelect(i)}
                  className={clsx('block overflow-hidden rounded-md border-2', i === current ? 'border-accent' : 'border-transparent hover:border-line', s.hidden && 'opacity-40')}
                  style={{ width: '100%', aspectRatio: `${deck.width} / ${deck.height}` }}
                >
                  <div className="pointer-events-none origin-top-left" style={{ transform: `scale(${scale})` }}>
                    <SlideView slide={s} deck={deck} theme={theme} />
                  </div>
                </button>
                {here.length > 0 && (
                  <div className="absolute -right-1 -bottom-1 flex -space-x-1">
                    {here.slice(0, 3).map((p) => (
                      <Avatar key={p.id} name={p.name} color={p.color} size={16} className="ring-1 ring-bg" />
                    ))}
                  </div>
                )}
                {!readOnly && (
                  <div className="absolute top-1 right-1 hidden gap-0.5 group-hover:flex">
                    <SmallButton label={s.hidden ? 'Show slide' : 'Hide slide'} onClick={() => onToggleHidden(i)}>
                      {s.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
                    </SmallButton>
                    <SmallButton label="Duplicate slide" onClick={() => onDuplicate(i)}>
                      <Copy size={12} />
                    </SmallButton>
                    {slides.length > 1 && (
                      <SmallButton label="Delete slide" onClick={() => onDelete(i)}>
                        <Trash2 size={12} />
                      </SmallButton>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!readOnly && (
        <button onClick={onAdd} className="m-3 mt-0 flex h-8 items-center justify-center gap-1 rounded-md border border-dashed border-line text-sm text-muted hover:bg-hover hover:text-fg">
          <Plus size={14} /> Slide
        </button>
      )}
    </div>
  );
}

function SmallButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-5 items-center justify-center rounded bg-surface/90 text-muted shadow-sm hover:text-fg"
    >
      {children}
    </button>
  );
}

function TButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx('flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-sm disabled:opacity-35', active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-0.5 h-6 w-px shrink-0 bg-line" />;

/** Formatting while typing in a text box (applies to the selected text). */
function exec(cmd: string, value?: string) {
  document.execCommand('styleWithCSS', false, 'true');
  document.execCommand(cmd, false, value);
}

function wrapSelection(style: string) {
  const s = window.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return false;
  const range = s.getRangeAt(0);
  const span = document.createElement('span');
  span.setAttribute('style', style);
  span.append(range.extractContents());
  range.insertNode(span);
  s.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(span);
  s.addRange(r);
  span.closest('[contenteditable]')?.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function SlidesToolbar({
  deck,
  slide,
  selection,
  editing,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAddSlide,
  onPresent,
  onInsert,
  onImage,
  onUpdate,
  onUpdateEach,
  onRestack,
  onAlign,
  onDistribute,
  onDelete,
  onSlide,
  onBackgroundImage,
  onTheme,
  onSize,
}: {
  deck: Deck;
  slide: Slide;
  selection: SlideElement[];
  editing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAddSlide: (layout: LayoutId) => void;
  onPresent: (fromCurrent: boolean) => void;
  onInsert: (el: SlideElement) => void;
  onImage: (f: File) => void;
  onUpdate: (patch: Partial<SlideElement>) => void;
  /** A change worked out separately for each selected element. */
  onUpdateEach: (fn: (el: SlideElement) => Partial<SlideElement>) => void;
  onRestack: (where: 'front' | 'back' | 'forward' | 'backward') => void;
  onAlign: (how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  onDistribute: (axis: 'h' | 'v') => void;
  onDelete: () => void;
  onSlide: (patch: Partial<Omit<Slide, 'elements'>>) => void;
  onBackgroundImage: (f: File) => void;
  onTheme: (id: string) => void;
  onSize: (w: number, h: number) => void;
}) {
  const [pop, setPop] = useState<{ kind: string; anchor: Anchor } | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const open = (kind: string) => (e: React.MouseEvent<HTMLElement>) => setPop({ kind, anchor: e.currentTarget.getBoundingClientRect() });
  const one = selection[0];
  const hasText = selection.some((e) => e.type === 'text' || e.type === 'shape' || e.type === 'table');
  const center = (w: number, h: number) => ({ x: (deck.width - w) / 2, y: (deck.height - h) / 2, w, h });
  const theme = themeOf(deck);

  const textCmd = (cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough') => {
    if (editing) return exec(cmd);
    // Not typing: apply to all the text in the selected boxes.
    const tag = { bold: 'strong', italic: 'em', underline: 'u', strikeThrough: 's' }[cmd];
    const anyOff = selection.some((el) => el.html && !new RegExp(`<${tag}>`).test(el.html));
    onUpdateEach((el) => {
      if (!el.html) return {};
      const stripped = el.html.replace(new RegExp(`</?${tag}>`, 'g'), '');
      // Turn it on everywhere unless every box already has it, in which case turn it off.
      return { html: anyOff ? stripped.replace(/<(p|li)([^>]*)>(.*?)<\/\1>/g, `<$1$2><${tag}>$3</${tag}></$1>`) : stripped };
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-bg px-2 py-1">
      <TButton label="New slide" onClick={open('layouts')}>
        <Plus size={16} /> <span className="max-sm:hidden">Slide</span> <ChevronDown size={12} />
      </TButton>
      <TButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
        <Undo2 size={16} />
      </TButton>
      <TButton label="Redo (Ctrl+Y)" disabled={!canRedo} onClick={onRedo}>
        <Redo2 size={16} />
      </TButton>
      <Sep />
      <TButton label="Text box" onClick={() => onInsert(baseElement('text', { ...center(480, 90), html: '<p>Text</p>', fontSize: 28 }))}>
        <Type size={16} />
      </TButton>
      <TButton label="Shape" onClick={open('shapes')}>
        <ShapesIcon size={16} />
      </TButton>
      <TButton label="Image" onClick={() => imageInput.current?.click()}>
        <ImagePlus size={16} />
      </TButton>
      <TButton label="Table" onClick={open('table')}>
        <Table2 size={16} />
      </TButton>
      <TButton label="Line" onClick={() => onInsert(baseElement('line', { ...center(300, 0.01), h: 1, stroke: theme.text, strokeWidth: 3 }))}>
        <Minus size={16} />
      </TButton>
      <TButton label="Arrow" onClick={() => onInsert(baseElement('line', { ...center(300, 0.01), h: 1, stroke: theme.text, strokeWidth: 3, arrow: true }))}>
        <MoveRight size={16} />
      </TButton>
      {selection.length > 0 && (
        <>
          <Sep />
          <TButton label="Fill" onClick={open('fill')}>
            <span className="size-4 rounded border border-line" style={{ background: one?.fill ?? 'transparent' }} />
          </TButton>
          <TButton label="Border" onClick={open('stroke')}>
            <span className="size-4 rounded border-2" style={{ borderColor: one?.stroke ?? 'var(--line)' }} />
          </TButton>
          <select value={one?.strokeWidth ?? 2} onChange={(e) => onUpdate({ strokeWidth: Number(e.target.value) })} className="h-8 w-14 shrink-0 rounded-md border border-line bg-surface px-1 text-sm" title="Border width">
            {[1, 2, 3, 4, 6, 8, 12].map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
          <label className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted" title="Opacity">
            <input type="range" min={0.1} max={1} step={0.05} value={one?.opacity ?? 1} onChange={(e) => onUpdate({ opacity: Number(e.target.value) })} className="w-16" />
          </label>
          <TButton label="Arrange" onClick={open('arrange')}>
            <Layers size={16} />
          </TButton>
          <TButton label="Delete (Del)" onClick={onDelete}>
            <Trash2 size={16} />
          </TButton>
        </>
      )}
      {hasText && (
        <>
          <Sep />
          <select
            value={FONTS.includes(one?.fontFamily ?? '') ? one?.fontFamily : ''}
            onChange={(e) => (editing ? exec('fontName', e.target.value) : onUpdate({ fontFamily: e.target.value }))}
            className="h-8 w-28 shrink-0 rounded-md border border-line bg-surface px-1 text-sm"
            title="Font"
          >
            <option value="">Theme font</option>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
          <select
            value={SIZES.includes(one?.fontSize ?? 0) ? one?.fontSize : ''}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!editing || !wrapSelection(`font-size: ${v}px`)) onUpdate({ fontSize: v });
            }}
            className="h-8 w-16 shrink-0 rounded-md border border-line bg-surface px-1 text-sm"
            title="Font size"
          >
            {!SIZES.includes(one?.fontSize ?? 0) && <option value="">{one?.fontSize}</option>}
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <TButton label="Bold" onClick={() => textCmd('bold')}>
            <Bold size={16} />
          </TButton>
          <TButton label="Italic" onClick={() => textCmd('italic')}>
            <Italic size={16} />
          </TButton>
          <TButton label="Underline" onClick={() => textCmd('underline')}>
            <Underline size={16} />
          </TButton>
          <TButton label="Strikethrough" onClick={() => textCmd('strikeThrough')}>
            <Strikethrough size={16} />
          </TButton>
          <TButton label="Text color" onClick={open('color')}>
            <span className="text-sm font-bold" style={{ color: one?.color || theme.text, textDecoration: 'underline' }}>
              A
            </span>
          </TButton>
          {(
            [
              ['left', AlignLeft],
              ['center', AlignCenter],
              ['right', AlignRight],
              ['justify', AlignJustify],
            ] as const
          ).map(([a, Icon]) => (
            <TButton key={a} label={`Align ${a}`} active={one?.align === a} onClick={() => (editing ? exec(`justify${a === 'justify' ? 'Full' : a[0].toUpperCase() + a.slice(1)}`) : onUpdate({ align: a }))}>
              <Icon size={16} />
            </TButton>
          ))}
          <select value={one?.valign ?? 'top'} onChange={(e) => onUpdate({ valign: e.target.value as SlideElement['valign'] })} className="h-8 w-20 shrink-0 rounded-md border border-line bg-surface px-1 text-sm" title="Vertical alignment">
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
          <TButton label="Bulleted list" onClick={() => editing && exec('insertUnorderedList')} disabled={!editing}>
            <List size={16} />
          </TButton>
          <TButton label="Numbered list" onClick={() => editing && exec('insertOrderedList')} disabled={!editing}>
            <ListOrdered size={16} />
          </TButton>
        </>
      )}
      {selection.length === 0 && (
        <>
          <Sep />
          <TButton label="Slide background" onClick={open('background')}>
            <span className="size-4 rounded border border-line" style={{ background: slide.background ?? theme.background }} /> <span className="max-md:hidden">Background</span>
          </TButton>
          <select value={slide.transition} onChange={(e) => onSlide({ transition: e.target.value as Slide['transition'] })} className="h-8 shrink-0 rounded-md border border-line bg-surface px-1 text-sm" title="Transition">
            <option value="none">No transition</option>
            <option value="fade">Fade</option>
            <option value="push">Push</option>
            <option value="zoom">Zoom</option>
          </select>
          <select value={deck.theme} onChange={(e) => onTheme(e.target.value)} className="h-8 shrink-0 rounded-md border border-line bg-surface px-1 text-sm" title="Theme">
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            value={`${deck.width}x${deck.height}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map(Number);
              onSize(w, h);
            }}
            className="h-8 shrink-0 rounded-md border border-line bg-surface px-1 text-sm"
            title="Slide size"
          >
            <option value="1280x720">Widescreen 16:9</option>
            <option value="960x720">Standard 4:3</option>
            <option value="1280x800">16:10</option>
            <option value="1080x1080">Square</option>
            <option value="1080x1350">Portrait 4:5</option>
            {!['1280x720', '960x720', '1280x800', '1080x1080', '1080x1350'].includes(`${deck.width}x${deck.height}`) && (
              <option value={`${deck.width}x${deck.height}`}>
                Custom ({deck.width}×{deck.height})
              </option>
            )}
          </select>
        </>
      )}
      <span className="flex-1" />
      <TButton label="Present from the start (F5)" onClick={() => onPresent(false)}>
        <Play size={16} /> <span className="max-sm:hidden">Present</span>
      </TButton>
      <TButton label="Present from this slide (Shift+F5)" onClick={() => onPresent(true)}>
        <ChevronDown size={12} />
      </TButton>

      <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => (e.target.files?.[0] && onImage(e.target.files[0]), (e.target.value = ''))} />
      <input ref={bgInput} type="file" accept="image/*" hidden onChange={(e) => (e.target.files?.[0] && onBackgroundImage(e.target.files[0]), (e.target.value = ''))} />
      <Popover anchor={pop?.anchor ?? null} onClose={() => setPop(null)}>
        {pop?.kind === 'layouts' && (
          <div className="w-56 p-1">
            {LAYOUTS.map((l) => (
              <button key={l.id} onClick={() => (onAddSlide(l.id), setPop(null))} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-hover">
                {l.label}
              </button>
            ))}
          </div>
        )}
        {pop?.kind === 'shapes' && (
          <div className="grid w-64 grid-cols-6 gap-1 p-2">
            {SHAPES.map((s) => (
              <button
                key={s.shape}
                title={s.label}
                onClick={() => {
                  onInsert(baseElement('shape', { ...center(240, 160), shape: s.shape as ShapeType, fill: theme.accent, stroke: null, html: '', color: '#ffffff', align: 'center', valign: 'middle', fontSize: 24 }));
                  setPop(null);
                }}
                className="flex size-9 items-center justify-center rounded hover:bg-hover"
              >
                <svg width={26} height={20} viewBox="0 0 26 20">
                  <path d={shapePath(s.shape, 26, 20)} fill="none" stroke="currentColor" strokeWidth={1.5} />
                </svg>
              </button>
            ))}
          </div>
        )}
        {pop?.kind === 'table' && (
          <TableGrid
            onPick={(r, c) => {
              onInsert(
                baseElement('table', {
                  ...center(Math.min(deck.width * 0.8, c * 160), Math.min(deck.height * 0.7, r * 48)),
                  rows: Array.from({ length: r }, () => Array.from({ length: c }, () => '')),
                  headerRow: true,
                  fontSize: 18,
                  stroke: '#9aa0a6',
                  strokeWidth: 1,
                }),
              );
              setPop(null);
            }}
          />
        )}
        {(pop?.kind === 'fill' || pop?.kind === 'stroke' || pop?.kind === 'color') && (
          <Swatches
            onPick={(c) => {
              if (pop.kind === 'fill') onUpdate({ fill: c });
              else if (pop.kind === 'stroke') onUpdate({ stroke: c });
              else if (editing && c) exec('foreColor', c);
              else onUpdate({ color: c ?? '' });
              setPop(null);
            }}
          />
        )}
        {pop?.kind === 'background' && (
          <div>
            <Swatches onPick={(c) => (onSlide({ background: c, backgroundImage: null }), setPop(null))} />
            <div className="flex gap-2 border-t border-line p-2">
              <button onClick={() => bgInput.current?.click()} className="h-7 rounded-md border border-line px-2 text-xs hover:bg-hover">
                Picture…
              </button>
              {slide.backgroundImage && (
                <button onClick={() => onSlide({ backgroundImage: null })} className="h-7 rounded-md px-2 text-xs text-muted hover:bg-hover">
                  Remove picture
                </button>
              )}
            </div>
          </div>
        )}
        {pop?.kind === 'arrange' && (
          <div className="w-60 p-1 text-sm">
            <MenuRow icon={<BringToFront size={15} />} label="Bring to front" onClick={() => onRestack('front')} />
            <MenuRow icon={<ArrowUpToLine size={15} />} label="Bring forward" onClick={() => onRestack('forward')} />
            <MenuRow icon={<ArrowDownToLine size={15} />} label="Send backward" onClick={() => onRestack('backward')} />
            <MenuRow icon={<SendToBack size={15} />} label="Send to back" onClick={() => onRestack('back')} />
            <div className="my-1 h-px bg-line" />
            <div className="px-2 pb-1 text-xs text-faint">{selection.length > 1 ? 'Align to each other' : 'Align to the slide'}</div>
            <div className="grid grid-cols-6 gap-0.5 px-1">
              <TButton label="Align left" onClick={() => onAlign('left')}>
                <AlignStartVertical size={15} />
              </TButton>
              <TButton label="Align centers" onClick={() => onAlign('center')}>
                <AlignHorizontalJustifyCenter size={15} />
              </TButton>
              <TButton label="Align right" onClick={() => onAlign('right')}>
                <AlignEndVertical size={15} />
              </TButton>
              <TButton label="Align top" onClick={() => onAlign('top')}>
                <AlignStartVertical size={15} className="rotate-90" />
              </TButton>
              <TButton label="Align middles" onClick={() => onAlign('middle')}>
                <AlignVerticalJustifyCenter size={15} />
              </TButton>
              <TButton label="Align bottom" onClick={() => onAlign('bottom')}>
                <AlignEndVertical size={15} className="rotate-90" />
              </TButton>
            </div>
            {selection.length >= 3 && (
              <>
                <MenuRow icon={<AlignHorizontalJustifyCenter size={15} />} label="Distribute horizontally" onClick={() => onDistribute('h')} />
                <MenuRow icon={<AlignVerticalJustifyCenter size={15} />} label="Distribute vertically" onClick={() => onDistribute('v')} />
              </>
            )}
            <div className="my-1 h-px bg-line" />
            <MenuRow icon={<span className="w-4 text-center">⇋</span>} label="Flip horizontally" onClick={() => onUpdate({ flipH: !one?.flipH })} />
            <MenuRow icon={<span className="w-4 text-center">⟲</span>} label="Reset rotation" onClick={() => onUpdate({ rot: 0 })} />
          </div>
        )}
      </Popover>
    </div>
  );
}

function MenuRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-hover">
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
}

function Swatches({ onPick }: { onPick: (c: string | null) => void }) {
  return (
    <div className="w-56 p-2">
      <div className="grid grid-cols-10 gap-1">
        {SWATCHES.map((c) => (
          <button key={c} onClick={() => onPick(c)} className="size-4.5 rounded-sm border border-black/10" style={{ background: c }} aria-label={c} />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Custom
          <input type="color" onChange={(e) => onPick(e.target.value)} className="h-6 w-8 cursor-pointer" />
        </label>
        <span className="flex-1" />
        <button onClick={() => onPick(null)} className="text-xs text-muted hover:text-fg">
          None
        </button>
      </div>
    </div>
  );
}

function TableGrid({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState({ r: 2, c: 2 });
  return (
    <div className="p-2">
      <div className="grid grid-cols-8 gap-0.5">
        {Array.from({ length: 64 }, (_, i) => {
          const r = Math.floor(i / 8);
          const c = i % 8;
          return (
            <button
              key={i}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => onPick(r + 1, c + 1)}
              className={clsx('size-4 rounded-[2px] border', r <= hover.r && c <= hover.c ? 'border-accent bg-accent-soft' : 'border-line')}
            />
          );
        })}
      </div>
      <div className="mt-1.5 text-center text-xs text-muted">
        {hover.r + 1} × {hover.c + 1}
      </div>
    </div>
  );
}

/** Full-screen slideshow: arrows, space, click or swipe to move; N shows notes; B blanks the screen; Esc ends. */
function Presenter({ slides, deck, theme, start, onExit }: { slides: Slide[]; deck: Deck; theme: Theme; start: number; onExit: (index: number) => void }) {
  const shown = slides.map((s, i) => ({ s, i })).filter((x) => !x.s.hidden || x.i === start);
  const [pos, setPos] = useState(Math.max(0, shown.findIndex((x) => x.i === start)));
  const [notes, setNotes] = useState(false);
  const [blank, setBlank] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const scale = useFit(box, deck, 0);
  const touch = useRef<number | null>(null);
  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    onExit(shown[pos]?.i ?? 0);
  }, [onExit, pos, shown]);

  useEffect(() => {
    box.current?.requestFullscreen?.().catch(() => {});
    const onFs = () => !document.fullscreenElement && exit();
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(k) && k !== 'n') setPos((p) => Math.min(shown.length - 1, p + 1));
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) setPos((p) => Math.max(0, p - 1));
      else if (k === 'Home') setPos(0);
      else if (k === 'End') setPos(shown.length - 1);
      else if (k === 'Escape') exit();
      else if (k.toLowerCase() === 'n') setNotes((v) => !v);
      else if (k.toLowerCase() === 'b' || k === '.') setBlank((v) => !v);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown.length, exit]);

  const cur = shown[pos]?.s;
  const anim = { fade: 'slide-in-fade', push: 'slide-in-push', zoom: 'slide-in-zoom', none: '' }[cur?.transition ?? 'none'];
  return (
    <div
      ref={box}
      className="fixed inset-0 z-[100] flex cursor-pointer items-center justify-center bg-black select-none"
      onClick={() => setPos((p) => Math.min(shown.length - 1, p + 1))}
      onContextMenu={(e) => (e.preventDefault(), setPos((p) => Math.max(0, p - 1)))}
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current === null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        if (Math.abs(dx) > 40) setPos((p) => (dx < 0 ? Math.min(shown.length - 1, p + 1) : Math.max(0, p - 1)));
        touch.current = null;
      }}
    >
      {cur && !blank && (
        <div key={cur.id} className={anim} style={{ width: deck.width * scale, height: deck.height * scale }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
            <SlideView slide={cur} deck={deck} theme={theme} />
          </div>
        </div>
      )}
      <div className="absolute right-4 bottom-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white/70">
        {pos + 1} / {shown.length} · N notes · B blank · Esc
      </div>
      <button onClick={(e) => (e.stopPropagation(), exit())} className="absolute top-3 right-3 rounded-full bg-black/50 p-2 text-white/70 hover:text-white" aria-label="End slideshow">
        <X size={18} />
      </button>
      {notes && cur?.notes && (
        <div onClick={(e) => e.stopPropagation()} className="absolute inset-x-0 bottom-0 max-h-[30vh] overflow-y-auto bg-black/80 px-8 py-4 text-lg whitespace-pre-wrap text-white">
          {cur.notes}
        </div>
      )}
    </div>
  );
}
