import type { WebSocket } from 'ws';

// Every open websocket (live editing on /collab and the live channel on /live), by person, so they can
// all be cut off when that person's access ends: signed out everywhere, password changed, account
// switched off, or removed from a workspace.

export interface TrackedSocket {
  ws: WebSocket;
  kind: 'collab' | 'live';
  /** Workspaces whose documents this connection has opened (live editing). */
  workspaces: Set<string>;
}

const byUser = new Map<string, Set<TrackedSocket>>();

/** Notes a new connection; returns a function to call when it closes. */
export function trackSocket(userId: string, ws: WebSocket, kind: TrackedSocket['kind']): { entry: TrackedSocket; untrack: () => void } {
  const entry: TrackedSocket = { ws, kind, workspaces: new Set() };
  const mine = byUser.get(userId) ?? new Set();
  mine.add(entry);
  byUser.set(userId, mine);
  return {
    entry,
    untrack: () => {
      mine.delete(entry);
      if (!mine.size) byUser.delete(userId);
    },
  };
}

/** A person's open live-channel sockets (for pushing messages to them). */
export function liveSockets(userId: string): WebSocket[] {
  return [...(byUser.get(userId) ?? [])].filter((s) => s.kind === 'live').map((s) => s.ws);
}

/** Ends all of a person's connections (they sign in again to reconnect). */
export function closeUserSessions(userId: string) {
  for (const s of byUser.get(userId) ?? []) s.ws.close(4401, 'Signed out');
}

/**
 * Someone left a workspace: their live editing of its documents ends, and their live channel restarts
 * (so meetings and chats they were following in it are dropped).
 */
export function closeWorkspaceSockets(userId: string, workspaceId: string) {
  for (const s of byUser.get(userId) ?? []) {
    if (s.kind === 'live' || s.workspaces.has(workspaceId)) s.ws.close(4403, 'No longer in this workspace');
  }
}
