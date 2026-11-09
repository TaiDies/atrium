import { api, stopAiRequests, type User } from './api';
import { stopLive } from './live';
import { isNativeApp, loadNative } from './native';
import { clearLocalData, flush, isOnline } from './offline';
import { keys, queryClient } from './queries';

/**
 * Signs out on this device (or everywhere): the live channel closes, changes still waiting are sent if
 * the server can be reached, then everything kept on the device for this person is removed. In the
 * apps the session is forgotten even when the server can't be reached.
 */
export async function signOut(everywhere = false, leave?: () => void) {
  const me = queryClient.getQueryData<User | null>(keys.me);
  stopLive();
  stopAiRequests();
  if (isOnline()) await flush().catch(() => {});
  let ok = true;
  await api('/api/auth/logout', { method: 'POST', body: everywhere ? { everywhere: true } : undefined }).catch(() => (ok = false));
  if (!ok && isNativeApp()) await fetch('/__app/session', { method: 'DELETE' }).catch(() => {});
  await loadNative();
  queryClient.setQueryData(keys.me, null);
  // Off the pages first, so their local copies are closed and can be deleted.
  leave?.();
  await new Promise((r) => setTimeout(r, 300));
  await clearLocalData(me?.id);
  queryClient.clear();
  queryClient.setQueryData(keys.me, null);
}
