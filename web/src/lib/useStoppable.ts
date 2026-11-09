import { useEffect, useRef } from 'react';

/**
 * A way to stop a long request (AI work): `start()` gives a signal for the next one (stopping any
 * still running), `stop()` stops it, and leaving the screen stops it too.
 */
export function useStoppable() {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  return {
    start: () => {
      ref.current?.abort();
      ref.current = new AbortController();
      return ref.current.signal;
    },
    stop: () => ref.current?.abort(),
  };
}
