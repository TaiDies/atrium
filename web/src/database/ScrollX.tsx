import clsx from 'clsx';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * A sideways-scrolling area with its scrollbar also shown at the top (kept in step with the one at the
 * bottom), so wide tables and boards can be scrolled without going down to the end first.
 */
export function ScrollX({ className, children }: { className?: string; children: ReactNode }) {
  const top = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.scrollWidth);
      setNeeded(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // Each scrollbar moves the other (only when they differ, so they don't echo back and forth).
  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (from && to && Math.abs(to.scrollLeft - from.scrollLeft) > 0.5) to.scrollLeft = from.scrollLeft;
  };

  return (
    <>
      <div
        ref={top}
        aria-hidden
        onScroll={() => follow(top.current, body.current)}
        className={clsx('sticky top-0 z-10 overflow-x-auto overflow-y-hidden bg-bg', !needed && 'hidden')}
        style={{ height: 14 }}
      >
        <div style={{ width, height: 1 }} />
      </div>
      <div ref={body} onScroll={() => follow(body.current, top.current)} className={clsx('overflow-x-auto', className)}>
        {children}
      </div>
    </>
  );
}
