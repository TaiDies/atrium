# Installing Atrium

Atrium has two parts:

- **The server** — runs on a computer you control (a home server, a NAS, a cloud VPS…) with Docker. It
  holds everyone's pages, files, chats and meetings, and serves the web app.
- **The apps** — the web app (open the server's address in any browser), plus apps for **Windows** and
  **Android** that connect to your server.

Start with the server; then open it in a browser or install the apps.

---

## 1. Run the server (Docker)

**You need:** a computer with [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows
or macOS, Docker Engine on Linux), about 2 GB of free memory and a few GB of disk.

```bash
git clone https://github.com/TaiDies/atrium.git
cd atrium
cp .env.example .env        # on Windows: copy .env.example .env
```

Open `.env` in a text editor and set at least a database password:

```ini
POSTGRES_PASSWORD=a-long-random-password
```

Then start it:

```bash
docker compose up -d --build
```

The first build takes a few minutes. When it's done, open **http://localhost:3000** (or
`http://<the computer's IP>:3000` from another device on your network).

**First steps**

1. **Create an account** — the sign-up page appears on first visit.
2. **Your first workspace is created for you** — you're its owner; invite others from **Settings & members**.
3. **Open the admin panel** (accounts, roles, limits, AI for everyone, email, sign-ups) at
   **http://localhost:3001** — on the server itself only. Its password is printed in the log on first
   start and saved in the data volume:

   ```bash
   docker compose logs app | grep -i "admin panel password"
   ```

   Change it in the panel (or set `ADMIN_PASSWORD` in `.env`). To reach the panel from elsewhere, use an
   SSH tunnel: `ssh -L 3001:localhost:3001 you@your-server`.

   **Forgot the admin password?** Set `ADMIN_PASSWORD=a-new-password` in `.env` and run
   `docker compose up -d`: while it's set, that password is the one that works.

**Updating**

Open the admin panel → **Updates**. It shows the version you run and the newest release, and has:

- **Update now** — downloads the new version and restarts the app (a minute or two).
- **Update automatically** — installs each new release when it comes out (checked every 6 hours).
- **Server notifications receiver email** — an address that's emailed when a new version is out (uses
  the server's email settings, see below).

The installing is done by the small `updater` container in `docker-compose.yml`. It is **off unless you
start it**, because it needs the Docker socket (so it can control Docker on this machine):

```bash
docker compose --profile updater up -d
```

It only installs **published releases**: it checks out the release's tag (for example `v1.11.4`) in this
folder and rebuilds the app, never unreleased code from the main branch. It only works when the folder is
a `git clone` of this repository. Without it, update by hand to a release:

```bash
git fetch --tags
git checkout v1.11.4   # the version you want
docker compose up -d --build
```

After the updater has installed a release, this folder is **on that release's tag, not on a branch**
(git calls it "detached HEAD"), so `git pull` does nothing there. To update by hand from then on, use
`git fetch --tags && git checkout <tag>` as above (or `git checkout main && git pull` to go back to
following the main branch, which may include unreleased changes).

**Ready-made images** — every release is also published as a Docker image, so you can skip building.
Put `ATRIUM_IMAGE=ghcr.io/taidies/atrium:latest` (or a version, e.g. `:1.11.4`) in `.env`, then:

```bash
docker compose pull app
docker compose up -d --no-build
```

Use **either** the updater (which builds from this folder) **or** ready-made images, not both: the updater
would rebuild over the image you pulled.

Database changes are applied automatically when the server starts.

**Upgrading to 1.11.3:**

- **Page history is kept in full again** unless you set `HISTORY_DAYS` (1.11.0 to 1.11.2 thinned it out
  after 90 days by default). With `HISTORY_DAYS=90`, snapshots older than 90 days are removed daily and the
  newest 10 of every page and card are always kept; the admin panel's Overview says when this is on.
  `HISTORY_DAYS` must be a whole number: anything else stops the server with a message.
- **No proxy is trusted by default.** Running Caddy, nginx or a tunnel in front? Set `TRUST_PROXY` to
  its address (for example `loopback` on the same machine, or `172.16.0.0/12` for a proxy container on
  the Docker network), or everyone behind it shares one set of sign-in and sign-up limits.
- **API tokens** stop working when their owner signs out everywhere, changes their password, or loses
  the "API tokens" permission. Make new ones in Settings → API & webhooks.

**Backups** — everything lives in two Docker volumes: `db` (the database) and `data` (uploaded files,
the admin password file). For example:

```bash
docker compose exec postgres pg_dump -U atrium atrium > atrium-backup.sql
docker run --rm -v atrium_data:/data -v "$PWD":/backup alpine tar czf /backup/atrium-files.tgz -C /data .
```

(The volumes are named `atrium_db` and `atrium_data` — check with `docker volume ls`.) Users can also
export whole workspaces as a .zip from **Settings → Workspace → Export everything**.

**Restoring** a backup on a fresh install (same `.env`, nothing created in the app yet):

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U atrium atrium < atrium-backup.sql
docker run --rm -v atrium_data:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/atrium-files.tgz"
docker compose up -d
```

---

### Running a shared or hosted server

Atrium's defaults suit a server for you, your family or your company. When people you don't know sign
up on it (a public or hosted server), change these in `.env`:

- **`ALLOW_PRIVATE_URLS=false`** — otherwise anyone who can add a webhook or an AI service address can
  make the server send requests into the network it runs on. The admin panel's Overview shows a warning
  while this is on.
- **Set up email** (see *Email* below) — without it, invitations can't be confirmed, so an invitation can
  be claimed by whoever signs up first with the invited address. The admin panel warns about this too.
- **`PUBLIC_URL`** — the address people use, so links in emails point at it.
- **`TRUST_PROXY`** — set it to your reverse proxy's address (for example `loopback`), so rate limits
  see visitors' real addresses. Since 1.11.3 nothing is trusted unless you set it.
- **`SECURE_COOKIES=true`** behind HTTPS.

**Docker Desktop without a reverse proxy:** when the app's port is published straight from Docker Desktop
(Windows or Mac), Docker passes every visitor on from one private address. The server then sees everyone
as that one address, so per-address limits (sign-in attempts, sign-ups, public forms) are shared by all
visitors. Put a reverse proxy in front (see *Put it on the internet* below) and set `TRUST_PROXY` to it.
Without a proxy the limits are still shared, but nobody can fake their address (nothing is trusted by default).

## 2. Put it on the internet (HTTPS) — optional but recommended

Inside your home or office network, `http://<IP>:3000` is enough. To use Atrium from anywhere — and for
**camera and microphone in browsers**, **calendar subscriptions** from Google/Outlook and **links in
emails** — give it a domain and HTTPS with a reverse proxy. With [Caddy](https://caddyserver.com) (it
gets certificates automatically):

```caddy
atrium.example.com {
    reverse_proxy localhost:3000
}
```

Then set in `.env` and restart (`docker compose up -d`):

```ini
SECURE_COOKIES=true
```

Also set `PUBLIC_URL=https://atrium.example.com` (links in emails, and live editing only accepts
connections from this address) and `TRUST_PROXY` to the proxy (`loopback` when it runs on the same machine),
so rate limits see each visitor's address.

Nginx, Traefik or Cloudflare Tunnel work too. Whatever you use must pass the original `Host` header and
**WebSockets** (live editing at `/collab`, chat and calls at `/live`). With nginx:

```nginx
server {
    listen 443 ssl;
    server_name atrium.example.com;
    # ssl_certificate … ssl_certificate_key …
    client_max_body_size 1100m;          # a bit more than MAX_IMPORT_MB
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
```

**Cloudflare** (proxy or Tunnel) ends any request after about 100 seconds. AI answers that can take
longer run in the background, and the rest stop at `AI_TIMEOUT_MS` (90 seconds), so keep that below the
limit. Cloudflare's free plan also limits uploads to 100 MB, which caps imports.

---

## 3. Install the apps

Download them from the [latest release](https://github.com/TaiDies/atrium/releases/latest).

### Windows

1. Download **Atrium-Windows-setup.exe** and run it. If Windows SmartScreen says it doesn't recognise
   the app, click **More info → Run anyway** (the installer isn't signed with a paid certificate).
2. It installs for your user only (no admin rights needed) and adds Atrium to the Start menu.
3. On first launch, choose **Connect to your own server** and type its address, e.g.
   `192.168.1.20:3000` or `atrium.example.com`. Then sign in.
4. The app keeps itself up to date: when it opens and every few hours it checks the latest release here
   and asks **Update now / Later**. Updates are signed, and the app checks the signature before installing.

### Android

1. Download **Atrium.apk** on the phone (or copy it over).
2. Open it. Android asks to allow installing apps from this source (your browser or file manager) —
   allow it, then **Install**. (Android 7 or newer.)
3. On first launch, enter your server's address and sign in. The phone must be able to reach the
   server — the same Wi-Fi network, a VPN such as Tailscale, or a public HTTPS address.
4. Allow notifications (Settings → Notifications in the app) and camera/microphone when asked in a
   meeting.

### Web and other devices

Any modern browser works: open the server's address. On phones the web app switches to a phone layout.
iPhone and macOS/Linux users can use the web app in the browser (bookmark it).

---

## 4. Configure

Settings go in `.env` (then `docker compose up -d` to apply), or in the **admin panel** where noted.

### Email (sign-in codes, invitations, meeting invites, daily summaries)

Admin panel → **Email**: SMTP server, port, user, password, sender — with **Send a test**. Or in `.env`:

```ini
SMTP_HOST=smtp.example.com
SMTP_PORT=587            # 465 with SMTP_SECURE=true
SMTP_USER=you@example.com
SMTP_PASSWORD=app-password
SMTP_SECURE=false
MAIL_FROM=Atrium <you@example.com>
REQUIRE_EMAIL_VERIFICATION=false   # true: new accounts confirm their email with a code
```

Without email, everything works except emailed codes, email invitations and daily summaries (people
still see invitations under the 🔔 bell).

### AI

Atrium works with **Anthropic (Claude)**, **OpenAI or any OpenAI-compatible server** (including local
ones like Ollama or LM Studio — set the base address) and **Google Gemini**.

- **For everyone:** admin panel → **AI**: provider, model, API key (and base address for compatible
  servers); choose whether people may use their own key instead. Set AI limits (requests and tokens, per day and per month) under
  **Limits** — for everyone, per role or per person.
- **Just for yourself:** in the app, open **AI assistant** → **AI settings** (the sliders button at the top) → pick a provider, paste
  your key, choose a model.

AI powers the assistant (which can build documents, databases and calendar tasks), writing and editing
selected text, AI autofill columns, "Search my workspace", flashcards and quizzes, and audio/video
transcription (needs OpenAI, Groq or Gemini; `AI_TRANSCRIBE_MODEL` picks the model).

### API, webhooks and Claude (MCP)

- **API tokens:** Settings → **API & webhooks** → New token (optionally limited to one workspace, with
  an expiry). Use `Authorization: Bearer atr_…` (tokens made before 1.9.0 start with `af_` and still work). The reference is at `https://your-server/api/docs`; a
  guide to the whole app for programs and AI assistants is at `/api/guide`.
- **Webhooks** (workspace owners): an address that receives signed JSON when pages, events, tasks or
  files change.
- **Connect Claude:** Settings → API & webhooks → **Connect Claude** makes a token limited to one
  workspace and shows the setup for Claude Code and Claude Desktop — Claude then uses that workspace as
  its long-term memory (MCP endpoint `/api/mcp`).

### Meetings (calls)

Calls connect people directly (WebRTC). On one network they work as they are. Across the internet,
some networks need a **TURN** relay — run one (e.g. [coturn](https://github.com/coturn/coturn)) or use a
hosted one, and set:

```ini
RTC_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"atrium","credential":"secret"}]
```

Browsers need HTTPS for the camera and microphone (the Windows and Android apps don't).

### Everything else in `.env`

| Setting | Default | What it does |
|---|---|---|
| `APP_PORT` | `3000` | Port the app is published on |
| `POSTGRES_PASSWORD` | — | Database password (set before the first start) |
| `SECURE_COOKIES` | `false` | `true` when served over HTTPS |
| `TRUST_PROXY` | none | Which proxies may pass on the visitor's real address (for rate limits). Empty or `false` trusts none (the default since 1.11.3); `loopback` trusts a proxy on the same machine; a list like `203.0.113.7,172.16.0.0/12` trusts those; `true` trusts any, so use it only when every request goes through a proxy you run |
| `APP_NAME` | `Atrium` | The name shown on sign-in, in emails and in the apps |
| `MAX_UPLOAD_MB` | `25` | Largest upload |
| `MAX_IMPORT_MB` | `1024` | Largest export .zip that can be imported |
| `IMPORT_PARALLEL` | `2` | Imports that may run at once on the whole server (each person can run one at a time) |
| `TZ` | `UTC` | Time zone for "today" (repeating tasks reset at midnight here) |
| `CONVERT_PARALLEL` | `2` | Document conversions (Office/PDF) at once |
| `ADMIN_PORT` | `3001` | Admin panel port (only on the server itself) |
| `ADMIN_PASSWORD` | generated | Admin panel password |
| `ADMIN_PANEL` | `true` | `false` turns the admin panel off |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` |
| `HISTORY_DAYS` | `0` (keep all) | Thin out page history older than this many days (the newest 10 of each page are always kept). A whole number |
| `AI_TIMEOUT_MS` | `90000` | How long one AI answer may take while a request waits for it. Keep it under your reverse proxy's limit (Cloudflare: 100 seconds); longer AI work runs in the background |
| `ALLOW_PRIVATE_URLS` | `true` | Whether webhooks and AI addresses may point at the local network. **Set `false` on a shared or hosted server** |
| `PUBLIC_URL` | — | The address people use (e.g. `https://atrium.example.com`), for links in emails and checking where live editing connects from |
| `RTC_ICE_SERVERS` | public STUN | Meeting connection servers (see above) |
| `AI_TRANSCRIBE_MODEL` | `whisper-1` | Speech-to-text model for OpenAI-compatible services (Groq: `whisper-large-v3-turbo`) |
| `CONVERT_TIMEOUT_MS` | `180000` | How long one document conversion (Office/PDF) may take |
| `JWT_SECRET` | generated | Signs sign-in sessions; made on first start and kept in the data volume. Changing it signs everyone out |
| `MAIL_TRANSPORT` | — | `log` writes emails to the server log instead of sending them (for testing) |
| `UPDATE_REPO` | `TaiDies/atrium` | Where new versions are looked for (GitHub owner/repo) |
| `ADMIN_HOST` | `0.0.0.0` | Address the admin panel listens on. Docker only publishes it on this machine; outside Docker set `127.0.0.1` |

In the admin panel: **Accounts** (everyone's accounts, their roles, usage and AI, delete accounts), **Roles** (permissions —
use AI, create workspaces, invite people, upload files, start meetings, create groups and teams, publish pages, API tokens —
and optional limits, given to people; everyone has the **Everyone** role), **Workspaces**, **Limits**
(storage, workspaces, members, AI requests and AI tokens, each a day and a month — for everyone, per role or per account), **Sign-ups & security**
(open or closed sign-ups, email verification).

---

## 5. Build the apps yourself (optional)

Needs Node.js 24, Rust, and for Android the Android SDK/NDK and Java 17. More detail (signing, the
updater key, how releases are made) is in [DEVELOPMENT.md](DEVELOPMENT.md).

```bash
cd apps/native
npm install
npm run build:windows     # installer in src-tauri/target/release/bundle/nsis/
npm run build:android     # APK in release/Atrium.apk
```

Android only installs signed APKs: put your key in `apps/native/signing/` (`release.jks` and
`keystore.properties` with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`) — it is never
committed.

The Windows app's self-update checks `https://github.com/TaiDies/atrium/releases/latest/download/latest.json`
and only installs updates signed with the matching key. If you publish your own builds, make a key with
`npx tauri signer generate -w signing/updater.key`, put the public key and your own release address under
`plugins.updater` in `src-tauri/tauri.conf.json`, and build with `TAURI_SIGNING_PRIVATE_KEY` set to the
private key; upload `latest.json`, the setup `.exe` and its `.sig` with each release. There is no release
workflow: release files are built and uploaded by hand (the Docker image is built by `image.yml`).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| The page doesn't load | `docker compose ps` — both containers should be running; `docker compose logs app` shows errors. |
| The app says it can't reach the server | Check the address and port, that the device is on the same network (or VPN), and that a firewall allows port 3000. |
| Signed out after every reload over HTTPS | Set `SECURE_COOKIES=true`. Over plain HTTP, keep it `false`. |
| Camera/microphone blocked in the browser | Use HTTPS (section 2), or the Windows/Android app. |
| Calls connect on Wi-Fi but not across the internet | Add a TURN server to `RTC_ICE_SERVERS`. |
| No emails arrive | Admin panel → Email → **Send a test** shows the SMTP error. |
| "Live editing" or chat doesn't update behind a proxy | The proxy must forward WebSockets for `/collab` and `/live`. |
