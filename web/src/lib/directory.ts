import { useSyncExternalStore } from 'react';
import type { PageSummary, User, Member } from './api';

/**
 * The current workspace's pages, user and navigation, readable from anywhere —
 * including custom editor blocks that BlockNote renders outside the normal tree.
 */
export interface Directory {
  workspaceId: string;
  user: User;
  /** Owners can add pages; other members only edit the pages shared with them. */
  canCreatePages: boolean;
  pages: PageSummary[];
  /** Workspace members, for @mentioning people. */
  members: Member[];
  navigate: (to: string) => void;
  /** Set on a page published to the web: content is read through its link. */
  public?: { token: string };
}

let current: Directory | null = null;
const listeners = new Set<() => void>();

export function setDirectory(next: Directory) {
  current = next;
  listeners.forEach((l) => l());
}

export function getDirectory() {
  return current;
}

export function useDirectory(): Directory | null {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => current,
  );
}
