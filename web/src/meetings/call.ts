import { listenLive, type LiveMessage, onLiveOpen, sendLive } from '../lib/live';
import type { MeetingPerms } from '../chat/chatApi';

// A meeting call. Everyone connects to everyone (WebRTC, peer to peer); the live channel passes along
// what they need to find each other. Each connection carries three slots, always in this order —
// microphone, camera, screen — so turning one on or off only swaps its track, without renegotiating.
// What someone may do is the server's decision: it refuses to announce things they aren't allowed to
// have on, and everyone else ignores those tracks.

export type Slot = 'mic' | 'cam' | 'screen';
const SLOTS: Slot[] = ['mic', 'cam', 'screen'];

export interface Media {
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export interface RemotePeer {
  id: string;
  userId: string;
  name: string;
  media: Media;
  streams: Partial<Record<Slot, MediaStream>>;
}

interface Conn extends RemotePeer {
  pc: RTCPeerConnection | null;
  pendingIce: RTCIceCandidateInit[];
}

export interface CallState {
  joined: boolean;
  me: string | null;
  peers: RemotePeer[];
  local: Partial<Record<Slot, MediaStream>>;
  media: Media;
  perms: Record<string, MeetingPerms>;
  ended: boolean;
  error: string | null;
}

export class Call {
  private conns = new Map<string, Conn>();
  private tracks: Partial<Record<Slot, MediaStreamTrack>> = {};
  private stopListening: () => void;
  private stopOpen: (() => void) | null = null;
  state: CallState = { joined: false, me: null, peers: [], local: {}, media: { mic: false, cam: false, screen: false }, perms: {}, ended: false, error: null };

  constructor(
    private code: string,
    private userId: string,
    private ice: RTCIceServer[],
    private onChange: (s: CallState) => void,
  ) {
    this.stopListening = listenLive((m) => void this.handle(m));
  }

  private emit() {
    this.state = { ...this.state, peers: [...this.conns.values()].map(({ pc: _pc, pendingIce: _p, ...p }) => ({ ...p, streams: { ...p.streams } })) };
    this.onChange(this.state);
  }

  join() {
    // (Re)joins whenever the live channel (re)connects.
    this.stopOpen = onLiveOpen(() => sendLive({ t: 'join', code: this.code }));
  }

  leave() {
    sendLive({ t: 'leave' });
    this.stopOpen?.();
    this.stopListening();
    for (const c of this.conns.values()) c.pc?.close();
    this.conns.clear();
    for (const t of Object.values(this.tracks)) t?.stop();
    this.tracks = {};
  }

  private makePc(conn: Conn, initiator: boolean) {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    conn.pc = pc;
    if (initiator) for (const kind of ['audio', 'video', 'video'] as const) pc.addTransceiver(kind, { direction: 'sendrecv' });
    pc.onicecandidate = (e) => {
      if (e.candidate) sendLive({ t: 'signal', to: conn.id, data: { ice: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      const i = pc.getTransceivers().findIndex((t) => t.receiver.track === e.track);
      const slot = SLOTS[i];
      if (!slot) return;
      conn.streams[slot] = new MediaStream([e.track]);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      // A connection that fails is retried by whoever started it.
      if (pc.connectionState === 'failed' && initiator) void this.call(conn);
    };
    if (initiator) this.attachTracks(pc);
    return pc;
  }

  private attachTracks(pc: RTCPeerConnection) {
    pc.getTransceivers().forEach((t, i) => {
      const slot = SLOTS[i];
      if (!slot) return;
      if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
      void t.sender.replaceTrack(this.tracks[slot] ?? null).catch(() => {});
    });
  }

  private async call(conn: Conn) {
    conn.pc?.close();
    const pc = this.makePc(conn, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendLive({ t: 'signal', to: conn.id, data: { sdp: pc.localDescription } });
  }

  private async handle(m: LiveMessage) {
    switch (m.t) {
      case 'joined': {
        this.state.joined = true;
        this.state.me = m.you as string;
        this.state.perms = m.perms as CallState['perms'];
        for (const c of this.conns.values()) c.pc?.close();
        this.conns.clear();
        for (const p of m.peers as RemotePeer[]) {
          const conn: Conn = { ...p, streams: {}, pc: null, pendingIce: [] };
          this.conns.set(p.id, conn);
          void this.call(conn);
        }
        // Back in after a drop: say again what's on.
        sendLive({ t: 'media', media: this.state.media });
        this.emit();
        break;
      }
      case 'join-failed':
        this.state.error = String(m.error ?? 'Could not join');
        this.emit();
        break;
      case 'peer-joined': {
        const p = m.peer as RemotePeer;
        this.conns.set(p.id, { ...p, streams: {}, pc: null, pendingIce: [] });
        this.emit();
        break;
      }
      case 'peer-left': {
        const c = this.conns.get(m.id as string);
        c?.pc?.close();
        this.conns.delete(m.id as string);
        this.emit();
        break;
      }
      case 'media': {
        const c = this.conns.get(m.id as string);
        if (c) {
          c.media = m.media as Media;
          this.emit();
        }
        break;
      }
      case 'perms': {
        this.state.perms = m.perms as CallState['perms'];
        const mine = this.state.perms[this.userId];
        // Something I had on isn't allowed any more: off it goes.
        if (mine) {
          if (!mine.talk && this.state.media.mic) await this.set('mic', false);
          if (!mine.camera && this.state.media.cam) await this.set('cam', false);
          if (!mine.screen && this.state.media.screen) await this.set('screen', false);
        }
        for (const p of (m.peers as RemotePeer[]) ?? []) {
          const c = this.conns.get(p.id);
          if (c) c.media = p.media;
        }
        this.emit();
        break;
      }
      case 'ended':
        this.state.ended = true;
        this.leave();
        this.emit();
        break;
      case 'signal': {
        const from = m.from as string;
        const data = m.data as { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
        let conn = this.conns.get(from);
        if (!conn) return;
        if (data.sdp?.type === 'offer') {
          conn.pc?.close();
          const pc = this.makePc(conn, false);
          await pc.setRemoteDescription(data.sdp);
          this.attachTracks(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendLive({ t: 'signal', to: from, data: { sdp: pc.localDescription } });
          for (const c of conn.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        } else if (data.sdp?.type === 'answer' && conn.pc) {
          await conn.pc.setRemoteDescription(data.sdp).catch(() => {});
          for (const c of conn.pendingIce.splice(0)) await conn.pc.addIceCandidate(c).catch(() => {});
        } else if (data.ice) {
          conn = this.conns.get(from)!;
          if (conn.pc?.remoteDescription) await conn.pc.addIceCandidate(data.ice).catch(() => {});
          else conn.pendingIce.push(data.ice);
        }
        break;
      }
    }
  }

  /** Turns the microphone, camera or screen share on or off. */
  async set(slot: Slot, on: boolean) {
    const old = this.tracks[slot];
    if (on) {
      let track: MediaStreamTrack;
      if (slot === 'screen') {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        track = s.getVideoTracks()[0];
        track.onended = () => void this.set('screen', false);
      } else {
        const s = await navigator.mediaDevices.getUserMedia(slot === 'mic' ? { audio: { echoCancellation: true, noiseSuppression: true } } : { video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
        track = s.getTracks()[0];
      }
      this.tracks[slot] = track;
      this.state.local = { ...this.state.local, [slot]: new MediaStream([track]) };
    } else {
      delete this.tracks[slot];
      const local = { ...this.state.local };
      delete local[slot];
      this.state.local = local;
    }
    old?.stop();
    const i = SLOTS.indexOf(slot);
    for (const c of this.conns.values()) {
      const t = c.pc?.getTransceivers()[i];
      if (t) await t.sender.replaceTrack(this.tracks[slot] ?? null).catch(() => {});
    }
    this.state.media = { ...this.state.media, [slot]: on };
    sendLive({ t: 'media', media: this.state.media });
    this.emit();
  }
}
