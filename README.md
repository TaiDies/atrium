<div align="center">

<img src="web/public/logo.svg" alt="Atrium logo" width="96" />

# Atrium

**Your team's open hall — on your own server.**

Documents, databases, calendar, chat, video meetings, a knowledge graph and AI in one self-hosted
workspace, with apps for Windows and Android. No per-seat fees, and no built-in caps unless you set them.

[Website](https://atrium-five-xi.vercel.app) · [Download](https://github.com/TaiDies/atrium/releases/latest) · [Install guide](docs/INSTALL.md) · [Features & how-to](docs/FEATURES.md) · [License: AGPL-3.0](LICENSE)

</div>

## Quick start

```bash
git clone https://github.com/TaiDies/atrium.git
cd atrium
cp .env.example .env          # change POSTGRES_PASSWORD
docker compose up -d --build  # then open http://localhost:3000
```

Make the first account (a first workspace is created for you). Then install the
[Windows or Android app](https://github.com/TaiDies/atrium/releases/latest) and connect it to your server,
or just use it in the browser.

Putting it on the internet? Read **[Running a shared or hosted server](docs/INSTALL.md#running-a-shared-or-hosted-server)**
first: set `PUBLIC_URL`, put HTTPS in front, set `TRUST_PROXY` and `SECURE_COOKIES`, and set up email.

## Highlights

- **Documents** — a block editor with to-dos, callouts, toggles, columns, equations, embeds, comments,
  page history, templates and live cursors.
- **Databases** — grids, boards, calendars, timelines, galleries, charts, lists, feeds and forms, with
  relations, rollups, formulas, automations and card templates.
- **Calendar & Today** — events, tasks, reminders and repeats; every dated card and to-do in one place;
  plan your day hour by hour; .ics subscriptions and imports.
- **Chat & meetings** — private chats, groups and teams; scheduled calls with screen sharing and host controls.
- **Graph** — every page and how it connects, with colour groups that mean something.
- **AI** — bring your own key (Claude, OpenAI-compatible, Gemini) or a local model: an assistant that builds
  documents, databases and plans, AI on selected text, autofill columns, flashcards, quizzes and transcription.
- **Files & Office** — editors for documents, spreadsheets and presentations, writing on PDFs, whiteboards
  and full-text search in files.
- **Imports** — Notion, Evernote, Trello, Word, Markdown, CSV, and pages (with files) written by any AI chat.
- **For developers** — API tokens, a REST API (guide at `/api/docs` on your server), signed webhooks, and an
  MCP server so Claude can use a workspace as its memory.
- **Everywhere** — web, Windows and Android apps; pages you've opened work offline; system notifications;
  English, Spanish, French and Arabic (right-to-left); light and dark themes; one-click updates.

Every feature is explained in **[docs/FEATURES.md](docs/FEATURES.md)**; installing, every setting, backups
and upgrades are in **[docs/INSTALL.md](docs/INSTALL.md)**.

## Status

Atrium is young and built by a very small team. It suits small and medium teams, families, classes and
personal knowledge bases on one server. It isn't designed yet for very large databases (each is one live
document) or big video calls (calls connect people directly, which suits a handful). It has had several
internal security passes but **no independent audit**; see [SECURITY.md](SECURITY.md). Backups are your job
when self-hosting: the `db` and `data` Docker volumes hold everything.

There is no hosted version yet. If there is enough interest, a hosted subscription may come later; self-hosting
will stay free and fully featured.

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

Tests: `npm test` (unit) and `npm run test:integration` (against a running dev server) in `server/`.
Building the Windows and Android apps, signing and releases: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

Bug reports, translations and pull requests are welcome. Atrium is licensed under the [AGPL-3.0](LICENSE):
you can use and change it freely; if you offer a modified version as a service, you share your changes.
