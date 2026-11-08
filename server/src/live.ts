import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseCookieHeader, sessionToken, userFromToken, websocketOriginOk } from './auth.js';
import { meetingAccess, type MeetingPerms } from './meetingAccess.js';

// The live channel (WebSocket /live): new chat messages and changes reach people as they happen, and
// meetings use it to set up their calls — each pair of people in a meeting connects directly (WebRTC),
// and this passes along the messages they need to find each other. It also keeps who's in each
// meeting, with what they're allowed to do and what they have on (microphone, camera, screen).

interface Peer {
  id: string;
  userId: string;
  name: string;
  ws: WebSocket;
  media: { mic: boolean; cam: boolean; screen: boolean };
}

const socketsByUser = new Map<string, Set<WebSocket>>();
/** meeting id → the people in it now (by connection). */
const rooms = new Map<string, Map<string, Peer>>();

const send = (ws: WebSocket, msg: unknown) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

/** Tells these people something (every device they have open). */
export function pushTo(userIds: Iterable<string>, msg: unknown) {
  for (const id of new Set(userIds)) for (const ws of socketsByUser.get(id) ?? []) send(ws, msg);
}

function roomList(room: Map<string, Peer>) {
  return [...room.values()].map((p) => ({ id: p.id, userId: p.userId, name: p.name, media: p.media }));
}

/** Tells everyone in a meeting something. */
export function pushToRoom(meetingId: string, msg: unknown) {
  for (const p of rooms.get(meetingId)?.values() ?? []) send(p.ws, msg);
}

/** Who's in a meeting right now. */
export function inRoom(meetingId: string) {
  return [...(rooms.get(meetingId)?.values() ?? [])].map((p) => p.userId);
}

/** Permissions changed: everyone in the meeting gets the new ones, and things turned off are stopped. */
export function pushPerms(meetingId: string, perms: Record<string, MeetingPerms>) {
  const room = rooms.get(meetingId);
  if (!room) return;
  for (const p of room.values()) {
    const mine = perms[p.userId];
    if (mine) {
      if (!mine.talk) p.media.mic = false;
      if (!mine.camera) p.media.cam = false;
      if (!mine.screen) p.media.screen = false;
    }
  }
  pushToRoom(meetingId, { t: 'perms', perms, peers: roomList(room) });
}

/** The meeting has ended: everyone is told and the room is closed. */
export function closeRoom(meetingId: string) {
  pushToRoom(meetingId, { t: 'ended', meetingId });
  rooms.delete(meetingId);
}

export function attachLive(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/live') return;
    const cookie = sessionToken(parseCookieHeader(req.headers.cookie));
    const ticket = url.searchParams.get('ticket') ?? undefined;
    if (!websocketOriginOk(req.headers, !cookie)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = await (cookie ? userFromToken(cookie) : userFromToken(ticket, 'live')).catch(() => null);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const mine = socketsByUser.get(user.id) ?? new Set();
      mine.add(ws);
      socketsByUser.set(user.id, mine);
      const ping = setInterval(() => ws.ping(), 20_000);
      const peerId = randomUUID();
      let meetingId: string | null = null;

      const leave = () => {
        if (!meetingId) return;
        const room = rooms.get(meetingId);
        room?.delete(peerId);
        if (room && !room.size) rooms.delete(meetingId);
        else pushToRoom(meetingId, { t: 'peer-left', id: peerId });
        meetingId = null;
      };

      ws.on('message', async (raw) => {
        let msg: { t?: string; code?: string; to?: string; data?: unknown; media?: Partial<Peer['media']> };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'join' && typeof msg.code === 'string') {
          leave();
          const access = await meetingAccess(user.id, msg.code, { joining: true }).catch((err: Error) => ({ error: err.message }) as const);
          if ('error' in access) return send(ws, { t: 'join-failed', error: access.error });
          meetingId = access.meeting.id;
          const room = rooms.get(meetingId) ?? new Map<string, Peer>();
          rooms.set(meetingId, room);
          const me: Peer = { id: peerId, userId: user.id, name: user.name, ws, media: { mic: false, cam: false, screen: false } };
          // Everyone already there gets told; the newcomer gets the list and calls each of them.
          for (const p of room.values()) send(p.ws, { t: 'peer-joined', peer: { id: me.id, userId: me.userId, name: me.name, media: me.media } });
          room.set(peerId, me);
          send(ws, { t: 'joined', you: peerId, peers: roomList(room).filter((p) => p.id !== peerId), perms: access.perms });
        } else if (msg.t === 'signal' && meetingId && typeof msg.to === 'string') {
          const target = rooms.get(meetingId)?.get(msg.to);
          if (target) send(target.ws, { t: 'signal', from: peerId, data: msg.data });
        } else if (msg.t === 'media' && meetingId && msg.media) {
          const room = rooms.get(meetingId);
          const me = room?.get(peerId);
          if (!room || !me) return;
          // Only what this person is allowed to turn on.
          const access = await meetingAccess(user.id, meetingId, {}).catch(() => null);
          const allowed = access?.perms[user.id];
          me.media = {
            mic: !!msg.media.mic && !!allowed?.talk,
            cam: !!msg.media.cam && !!allowed?.camera,
            screen: !!msg.media.screen && !!allowed?.screen,
          };
          pushToRoom(meetingId, { t: 'media', id: peerId, media: me.media });
        } else if (msg.t === 'leave') {
          leave();
        }
      });
      ws.on('close', () => {
        clearInterval(ping);
        leave();
        mine.delete(ws);
        if (!mine.size) socketsByUser.delete(user.id);
      });
      ws.on('error', () => ws.terminate());
    });
  });
}
