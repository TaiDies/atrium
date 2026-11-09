# Development and building the apps

## Architecture

```
browser / apps ──HTTP /api───▶ ┌──────────────────────────────┐
               ──WS /collab──▶ │ app (Node.js)                │──▶ PostgreSQL
               ──WS /live────▶ │  Fastify REST API            │
               ◀─static SPA─── │  Hocuspocus (Yjs sync)       │──▶ /data/uploads
                               │  live channel (chat, calls)  │
admin browser ──HTTP :3001───▶ │  admin panel (its own port)  │
                               └──────────────────────────────┘
```

- `server/` – TypeScript, Fastify, Hocuspocus, `pg`. SQL migrations in `server/migrations` run on start.
- `web/` – React, Vite, Tailwind, BlockNote, TanStack Query. Built into static files served by the app.
- `apps/native/` – the Windows and Android apps (Tauri), which load the same web app and talk to your server.
- `site/` – the website (see below).

Page structure (titles, tree, icons) is stored in regular tables; page content is a Yjs document stored in
`page_content`, alongside a plain-text copy used for search. `/collab` carries live editing, `/live` carries
chat messages, notifications and meeting signalling.

## Development

```bash
# 1. a database
docker run -d --name atrium-dev-pg -p 5544:5432 -e POSTGRES_USER=atrium -e POSTGRES_PASSWORD=atrium -e POSTGRES_DB=atrium postgres:16-alpine

# 2. the server (http://localhost:3100)
cd server && npm install
DATABASE_URL=postgres://atrium:atrium@localhost:5544/atrium PORT=3100 npm run dev

# 3. the web app with hot reload (http://localhost:5173, proxies to the server)
cd web && npm install && npm run dev
```

Tests, in `server/`: `npm test` (unit tests) and `npm run test:integration` (against a running dev server;
CI starts one with `TRUST_PROXY=loopback AI_TIMEOUT_MS=3000`). The integration tests also fail when a new
route is neither described in the API guide (`server/src/apiGuide.ts`) nor listed as app-only in
`server/src/openapi.ts`.

## Desktop (Windows) and phone (Android) apps

`apps/native` turns the web app into installable apps with [Tauri](https://tauri.app). On first launch
they ask for your server's address (e.g. `192.168.1.20:3000`, or `atrium.example.com`, which is tried
over HTTPS first). They then work like the website, and **keep working offline**:

- Every page, card, whiteboard and file you've opened is kept on the device (until you sign out), so it opens and can be edited
  without a connection. When the connection is back, offline edits merge with everyone else's (the
  documents are CRDTs, so edits from several people who were offline at the same time are combined
  rather than overwritten).
- Making, renaming, moving and deleting pages while offline is queued and sent in order once the server is
  reachable; anything the server refuses (e.g. the page was deleted meanwhile) is reported.
- The sidebar shows when you're offline and how many changes are waiting.

The web app gets the same offline behaviour for pages it has already loaded.

Building (on Windows, with Rust, Node.js, Visual Studio's C++ tools, and — for Android — Android Studio
with its SDK and NDK):

```bash
cd apps/native
npm install
npm run build:windows    # installer in src-tauri/target/release/bundle/nsis/
npm run build:android    # signed APK in release/Atrium.apk (see signing below)
```

For Android, set `JAVA_HOME` (Android Studio's `jbr` folder), `ANDROID_HOME` and `NDK_HOME` first, and
install the Rust targets with `rustup target add aarch64-linux-android armv7-linux-androideabi
i686-linux-android x86_64-linux-android`.

Android only installs signed apps. Put your signing key in `apps/native/signing/` (git ignores that folder) and
every `npm run build:android` signs the APK and copies it to `apps/native/release/Atrium.apk`:

- `release.jks` — the key. Make one once with
  `keytool -genkeypair -keystore release.jks -storetype PKCS12 -alias workspace -keyalg RSA -keysize 4096 -validity 10000`.
- `keystore.properties` — `storeFile=release.jks`, `storePassword=…`, `keyAlias=workspace`, `keyPassword=…`.

**Back both files up somewhere safe.** Phones only accept updates signed with the same key; if it's lost, people
have to uninstall the app (and its offline copy) before installing a newer one. Without the folder, the build
still works but the APK (`release/Atrium-unsigned.apk`) can't be installed until it's signed.

The universal APK holds all four processor types (~120 MB); `npm run build:android -- --split-per-abi`
makes one smaller APK per type (phones use `arm64-v8a`).

## Releases

There is no release workflow: each release is built on a developer machine and uploaded by hand.

1. Set the version everywhere with `node tools/set-version.mjs 1.11.7` (`server/package.json` is the source the
   server reads; CI checks they all match).
2. Build with `TAURI_SIGNING_PRIVATE_KEY` set to the updater key (`npm run build:windows`, then
   `npm run build:android`).
3. Upload the setup `.exe` as `Atrium-Windows-setup.exe`, its `.sig`, `Atrium.apk` and a `latest.json`
   (version, notes, date, and the `.exe`'s signature and address) to the GitHub release.

The Docker image (`ghcr.io/taidies/atrium`) is built by `.github/workflows/image.yml` when a version tag
is pushed.

## The website

The website is the static folder `site/` (its only build step copies INSTALL.md and FEATURES.md into it;
`marked` is vendored in `site/vendor/`, and no
fonts or scripts are loaded from other sites). On Vercel, set the project's **Root Directory** to `site`;
it is live at https://atrium-five-xi.vercel.app.

**Email signup for Atrium Cloud.** The form on the site posts to `site/api/subscribe.js`, a Vercel function
that keeps each address as one private file (`signups/<address>.json`) in the project's Vercel Blob store
(created with private access; Vercel adds `BLOB_READ_WRITE_TOKEN` to the project). Nothing is emailed yet.
To hand the list to an email service later, download it as CSV:

```bash
curl -H "Authorization: Bearer $SIGNUP_EXPORT_TOKEN" https://atrium-five-xi.vercel.app/api/signups -o signups.csv
```

`SIGNUP_EXPORT_TOKEN` is an environment variable of the Vercel project (Settings → Environment
Variables); without it the export is switched off. People ask to be removed by emailing
abodede.atrium@gmail.com (shown under the form and in the privacy note on the site); removing someone
means deleting their file in the Blob store (Storage → atrium-signups).

Limits: each IP address may sign up 5 times a day and at most 300 new signups are taken a day in all.
IP addresses are only kept as salted hashes in counter files under `ratelimit/` (never next to an email
address), and counters older than two days are deleted.

## Screenshots and videos

`docs/media/` holds the screenshots and GIFs used in the README and on the website; the videos are attached
to the v1.11.8 release instead, so clones stay small (the site uses
JPEG copies of some screenshots in `site/media/`). They show a demo workspace ("Northlight Studio", made-up people) on a
temporary server, captured from the Windows app at 1920×1080 and the Android app at 1080×2400.
