import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useBackClose, usePhone } from '../lib/device';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx('inline-block size-4 animate-spin rounded-full border-2 border-current border-e-transparent', className)}
      aria-label="Loading"
    />
  );
}

export function FullScreenSpinner() {
  return (
    <div className="flex h-full items-center justify-center text-muted">
      <Spinner className="size-6" />
    </div>
  );
}

export function Avatar({ name, color, size = 24, className, title }: { name: string; color: string; size?: number; className?: string; title?: string }) {
  return (
    <span
      title={title ?? name}
      className={clsx('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.45) }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-fg',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        className,
      )}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

export function IconButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        'h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none transition-shadow placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent-soft',
        className,
      )}
    />
  );
}

/** Open dialogs, newest last: keys go to the top one only. */
const openDialogs: symbol[] = [];

/** What Tab can reach inside an element. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 440,
  maxHeight = '76vh',
  top = '12vh',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
  maxHeight?: string;
  top?: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const me = Symbol('dialog');
    openDialogs.push(me);
    const before = document.activeElement as HTMLElement | null;
    // Focus moves into the dialog (unless something in it already took it, like an autofocus field).
    requestAnimationFrame(() => {
      const el = box.current;
      if (el && !el.contains(document.activeElement)) (focusables(el)[0] ?? el).focus();
    });
    const onKey = (e: KeyboardEvent) => {
      // Only the dialog on top answers (one opened from another closes first).
      if (openDialogs[openDialogs.length - 1] !== me) return;
      if (e.key === 'Tab' && box.current) {
        // Tab stays inside the dialog.
        const items = focusables(box.current);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      // Escape closes the innermost thing first: menus inside the dialog, then the dialog.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[data-atrium-popover], .bn-suggestion-menu')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openDialogs.splice(openDialogs.indexOf(me), 1);
      // Focus goes back to what opened it.
      if (before && document.contains(before)) before.focus();
    };
  }, [open, onClose]);
  const phone = usePhone();
  useBackClose(open, onClose);
  if (!open) return null;
  return createPortal(
    <div
      className={clsx('fixed inset-0 z-50 flex justify-center bg-black/40', phone ? 'items-end' : 'items-start px-4')}
      style={phone ? undefined : { paddingTop: top }}
      onMouseDown={onClose}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={clsx('shadow-pop flex w-full flex-col overflow-hidden bg-surface', phone ? 'atrium-sheet rounded-t-2xl' : 'rounded-xl', className)}
        style={phone ? { maxWidth: '100%', maxHeight: '94dvh' } : { maxWidth: width, maxHeight }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {phone && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" aria-hidden />}
        {title && (
          <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-2">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            <IconButton onClick={onClose} aria-label="Close">
              <X size={16} />
            </IconButton>
          </div>
        )}
        {/* Anything taller than the window scrolls inside it (the title stays put). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export type Anchor = DOMRect | { x: number; y: number };

/** A floating panel positioned next to an element or at a point, closed by outside click or Escape. */
export function Popover({
  anchor,
  onClose,
  children,
  align = 'start',
  className,
}: {
  anchor: Anchor | null;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const phone = usePhone();
  useBackClose(!!anchor, onClose);

  useLayoutEffect(() => {
    if (!anchor || !ref.current || phone) return;
    const el = ref.current.getBoundingClientRect();
    const rect = 'width' in anchor ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    let left = align === 'end' ? rect.right - el.width : rect.left;
    let top = rect.bottom + 4;
    if (top + el.height > window.innerHeight - 8) top = Math.max(8, rect.top - el.height - 4);
    left = Math.min(Math.max(8, left), window.innerWidth - el.width - 8);
    setPos({ left, top });
  }, [anchor, align, phone]);

  useEffect(() => {
    if (!anchor) return;
    // Listened for while the event goes down (capture), so blocks that keep their clicks to themselves
    // (databases and other embeds inside a page) can't stop a click on them from closing this.
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      const target = e.target as Element | null;
      if (!el || !target || el.contains(target)) return;
      // A click in a popover opened from this one (e.g. an option's menu) keeps this one open.
      const popovers = [...document.querySelectorAll('[data-atrium-popover]')];
      const inside = target.closest?.('[data-atrium-popover]');
      if (inside && popovers.indexOf(inside) > popovers.indexOf(el)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;
  if (phone) {
    // On phones: a sheet along the bottom, over a dimmed page (tapping it closes the sheet).
    return createPortal(
      <div ref={ref} data-atrium-popover="" className="fixed inset-0 z-[60] flex flex-col justify-end">
        <div className="absolute inset-0 bg-black/30" onPointerDown={onClose} />
        <div
          className={clsx('atrium-sheet relative overflow-y-auto rounded-t-2xl bg-surface pb-[max(8px,env(safe-area-inset-bottom))] shadow-pop', className)}
          style={{ width: '100%', maxWidth: '100%', minWidth: 0, maxHeight: '75dvh' }}
        >
          <div className="mx-auto my-2 h-1 w-10 rounded-full bg-line" aria-hidden />
          {children}
        </div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div
      ref={ref}
      data-atrium-popover=""
      className={clsx('shadow-pop fixed z-[60] rounded-lg bg-surface', className)}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Menu({ anchor, onClose, children, align }: { anchor: Anchor | null; onClose: () => void; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} className="min-w-[200px] p-1">
      <div onClick={onClose}>{children}</div>
    </Popover>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger,
  hint,
  checked,
}: {
  icon?: ReactNode;
  label: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  hint?: ReactNode;
  checked?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'atrium-menu-item flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-start text-sm hover:bg-hover',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      {icon && <span className={clsx('flex w-4 justify-center', !danger && 'text-muted')}>{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
      {checked && <Check size={14} className="text-accent" />}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-faint">{children}</div>;
}

// ---------- Toasts ----------

interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'error';
}
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((l) => l());

export function toast(message: string, kind: ToastItem['kind'] = 'info') {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, message, kind }];
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, 3500);
}

export function toastError(err: unknown) {
  toast(err instanceof Error ? err.message : 'Something went wrong', 'error');
}

export function Toaster() {
  const items = useSyncExternalStore(
    (cb) => (toastListeners.add(cb), () => toastListeners.delete(cb)),
    () => toasts,
  );
  return createPortal(
    <div className="atrium-toasts pointer-events-none fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'shadow-pop pointer-events-auto rounded-lg px-4 py-2.5 text-sm',
            t.kind === 'error' ? 'bg-danger text-white' : 'bg-fg text-bg',
          )}
        >
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------- Confirm dialog ----------

interface ConfirmRequest {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  /** The other button's text (default "Cancel"). */
  cancelLabel?: string;
  danger?: boolean;
  /** Checkboxes shown under the message (each starts unticked); what's ticked goes to `onChecks` on confirm. */
  checks?: { label: ReactNode; help?: ReactNode }[];
  onChecks?: (ticked: boolean[]) => void;
  resolve: (ok: boolean) => void;
}
let pendingConfirm: ConfirmRequest | null = null;
const confirmListeners = new Set<() => void>();

export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    pendingConfirm = { ...opts, resolve };
    confirmListeners.forEach((l) => l());
  });
}

/** Asks to confirm with checkboxes: the ticked boxes, or null when cancelled. */
export function confirmWithChecks(opts: Omit<ConfirmRequest, 'resolve' | 'onChecks'> & { checks: NonNullable<ConfirmRequest['checks']> }): Promise<boolean[] | null> {
  let ticked: boolean[] = opts.checks.map(() => false);
  return confirmDialog({ ...opts, onChecks: (t) => (ticked = t) } as Omit<ConfirmRequest, 'resolve'>).then((ok) => (ok ? ticked : null));
}

export function ConfirmHost() {
  const req = useSyncExternalStore(
    (cb) => (confirmListeners.add(cb), () => confirmListeners.delete(cb)),
    () => pendingConfirm,
  );
  const [ticked, setTicked] = useState<boolean[]>([]);
  useEffect(() => setTicked(req?.checks?.map(() => false) ?? []), [req]);
  const finish = (ok: boolean) => {
    if (ok) req?.onChecks?.(ticked);
    req?.resolve(ok);
    pendingConfirm = null;
    confirmListeners.forEach((l) => l());
  };
  return (
    <Dialog open={!!req} onClose={() => finish(false)} width={400}>
      {req && (
        <div className="p-5">
          <h2 className="text-[15px] font-semibold">{req.title}</h2>
          {req.message && <div className="mt-2 text-sm text-muted">{req.message}</div>}
          {req.checks && req.checks.length > 0 && (
            <div className="mt-3 space-y-2">
              {req.checks.map((c, i) => (
                <label key={i} className="flex cursor-pointer gap-2.5 rounded-lg border border-line p-2.5 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={!!ticked[i]} onChange={(e) => setTicked((t) => t.map((v, j) => (j === i ? e.target.checked : v)))} />
                  <span>
                    <span className="block">{c.label}</span>
                    {c.help && <span className="block text-xs text-muted">{c.help}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => finish(false)}>{req.cancelLabel ?? 'Cancel'}</Button>
            <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => finish(true)} autoFocus>
              {req.confirmLabel ?? 'Confirm'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
