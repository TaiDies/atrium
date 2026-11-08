import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { mailEnabled, sendMail } from './mail.js';
import { getSettings, setSetting, type UpdateSettings } from './settings.js';

// Keeping the server up to date. It checks the project's GitHub releases (UPDATE_REPO) now and then;
// when a newer version is out it can email someone (the admin panel's "Server notifications receiver
// email", sent through the server's own email settings) and, with auto-update on, update itself.
//
// A container can't rebuild itself, so the updating is done by the small "updater" container in
// docker-compose.yml (tools/updater.sh): it has Docker and git, and the project folder. The server
// leaves it a request in the shared data folder; the updater pulls the new version, rebuilds the app
// and writes back how it went.

export const SERVER_VERSION = '1.10.2';
export const UPDATE_REPO = process.env.UPDATE_REPO || 'TaiDies/atrium';

const dir = () => path.join(config.dataDir, 'update');

export interface Release {
  version: string;
  url: string;
  notes: string;
  publishedAt: string | null;
}

/** "1.10.0" > "1.9.2". */
export function newer(a: string, b: string) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

let lastCheck: { at: string; release: Release | null; error: string | null } | null = null;

/** The newest release on GitHub. */
async function latestRelease(): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `${config.appName}-server` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const r = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; published_at?: string };
  return { version: String(r.tag_name ?? '').replace(/^v/i, ''), url: r.html_url ?? `https://github.com/${UPDATE_REPO}/releases`, notes: r.body ?? '', publishedAt: r.published_at ?? null };
}

/** What the updater container last said (it writes this every few seconds while running). */
async function updaterState() {
  const read = async (f: string) => {
    try {
      return JSON.parse(await readFile(path.join(dir(), f), 'utf8'));
    } catch {
      return null;
    }
  };
  const beat = (await read('updater.json')) as { at?: string; canUpdate?: boolean; remote?: string } | null;
  const status = (await read('status.json')) as { state: string; message: string; at: string } | null;
  const alive = !!beat?.at && Date.now() - Date.parse(beat.at) < 3 * 60_000;
  return {
    running: alive,
    canUpdate: alive && !!beat?.canUpdate,
    reason: !alive
      ? 'Automatic updates are off. To turn them on, start the updater: docker compose --profile updater up -d'
      : beat?.canUpdate
        ? null
        : `This server's folder isn't a git clone of github.com/${UPDATE_REPO}, so it can't pull updates. Update it by hand.`,
    status,
    pending: existsSync(path.join(dir(), 'request.json')),
  };
}

/** Asks the updater to update to the newest version. */
export async function requestUpdate(version: string | null) {
  await mkdir(dir(), { recursive: true });
  await writeFile(path.join(dir(), 'request.json'), JSON.stringify({ version, at: new Date().toISOString() }));
}

/** Checks for a newer version; emails and (with auto-update) updates once per new version. */
export async function checkForUpdate() {
  let release: Release | null = null;
  try {
    release = await latestRelease();
    lastCheck = { at: new Date().toISOString(), release, error: null };
  } catch (err) {
    lastCheck = { at: new Date().toISOString(), release: null, error: (err as Error).message };
    return lastCheck;
  }
  if (!release.version || !newer(release.version, SERVER_VERSION)) return lastCheck;
  const s = (await getSettings()).updates;
  const next: UpdateSettings = { ...s };
  if (s.email && s.notifiedVersion !== release.version && (await mailEnabled())) {
    const subject = `${config.appName} ${release.version} is available`;
    const text = `A new version of ${config.appName} is out: ${release.version} (this server runs ${SERVER_VERSION}).\n\nWhat's new: ${release.url}\n\n${
      s.auto ? 'Auto-update is on, so the server is updating itself now.' : 'Update it from the admin panel (Updates → Update now), or with: git pull && docker compose up -d --build'
    }`;
    const html = `<p>A new version of ${config.appName} is out: <b>${release.version}</b> (this server runs ${SERVER_VERSION}).</p><p><a href="${release.url}">What's new</a></p><p>${
      s.auto ? 'Auto-update is on, so the server is updating itself now.' : 'Update it from the admin panel (<b>Updates → Update now</b>), or with <code>git pull &amp;&amp; docker compose up -d --build</code>.'
    }</p>`;
    try {
      await sendMail(s.email, subject, text, html);
      next.notifiedVersion = release.version;
    } catch (err) {
      console.error('Update email failed:', err);
    }
  }
  if (s.auto && s.autoUpdatedVersion !== release.version) {
    const u = await updaterState();
    if (u.canUpdate) {
      await requestUpdate(release.version);
      next.autoUpdatedVersion = release.version;
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(s)) await setSetting('updates', next);
  return lastCheck;
}

/** Everything the admin panel's Updates tab shows. */
export async function updateStatus() {
  const s = (await getSettings()).updates;
  const release = lastCheck?.release ?? null;
  return {
    current: SERVER_VERSION,
    repo: UPDATE_REPO,
    latest: release,
    available: !!release?.version && newer(release.version, SERVER_VERSION),
    checkedAt: lastCheck?.at ?? null,
    error: lastCheck?.error ?? null,
    email: s.email,
    auto: s.auto,
    mail: await mailEnabled(),
    updater: await updaterState(),
  };
}

/** Checks a minute after starting, then every 6 hours. */
export function startUpdateChecks() {
  setTimeout(() => void checkForUpdate().catch(() => {}), 60_000).unref();
  setInterval(() => void checkForUpdate().catch(() => {}), 6 * 3600_000).unref();
}
