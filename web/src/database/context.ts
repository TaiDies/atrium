import { createContext, useContext } from 'react';
import type { RelatedDb } from './computed';
import type { DatabaseActions, DatabaseState } from './model';

export interface DatabaseContextValue {
  pageId: string;
  workspaceId: string;
  db: DatabaseState;
  actions: DatabaseActions;
  readOnly: boolean;
  /** Views and properties are locked (cards can still be edited). */
  locked: boolean;
  openRow: (rowId: string | null | undefined) => void;
  /** Other databases this one's relations point at. */
  related: Map<string, RelatedDb>;
}

export const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function useDb() {
  const ctx = useContext(DatabaseContext);
  if (!ctx) throw new Error('useDb must be used inside a database view');
  return ctx;
}
