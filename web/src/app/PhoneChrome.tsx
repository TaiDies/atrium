import clsx from 'clsx';
import { CalendarDays, Home, ListChecks, MessagesSquare, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useBackClose, usePhone } from '../lib/device';
import { useApp } from './context';

// The phone layout's own pieces: a bottom navigation bar (like other Android apps), swiping in from
// the left edge to open the sidebar, and the back button closing the sidebar.

/** Whether something is being typed into (the keyboard is up): the bottom bar steps aside. */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const onIn = (e: FocusEvent) => setTyping(editable(e.target));
    const onOut = () => setTimeout(() => setTyping(editable(document.activeElement)), 50);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return typing;
}

export function PhoneNav() {
  const phone = usePhone();
  const { workspace, openSearch, toggleSidebar, sidebarOpen } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const typing = useTyping();
  useBackClose(phone && sidebarOpen, toggleSidebar);

  // Swipe in from the left edge: open the sidebar; swipe it back to close it.
  useEffect(() => {
    if (!phone) return;
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = (!sidebarOpen && t.clientX < 24) || sidebarOpen ? { x: t.clientX, y: t.clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = Math.abs(t.clientY - start.y);
      if (dy < 60 && ((!sidebarOpen && dx > 60) || (sidebarOpen && dx < -60))) toggleSidebar();
      start = null;
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [phone, sidebarOpen, toggleSidebar]);

  if (!phone || typing) return null;
  const base = `/w/${workspace.id}`;
  const path = location.pathname;
  const items = [
    { label: 'Home', icon: Home, active: path === base || path === `${base}/`, go: () => navigate(base) },
    { label: 'Today', icon: ListChecks, active: path.startsWith(`${base}/today`), go: () => navigate(`${base}/today`) },
    { label: 'Chat', icon: MessagesSquare, active: path.startsWith(`${base}/chat`) || path.startsWith(`${base}/meet`), go: () => navigate(`${base}/chat`) },
    { label: 'Calendar', icon: CalendarDays, active: path.startsWith(`${base}/calendar`), go: () => navigate(`${base}/calendar`) },
    { label: 'Search', icon: Search, active: false, go: openSearch },
  ];
  return (
    <nav className="af-phone-nav flex shrink-0 border-t border-line bg-sidebar print:hidden" aria-label="Main">
      {items.map(({ label, icon: Icon, active, go }) => (
        <button
          key={label}
          onClick={go}
          className={clsx('flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px]', active ? 'text-accent' : 'text-muted')}
        >
          <span className={clsx('flex h-7 w-14 items-center justify-center rounded-full transition-colors', active && 'bg-accent/15')}>
            <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}
