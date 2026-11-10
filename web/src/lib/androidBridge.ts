// The Android app's privileged channel (saving files, printing, installing updates). Android only gives
// it to the app's own top-level page (see MainActivity: addWebMessageListener with the app's origin), so
// pages in embedded frames can't use it. Calls are messages; each gets one reply with its result.

interface Channel {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
}

const channel = () => (window as unknown as { AfAndroidSecure?: Channel }).AfAndroidSecure ?? null;

/** Whether the Android app's privileged channel is here (the Android app, on its own page). */
export const hasAndroidBridge = () => channel() !== null;

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let listening = false;
let next = 0;

/** Calls a method in the Android app and waits for its result. */
export function androidCall<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const c = channel();
  if (!c) return Promise.reject(new Error('Not available here'));
  if (!listening) {
    listening = true;
    // A listener rather than onmessage, so nothing else on the page can replace it.
    c.addEventListener('message', (event) => {
      let msg: { id?: string; result?: unknown; error?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const p = msg.id ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
  }
  const id = String(++next);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    c.postMessage(JSON.stringify({ id, method, args }));
  });
}
