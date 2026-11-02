import { ArrowUpCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, toastError } from '../components/ui';
import { nativeInfo, nativeInvoke } from '../lib/native';

// The Windows app looks for a newer release on GitHub when it opens and every few hours while it's
// open, and asks before updating. "Later" waits until the next check; the update is signed, and the
// app checks the signature before installing.

interface Update {
  version: string;
  notes: string | null;
}

const EVERY = 4 * 60 * 60 * 1000;

export function AppUpdate() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (nativeInfo()?.platform !== 'windows') return;
    const check = () =>
      void nativeInvoke<Update | null>('check_update')
        .then((u) => u && setUpdate(u))
        .catch(() => {}); // offline, or GitHub unreachable: try again next time
    const first = setTimeout(check, 15_000);
    const timer = setInterval(() => {
      setSkipped(null);
      check();
    }, EVERY);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  if (!update || skipped === update.version) return null;
  const install = async () => {
    setBusy(true);
    try {
      await nativeInvoke('install_update'); // the app closes and opens again on the new version
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={() => setSkipped(update.version)} title="Update available" width={440}>
      <div className="space-y-3 px-5 pb-5">
        <p className="flex items-start gap-2.5 text-sm">
          <ArrowUpCircle size={20} className="mt-0.5 shrink-0 text-accent" />
          <span>
            Atrium {update.version} is out (you have {nativeInfo()?.version}). Update now? The app will close and open again — nothing you've written is lost.
          </span>
        </p>
        {update.notes && <pre className="max-h-48 overflow-y-auto rounded-lg bg-hover p-3 text-xs whitespace-pre-wrap text-muted">{update.notes}</pre>}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setSkipped(update.version)} disabled={busy}>
            Later
          </Button>
          <Button variant="primary" onClick={() => void install()} loading={busy}>
            {busy ? 'Updating…' : 'Update now'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
