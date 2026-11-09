import { useEffect, useRef } from 'react';
import { collabUrl, renewTicket } from './native';
import { queryClient } from './queries';

// The live channel (/live): one connection for the whole app. New chat messages and changes arrive as
// they happen (and refresh what's on screen), and meetings use it to set up their calls.

export type LiveMessage = { t: string; [key: string]: unknown };
type Listener = (msg: LiveMessage) => void;

let socket: WebSocket | null = null;
let retry = 0;
let started = false;
/** Signed out: no reconnecting until startLive is called again. */
let stopped = false;
const listeners = new Set<Listener>();
const queue: string[] = [];
const openWaiters = new Set<() => void>();

let opened = false;

function connect() {
  socket = new WebSocket(collabUrl('/live'));
  opened = false;
  socket.onopen = () => {
    opened = true;
    retry = 0;
    for (const m of queue.splice(0)) socket!.send(m);
    for (const w of openWaiters) w();
  };
  socket.onmessage = (e) => {
    let msg: LiveMessage;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    refresh(msg);
    for (const l of listeners) l(msg);
  };
  socket.onclose = () => {
    socket = null;
    if (stopped) return;
    // Back again soon (slower each time, up to 15 s). Closed before it ever opened: in the apps that's
    // usually an expired ticket, so a fresh one is fetched first and the next try uses it.
    const delay = Math.min(15_000, 500 * 2 ** retry++);
    const again = () => setTimeout(() => !stopped && !socket && connect(), delay);
    if (opened) again();
    else void renewTicket('refused').finally(again);
  };
}

/** What a change means for the data on screen. */
function refresh(msg: LiveMessage) {
  switch (msg.t) {
    case 'message':
    case 'message-changed':
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['chat-messages', msg.chatId] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      break;
    case 'chats':
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      queryClient.invalidateQueries({ queryKey: ['chat'] });
      break;
    case 'chat-updated':
      queryClient.invalidateQueries({ queryKey: ['chat', msg.chatId] });
      break;
    case 'meetings':
      queryClient.invalidateQueries({ queryKey: ['meetings'] });
      queryClient.invalidateQueries({ queryKey: ['meeting'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      break;
    case 'meeting-tasks':
    case 'meeting-updated':
    case 'perms':
    case 'ended':
      queryClient.invalidateQueries({ queryKey: ['meeting'] });
      break;
  }
}

/** Opens the live channel (once, when signed in). */
export function startLive() {
  if (started) return;
  started = true;
  stopped = false;
  connect();
}

/** Closes the live channel and stops it reconnecting (signing out, or before another account signs in). */
export function stopLive() {
  stopped = true;
  started = false;
  queue.length = 0;
  const s = socket;
  socket = null;
  s?.close();
}

export function sendLive(msg: LiveMessage) {
  const text = JSON.stringify(msg);
  if (socket?.readyState === WebSocket.OPEN) socket.send(text);
  else queue.push(text);
}

/** Runs `fn` now if connected, and again every time the channel (re)connects. */
export function onLiveOpen(fn: () => void) {
  if (socket?.readyState === WebSocket.OPEN) fn();
  openWaiters.add(fn);
  return () => openWaiters.delete(fn);
}

/** Listens to the live channel while mounted. */
export function useLive(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (m) => ref.current(m);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Listens to the live channel until the returned function is called. */
export function listenLive(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
