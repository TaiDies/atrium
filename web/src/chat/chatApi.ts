import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

// Chat and meeting data, as the server sends it (see server/src/routes/chat.ts and meetings.ts).

export type ChatKind = 'direct' | 'group' | 'team' | 'meeting';

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  name: string;
  lastMessageAt: string;
  unread: number;
  role: 'owner' | 'admin' | 'member';
  last: string | null;
  lastUser: string | null;
}

export interface ChatMember {
  userId: string;
  name: string;
  color: string;
  role: 'owner' | 'admin' | 'member';
  canTalk: boolean;
  canCommand: boolean;
  canMeet: boolean;
}

export interface ChatDetail {
  chat: { id: string; kind: ChatKind; name: string; workspaceId: string };
  me: { role: 'owner' | 'admin' | 'member'; canTalk: boolean; canCommand: boolean; canMeet: boolean };
  members: ChatMember[];
  meeting: { code: string; title: string; ended: boolean } | null;
  readOnly: boolean;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  userId: string | null;
  kind: 'text' | 'system';
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface MeetingPerms {
  talk: boolean;
  camera: boolean;
  screen: boolean;
  chat: boolean;
}

export interface MeetingTask {
  id: string;
  title: string;
  notes: string;
  dueAt: string | null;
  priority: 'low' | 'normal' | 'high';
  forEveryone: boolean;
  createdBy: string | null;
  /** Everyone it's for, and when they ticked their part. */
  people: { userId: string; doneAt: string | null }[];
  mine: boolean;
  myDone: boolean;
  myEventId: string | null;
  doneCount: number;
  total: number;
  done: boolean;
  canEdit: boolean;
}

export interface MeetingDetail {
  meeting: {
    id: string;
    code: string;
    workspaceId: string;
    title: string;
    description: string;
    hostId: string | null;
    hostName: string | null;
    chatId: string;
    teamChatId: string | null;
    startsAt: string | null;
    durationMin: number;
    startedAt: string | null;
    endedAt: string | null;
    defaults: MeetingPerms;
    openToWorkspace: boolean;
  };
  members: { userId: string; name: string; color: string; status: string; cohost: boolean }[];
  tasks: MeetingTask[];
  perms: Record<string, MeetingPerms>;
  canManage: boolean;
  inRoom: string[];
  iceServers: RTCIceServer[];
}

export interface MeetingSummary {
  code: string;
  title: string;
  startsAt: string | null;
  durationMin: number;
  startedAt: string | null;
  endedAt: string | null;
  hostName: string | null;
  isHost: boolean;
  status: string | null;
  people: number;
}

export const useChats = (workspaceId: string) =>
  useQuery({ queryKey: ['chats', workspaceId], queryFn: async () => (await api<{ chats: ChatSummary[] }>(`/api/workspaces/${workspaceId}/chats`)).chats });

export const useChat = (chatId: string | null | undefined) =>
  useQuery({ queryKey: ['chat', chatId], queryFn: () => api<ChatDetail>(`/api/chats/${chatId}`), enabled: !!chatId });

export const useMessages = (chatId: string | null | undefined) =>
  useQuery({ queryKey: ['chat-messages', chatId], queryFn: () => api<{ messages: ChatMessage[]; more: boolean }>(`/api/chats/${chatId}/messages`), enabled: !!chatId });

export const useMeetings = (workspaceId: string) =>
  useQuery({ queryKey: ['meetings', workspaceId], queryFn: async () => (await api<{ meetings: MeetingSummary[] }>(`/api/workspaces/${workspaceId}/meetings`)).meetings });

export const useMeeting = (code: string | null | undefined) =>
  useQuery({ queryKey: ['meeting', code], queryFn: () => api<MeetingDetail>(`/api/meetings/${code}`), enabled: !!code, retry: false });

/** A meeting's state in words. */
export function meetingState(m: { startsAt: string | null; startedAt: string | null; endedAt: string | null; durationMin: number }) {
  if (m.endedAt) return 'ended';
  if (m.startedAt) return 'live';
  return 'scheduled';
}
