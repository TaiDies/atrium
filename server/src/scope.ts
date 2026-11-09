import { AsyncLocalStorage } from 'node:async_hooks';

// A request made with an API token limited to one workspace: everything it does is held to that
// workspace (other workspaces look as if they don't exist).

const store = new AsyncLocalStorage<{ workspaceId: string | null }>();

/** Wraps each request (from its very start) so the token's limit can be noted and read anywhere in it. */
export function runRequest(done: () => void) {
  store.run({ workspaceId: null }, done);
}

/**
 * Runs the rest of the request (`done`) with the token's limit in force. Called once the token is
 * known, after the body has been read: reading the body can leave the context opened in onRequest,
 * so the limit is set again here rather than only noted in it.
 */
export function runWithScope(workspaceId: string | null, done: () => void) {
  store.run({ workspaceId }, done);
}

/** The one workspace this request may touch, if its token is limited to one. */
export const tokenWorkspace = () => store.getStore()?.workspaceId ?? null;
