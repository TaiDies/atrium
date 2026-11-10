import { ArrowUpCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, toastError } from '../components/ui';
import { nativeInfo, nativeInvoke } from '../lib/native';
import { androidCall, hasAndroidBridge } from '../lib/androidBridge';

// The Windows and Android apps look for a newer release on GitHub when they open and every few hours
// while they're open, and ask before updating. "Later" waits until the next check.
// - Windows: the update is signed, and the app checks the signature before installing it itself.
// - Android: apps installed from an APK can't update themselves silently. The app downloads the new APK,
//   checks its SHA-256 against the one GitHub lists for the release, and opens Android's installer, where
//   the person taps Install (Android only accepts it if it's signed with the same key as the installed app).

interface Update {
  version: string;
  notes: string | null;
  /** Android: the APK and its checksum. */
  apk?: { url: string; sha256: string | null };
  page?: string;
}

interface AndroidUpdater {
  canInstallUpdates(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  installUpdate(url: string, sha256: string): Promise<void>;
}

const EVERY = 4 * 60 * 60 * 1000;
/** Must match UpdateSource.REPO in the Android app, which refuses APKs from anywhere else. */
const REPO = 'TaiDies/atrium';

const androidUpdater: AndroidUpdater = {
  canInstallUpdates: () => androidCall<boolean>('canInstallUpdates'),
  openInstallSettings: () => androidCall<void>('openInstallSettings'),
  installUpdate: (url, sha256) => androidCall<void>('installUpdate', url, sha256),
};

const android = () => (hasAndroidBridge() ? androidUpdater : null);

/** Whether version a is newer than b ("1.11.9" > "1.11.8"). */
export function isNewer(a: string, b: string) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Release notes without Markdown symbols (headings, bold, code marks), for the dialog. */
export function plainNotes(md?: string | null): string | null {
  const text = (md ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return text || null;
}

async function checkAndroid(current: string): Promise<Update | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const release = (await res.json()) as { tag_name: string; body?: string; html_url: string; assets: { name: string; browser_download_url: string; digest?: string | null }[] };
  const version = release.tag_name.replace(/^v/, '');
  if (!isNewer(version, current)) return null;
  const asset = release.assets.find((a) => a.name === 'Atrium.apk');
  if (!asset) return null;
  const sha = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1] ?? null;
  return { version, notes: plainNotes(release.body), apk: { url: asset.browser_download_url, sha256: sha }, page: release.html_url };
}

export function AppUpdate() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [allowed, setAllowed] = useState(true);
  const platform = nativeInfo()?.platform;

  useEffect(() => {
    if (platform !== 'windows' && !(platform === 'android' && android())) return;
    const current = nativeInfo()?.version ?? '0';
    // Offline or GitHub unreachable: try again in two minutes (a few times), then at the next regular check.
    let retries = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const found = platform === 'windows' ? nativeInvoke<Update | null>('check_update') : checkAndroid(current);
      void found
        .then((u) => {
          retries = 0;
          if (u) setUpdate(u);
        })
        .catch(() => {
          if (retries++ < 3) retry = setTimeout(check, 2 * 60 * 1000);
        });
    };
    const first = setTimeout(check, 15_000);
    const timer = setInterval(() => {
      setSkipped(null);
      check();
    }, EVERY);
    return () => {
      clearTimeout(first);
      clearTimeout(retry);
      clearInterval(timer);
    };
  }, [platform]);

  // Android reports the download's progress and outcome here.
  useEffect(() => {
    (window as unknown as { __afUpdate?: (e: { progress?: number; error?: string; done?: boolean }) => void }).__afUpdate = (e) => {
      if (typeof e.progress === 'number') setProgress(e.progress);
      if (e.error) {
        toastError(new Error(e.error));
        setBusy(false);
        setProgress(null);
      }
      if (e.done) {
        setBusy(false);
        setProgress(null);
      }
    };
  }, []);

  // Coming back from Settings: see whether installing is allowed now.
  useEffect(() => {
    const a = android();
    if (!a || !update) return;
    const recheck = () => void a.canInstallUpdates().then(setAllowed, () => setAllowed(false));
    recheck();
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [update]);

  if (!update || skipped === update.version) return null;
  const onAndroid = platform === 'android';
  const verifiable = !onAndroid || !!update.apk?.sha256;

  const install = async () => {
    if (onAndroid) {
      const a = android();
      if (!a || !update.apk) return;
      if (!update.apk.sha256) {
        if (update.page) window.open(update.page, '_blank', 'noopener');
        return;
      }
      setBusy(true);
      setProgress(0);
      a.installUpdate(update.apk.url, update.apk.sha256).catch((err) => {
        toastError(err);
        setBusy(false);
        setProgress(null);
      });
      return;
    }
    setBusy(true);
    try {
      await nativeInvoke('install_update'); // the app closes and opens again on the new version
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={() => !busy && setSkipped(update.version)} title="Update available" width={440}>
      <div className="space-y-3 px-5 pb-5">
        <p className="flex items-start gap-2.5 text-sm">
          <ArrowUpCircle size={20} className="mt-0.5 shrink-0 text-accent" />
          <span>
            Atrium {update.version} is out (you have {nativeInfo()?.version}).{' '}
            {onAndroid
              ? verifiable
                ? 'Update now? It downloads here and Android asks you to confirm the install — nothing you’ve written is lost.'
                : 'Open the release page to download it.'
              : 'Update now? The app will close and open again — nothing you’ve written is lost.'}
          </span>
        </p>
        {onAndroid && verifiable && !allowed && (
          <div className="rounded-lg bg-hover p-3 text-sm">
            <p className="mb-2">First, let Atrium install updates: turn on <b>Allow from this source</b>, then come back.</p>
            <Button onClick={() => void android()?.openInstallSettings()}>Open settings</Button>
          </div>
        )}
        {update.notes && <p className="max-h-48 overflow-y-auto rounded-lg bg-hover p-3 text-xs whitespace-pre-wrap text-muted">{update.notes}</p>}
        {progress !== null && progress >= 0 && (
          <div className="h-1.5 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setSkipped(update.version)} disabled={busy}>
            Later
          </Button>
          <Button variant="primary" onClick={() => void install()} loading={busy} disabled={onAndroid && verifiable && !allowed}>
            {busy ? (progress !== null && progress >= 0 ? `Downloading ${progress}%` : 'Updating…') : onAndroid && !verifiable ? 'Open release page' : 'Update now'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
