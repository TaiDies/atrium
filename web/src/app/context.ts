import { createContext, useContext } from 'react';
import type { PageSummary, PageType, User, Workspace } from '../lib/api';

export type SettingsTab = 'account' | 'workspace' | 'members' | 'appearance' | 'notifications' | 'api';

export interface AppContextValue {
  user: User;
  workspace: Workspace;
  pages: PageSummary[];
  openSearch: () => void;
  openTrash: () => void;
  openImport: () => void;
  openTemplates: () => void;
  openSettings: (tab?: SettingsTab) => void;
  toggleSidebar: () => void;
  sidebarOpen: boolean;
  /** Only workspace owners add pages. */
  canCreatePages: boolean;
  newPage: (opts?: { parentId?: string | null; type?: PageType }) => Promise<void>;
  expand: (pageId: string) => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppLayout');
  return ctx;
}
