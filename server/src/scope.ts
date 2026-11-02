import { AsyncLocalStorage } from 'node:async_hooks';

// A request made with an API token limited to one workspace: everything it does is held to that
// workspace (other workspaces look as if they don't exist).

const store = new AsyncLocalStorage<{ workspaceId: string | null }>();

/** Wraps each request (from its very start) so the token's limit can be noted and read anywhere in it. */
export function runRequest(done: () => void) {
  store.run({ workspaceId: null }, done);
}

/** Called once the token is known. */
export function setTokenScope(workspaceId: string | null) {
  const current = store.getStore();
  if (current) current.workspaceId = workspaceId;
}

/** The one workspace this request may touch, if its token is limited to one. */
export const tokenWorkspace = () => store.getStore()?.workspaceId ?? null;
