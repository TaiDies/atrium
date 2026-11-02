import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { viewerUrl } from './api';

/**
 * Opens an uploaded file in the app's viewer on top of the current page (as `?file=` on the page's own
 * address), so closing it — or pressing Back — returns to the page exactly as it was, without reloading
 * it. Ctrl/Cmd opens it in a new tab; links that aren't uploaded files open as usual.
 */
export function useOpenFile() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (url: string, name?: string, newTab = false) => {
      const to = viewerUrl(url, name);
      const m = /^\/file\/([0-9a-f-]{36})/i.exec(to);
      if (newTab) return void window.open(to, '_blank', 'noopener');
      if (!m) return void (to.startsWith('/') ? navigate(to) : window.open(to, '_blank', 'noopener'));
      // Outside a workspace (no page underneath) the viewer opens on its own.
      if (!location.pathname.startsWith('/w/')) return void navigate(to);
      const search = new URLSearchParams(location.search);
      search.set('file', m[1]);
      if (name) search.set('fname', name);
      else search.delete('fname');
      navigate({ pathname: location.pathname, search: `?${search}`, hash: location.hash });
    },
    [navigate, location],
  );
}
