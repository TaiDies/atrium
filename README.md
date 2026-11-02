<div align="center">

# Atrium

**Your team's open hall — on your own server.**

Documents, databases, calendar, chat, video meetings, a knowledge graph and AI in one self-hosted
workspace, with apps for Windows and Android and **no limits on people or workspaces**.

[Website](https://atrium-five-xi.vercel.app) · [Download](https://github.com/TaiDies/atrium/releases/latest) · [Install guide](docs/INSTALL.md) · [Features & how-to](docs/FEATURES.md) · [License: AGPL-3.0](LICENSE)

</div>

## Quick start

```bash
git clone https://github.com/TaiDies/atrium.git
cd atrium
cp .env.example .env          # set POSTGRES_PASSWORD
docker compose up -d --build  # then open http://localhost:3000
```

Then install the [Windows or Android app](https://github.com/TaiDies/atrium/releases/latest) and connect it
to your server, or just use it in the browser. The full guide — HTTPS, email, AI, API, meetings and every
setting — is in **[docs/INSTALL.md](docs/INSTALL.md)**; every feature is explained in
**[docs/FEATURES.md](docs/FEATURES.md)**.

## Highlights

- **Documents** — a block editor with to-dos, callouts, toggles, columns, equations, embeds, comments,
  page history, templates and live cursors.
- **Databases** — grids, boards, calendars, timelines, galleries, charts, lists, feeds and forms, with
  relations, rollups, formulas, automations and card templates.
- **Calendar & Today** — events, tasks, reminders and repeats; every dated card and to-do in one place;
  plan your day hour by hour; .ics subscriptions and imports.
- **Chat** — private chats, groups and teams with per-member rules, mentions, page links and commands.
- **Meetings** — scheduled links, invitations by notification and email, screen sharing, host controls,
  prepared tasks, a call that follows you around the app, and a kept meeting chat.
- **Graph** — every page and how it connects, with colour groups that mean something.
- **AI** — Claude, OpenAI-compatible or Gemini: an assistant that builds documents, databases and plans,
  AI on selected text, autofill columns, flashcards, quizzes and transcription.
- **Files & Office** — Word, Excel and PowerPoint editors, writing on PDFs, whiteboards and full-text
  search in files.
- **Imports** — Notion, Evernote, Trello, Word, Markdown, CSV, and pages (with files) written by any AI chat.
- **For developers** — API tokens, documented REST API, signed webhooks, and an MCP server so Claude can
  use a workspace as its memory.
- **Everywhere** — web, Windows and Android apps, offline pages, system notifications, English and Arabic
  (right-to-left), light and dark themes.

## All features in detail


- **Accounts** – email/password sign-up and sign-in (bcrypt-hashed passwords, httpOnly session cookie).
- **Workspaces** – create as many as you like, switch between them, rename, set an icon, delete.
- **Page permissions** – **Share** on any page sets what workspace members can do (can edit, can view or
  no access), with per-person overrides. Sub-pages inherit unless they have their own settings. Viewers get a
  read-only page; "no access" pages are hidden from the sidebar, search and links. Enforced on the server,
  including for live editing.
- **Members** – invite anyone by email. Invitations wait under the person's 🔔 until they **accept** or
  **decline** (people without an account see it after signing up; with email set up they're also emailed).
  The inviter is told either way. Owner/member roles: only owners add pages
  (and import or duplicate them); members edit the pages they've been given access to, and can still add
  files, events and whiteboards.
- **Documents** – a Notion-style block editor ([BlockNote](https://www.blocknotejs.org)):
  type `/` for headings, to-do lists, toggles, quotes, code blocks, tables, images, video, audio, files and more.
  Drag blocks with the handle, format text from the floating toolbar, paste images.
- **More blocks** – `/callout` (icon and colour), `/table of contents` (live links to the page's headings),
  `/breadcrumbs`, `/equation` and `/inline equation` (LaTeX, rendered with KaTeX), `/bookmark` (a link as a
  card with title, description and image), `/embed` (YouTube, Vimeo, Loom, Figma, Google Maps/Docs/Drive,
  Spotify, CodePen, Miro…), `/button` (click to add ready-made blocks — e.g. a to-do dated today — or open a
  link), `/2 columns` and `/3 columns` (side by side; stacked on phones) and `/synced block` (the same content
  in several pages: edit any copy and they all change).
- **Writing tools** – **Ctrl/⌘ + F** finds in the page (highlighting every match) and **Ctrl/⌘ + H** replaces;
  ••• → **Word count** (words, characters, blocks, reading time, and the selection). Pasting a link over
  selected text links it; pasting a video, map or document link on an empty line embeds it; pasted Markdown
  is formatted. Click a date in the text to give it a **time and a reminder** (it arrives under the 🔔).
- **Sub-pages inside pages** – new sub-pages appear as link blocks inside their parent document.
  From `/` you can add a sub-page or an inline Grid, Kanban or Calendar database; `@` mentions any page.
- **Databases: Grid, Board, Calendar, Timeline, Chart, Form builder, List, Gallery and Feed** – one set
  of data with as many views as you like (tabs). Timeline shows start/end dates as draggable bars; Chart
  draws bar, line, pie or donut charts (count, sum or average); Gallery shows cards with cover images;
  Feed shows each row's document as a post. A published **form** gets a public link anyone can fill in
  without an account — every response becomes a row.
  Property types: text, number, **status** (options grouped into to-do / in progress / complete — Today
  and the calendar use the groups to know what's done), single/multi-select, **person** (assign people;
  they're notified and see the card under **Today → Assigned to me**), date, checkbox, URL, **email**,
  **phone**, checklist, files & media, **ID** (automatic numbers with an optional prefix like `TASK-12`),
  created time, last edited, **created by**, **last edited by**, **button** (click to set properties —
  e.g. Status to Done, a date to today, add yourself — or open a link), **relation** (link cards to cards in another database — optionally two-way, so the
  other database lists what links to it), **rollup** (count, sum, average, min/max, % checked, % done, earliest/
  latest date or the values themselves, across linked cards) and **formula** (`prop("Due")`, maths, comparisons,
  `if()`, text and date functions, with a live preview). Per-view filters (match **all** or **any**, and relative dates such as *this week*, *next 7 days* or
  *last month*; person filters can say *me*), sorts, hidden properties, board grouping with optional
  **swimlanes** (rows by a second property), calendar date field, and **totals** under each grid column
  (count, sum, average, median, min/max, range, % checked, % complete, earliest/latest date…).
  Resize and reorder columns, drag rows, cards and calendar events.
- **Cards are pages** – open any row or card to edit its properties and write in a full block editor
  (with `/` commands, images and files), synced live like any other page. The expand button opens the card
  as a full page of its own (with its own link).
- **Database settings (•••)** – **Sub-items** (cards nest under a parent card in the grid; *Add sub-item*
  from a row's menu), **Dependencies** (*Blocked by* / *Blocking*; the timeline draws arrows, red when the
  dates overlap), **Lock views and properties** (cards stay editable), and **Automations**: *when a card is
  added* or *when a property changes (to a value)*, *set properties* or *notify people* (named people or a
  person property). The server runs them, so cards from forms, the AI and the API count too.
- **Linked views** – `/linked view` in a document shows one view of an existing database there, or a new
  view just for that page with its own filters and sorts.
- **Card templates** – the arrow next to a database's **New** button lists its templates: each sets the
  properties and the page content a new card starts with. Make and edit them from the same menu, and choose
  which one **New** uses.
- **Page templates** – **Templates** in the sidebar has ready-made pages (meeting notes, weekly plan, journal,
  class notes, project tracker, reading list, assignment and habit trackers, content calendar, roadmap) and
  the workspace's own: any page's ••• → **Save as template** keeps it (with the pages inside it) for everyone.
  A template can **repeat** — a new page from it every N days, weeks, months or years (e.g. a weekly meeting
  page), added at the top or inside a page you choose.
- **Comments and mentions** – select text and choose the comment button to start a thread; reply, react,
  resolve. The speech-bubble button at the top of a page lists every thread (open, resolved, all). Type `@`
  and pick a person to mention them. Mentioned people, the page's creator and others in the thread get a
  notification that opens the exact spot.
- **Publish to the web** – **Share → Publish to the web** gives a page a read-only link (`/share/…`) that
  works without an account, optionally with the pages inside it. Search engines are kept out unless you allow
  them. Comments stay private. People outside your network can only open it if the server has a public address
  (see *Serving on a domain*).
- **Real-time collaboration** – everyone on a page sees edits instantly, with live cursors and
  presence avatars. Built on Yjs CRDTs, so offline edits merge cleanly when the connection returns.
- **Page tree** – nested pages in the sidebar; drag to reorder or drop one page onto another to nest it.
  Favourites, duplicate, copy link, rename inline.
- **Import** – bring pages over from other apps (Notion, Obsidian, …): Markdown and HTML become documents,
  CSV becomes a Grid with property types detected, folders in a .zip become nested pages, and bundled
  pictures and files are uploaded. Export from the other app, then **Import** in the sidebar here.
  Also takes a **Notion** export .zip (zips inside it too, with the complete CSV of each database),
  **Evernote** notebooks (.enex), a **Trello** board's .json export (a board database with lists, labels,
  due dates, descriptions and checklists) and **Word** documents (.docx).
- **Export as PDF** – a document page's ••• menu makes a PDF on the server (LibreOffice, in the Docker
  image), pictures included; without LibreOffice the browser's print window opens instead.
- **API and webhooks** – Settings → **API & webhooks**: personal API tokens (`Authorization: Bearer af_…`,
  acting as you; the guide is at `/api/docs`), pages read and written as Markdown
  (`GET`/`POST /api/pages/{id}/markdown`), and webhooks for workspace owners: signed JSON POSTs
  (`X-Signature: sha256=…`) for page created / updated / trashed, event created / updated / deleted, task
  completed and file uploaded.
- **Pages made by an AI** – Import → *Copy instructions for an AI* (or [docs/AI-PAGE-INSTRUCTIONS.md](docs/AI-PAGE-INSTRUCTIONS.md))
  gives any AI chat (ChatGPT, Claude, Gemini…) everything it needs to write a `.json` file of pages —
  documents with dates, callouts, toggles, columns, equations, embeds and links between pages, and
  databases with typed properties, cards and views — that imports in one go.
- **Trash** – deleted pages (with their sub-pages) go to the trash and can be restored (you're asked to
  confirm first, and offered to delete the events and tasks that are only in that page).
- **Tasks in cards** – a **Tasks** property shows the tasks placed inside each card's page with how many
  are done (tick them off right there), and any status or single-select property can be set to change
  when a card's tasks are all done: you pick the option it switches to (and, optionally, the one it goes back
  to if a task is reopened).
- **Files open on top** – an attachment opens in the viewer over the page; closing it (or Back) returns to
  the page as it was. **Settings → Account → Usage** shows your storage, workspaces, people per workspace
  and AI requests against the limits the administrator set.
- **Page tools (•••)** – **Page history** (versions kept as you edit, every ~10 minutes; preview any of them
  and restore — the current version is kept too), **Lock page** (no accidental edits until unlocked),
  **Full width** and **Small text** per page, **Verify** a page for 30/90 days or with no end (a badge shows
  who verified it and when it expires), **Archive** (out of the sidebar but still in search and links; see
  Trash → Archive), and **Keep offline** (the page and the pages inside it stay downloaded on this device).
  Under the title, **backlinks** list the pages that mention or link to it.
- **Guests** – **Share → Guests** invites anyone by email to one page: they join as a *guest* who sees only
  that page and the pages inside it (view or edit) — no other pages, calendar, files, Today or AI.
- **Following and updates** – pages you make, edit or comment on are followed automatically (or use •••
  → Follow). Changes by others show under the 🔔's **Updates** tab (at most once an hour per page);
  **Mentions** collects mentions, comments and assignments. From mid-afternoon the bell also says what's
  **due tomorrow**. **Home** shows who's online right now and which page they're on.
- **Daily email** – Settings → Account → *Daily email*: each morning (at the hour you pick) what's due
  today, what's overdue, and mentions and comments waiting for you. Needs email set up in the admin panel.
- **Teamspaces** – groups of pages for some members (owners create them and choose members; owners see
  them all). Each has its own section in the sidebar; move a top-level page in from its ••• menu. The
  sidebar's ⇅ button switches between the shared order and **your own order** of top-level pages.
- **Quick switcher and search** – **Ctrl/⌘ + P** (or K) shows the pages you opened recently; type to search
  titles, page text, cards and the **text inside files** (PDFs, Word, Excel, PowerPoint, text files —
  scanned PDFs only by name). Filter by pages, databases or files, when they were edited, and *made by me*.
  **Ctrl/⌘ + /** lists every keyboard shortcut.
- **Search** – `Ctrl/⌘ + K` searches titles *and* the text inside documents and boards.
- **Colors and attachments** – `/red`, `/yellow highlight`… colour a block (or select text for the colour
  menu). Typing `/` on a to-do or list item with text and picking an image, file, table or page nests it
  *inside* that item, and checking a to-do also checks every to-do nested inside it (attachments under a
  checked item are dimmed). Every attachment has **Open** and **Download** buttons, which also work on phones;
  Open shows PDFs, images and video in the app's own viewer, so PDFs display even where the browser would
  download them (Android Chrome, "always download PDFs" settings).
- **Calendar** – a **Calendar** screen (Month, Week, Day and Agenda) with every event and task, every dated
  card from every database, and every block with a date typed in it (`/date`, `@today`, `@tomorrow`…).
  Add events and tasks that aren't on any page, or attach them to blocks (`/event`, `/task`, or "Attach to a
  block" in the event) — at the top, the end, after a block or nested under one. Drag to reschedule, drag in the
  week view to create, drag an event's edge to change its length, tick tasks off in place, filter by kind and
  database. **Subscribe** from Google Calendar, Outlook or Apple Calendar with a private `.ics` link (needs the
  server on a public address for online calendars), and **import** `.ics` files from other calendars.
- **Time blocking** – **Plan my day** on Today shows the day's hours next to the list: drag tasks onto it to
  give them a time, move and stretch the blocks, or click an empty slot to block time.
- **Repeating tasks and cards** – repeat every N days, weeks, months or years between a start and an end date.
  Choose whether it resets on each new date or as soon as it's done, which status it goes back to, whether its
  checklists are unticked, and (for cards) which date moves and which end date keeps its length. Repeats show
  on the calendar ahead of time; the server moves the date and resets the status when they come round (set `TZ`
  for your time zone).
- **Whiteboards** – a **Whiteboards** screen with every board (including ones placed in pages with
  `/whiteboard`), and endless, multiplayer canvases ([Excalidraw](https://excalidraw.com)): shapes, arrows that
  stick to shapes, freehand, text, images, frames, eraser, laser pointer, lock, grid, zen and view modes,
  library, diagrams from text, export to PNG/SVG. Everyone sees each other's cursors and selections live and can
  follow someone's view. Fonts are served by the app, so it works offline.
- **Export and import** – **Export…** on any page (with or without its sub-pages) or **Export everything** for
  a whole workspace (Settings → Workspace) makes a .zip. **Import** it in another account or workspace and
  everything comes back exactly — pages, databases, cards, attachments, handwriting, events and whiteboards, with
  links between them intact. The .zip also has each page as Markdown, each database as CSV and every attachment
  in its original format, for use in other apps.
- **Files** – a **Files** screen in the sidebar shows every document, spreadsheet, presentation, PDF, note and
  other file in the workspace (everything attached to pages and cards appears automatically) as thumbnails,
  with tabs for each kind, search, sorting, grid or list, and a **+** for a new document, spreadsheet,
  presentation or handwritten note, or an upload.
  - **Documents** (Word .docx/.doc, OpenDocument .odt, RTF, Markdown, text…): a page-view word processor —
    styles, fonts, sizes, bold/italic/underline/strike, sub/superscript, colours and highlight, alignment, line
    spacing, indents, bullet/numbered/check lists, links, images (resizable), tables (merge/split, header
    rows, resizable columns), page breaks, horizontal lines, special characters, table of contents, find and
    replace, comments with replies, word count, page size/orientation/margins, zoom and print.
  - **Spreadsheets** (Excel .xlsx/.xls, OpenDocument .ods, CSV/TSV…): a full spreadsheet — formulas, number
    formats, fonts and colours, borders, merged cells, freeze panes, sort and filter, conditional formatting,
    data validation, comments, links, images, multiple sheets, find and replace.
  - **Presentations** (PowerPoint .pptx/.ppt, OpenDocument .odp…): slides with text boxes, 21 shapes, images,
    tables, lines and arrows; move/resize/rotate with snapping guides, align and distribute, layering, layouts,
    themes, backgrounds, transitions, speaker notes, and a full-screen slideshow.
  All three are edited by everyone at once and save back into the file in its own format; **Download** offers
  every other format (including PDF), and **Original layout** shows the file exactly as Office would. Conversions
  use LibreOffice, which is included in the Docker image.
- **Notes** – PDFs and handwritten notes open in a viewer where you can write with a **pen**, **highlighter** and **eraser**
  (each with preset colours plus a **colour picker** for any colour; recently picked colours stay in the bar), add
  **typed text** (tap to place, tap to edit, drag to move) and **shapes** (line, arrow, rectangle, ellipse,
  triangle). **Shape detection**: draw a rough circle, rectangle, triangle or line and hold still — it snaps
  to a clean shape you can resize until you let go (can be switched off). **Shift** while drawing makes a
  straight line, or a square, circle or 45° line with the Shapes tool. Keys: P pen, H highlighter, S shapes,
  T text, E eraser, V/Esc read, [ ] size, Ctrl+Z/Y undo/redo. Colours, sizes, extra blank pages and a
  stylus-only mode; everything syncs live and can be downloaded baked into the PDF. Each file's
  **Settings & location** shows where it's used and moves it to any page or card — at the top, the end, after
  a block or nested under one.
- **Today** – a daily task list: calendar events marked as tasks, dated cards that have a status, and to-do
  items with a date in them, with anything overdue on top. Tick things off right there (cards get their
  "Done" status, to-dos get checked); **Finished today** shows what was done and by whom, with a bit of
  encouragement — and a celebration when everything's done. Add quick tasks for any day.
- **Notifications** – the 🔔 in the sidebar shows invitations to answer, **event reminders** (choose a reminder
  on any event: at the start, minutes, hours or days before), the day's tasks, and messages such as an
  accepted invitation or a page shared with you. Optional desktop alerts.
- **A brain for Claude (MCP)** – Settings → API & webhooks → **Connect Claude** gives Claude (Claude Code,
  Claude Desktop, or any MCP app) a workspace to use as its long-term memory, like an Obsidian vault: it can
  search, read (with links and backlinks), create, update and link notes with `[[Title]]` (a missing title
  becomes a new empty note), see what's related in the graph, and move notes to the trash. The token it gets
  is limited to that one workspace. The MCP endpoint is `/api/mcp` (Streamable HTTP, Bearer token); the
  settings show the `claude mcp add …` command and the Claude Desktop config to paste.
- **Graph** – the sidebar's **Graph** shows the workspace like Obsidian's graph view: every page a dot (bigger
  the more it's linked), lines for links and @mentions (cards included), pages inside pages, and dashed
  lines for database relations. Hover to light up a page's neighbours, click to open it, drag dots, scroll or
  pinch to zoom, search to find a page, and toggle each kind of line. A page's ••• → **Local graph** shows
  just that page and what's one to three links away.
  **Groups** give the colours meaning: name a group ("People", "Projects"…), describe it and pick a colour,
  then put pages in it (right-click a dot) or let it take pages in by title; a legend shows what each colour
  means, and hovering a group lights its pages up.
- **Chat** – private chats, **groups** (everyone equal; the owner can remove people) and **teams** (the owner
  and admins decide who may talk, use commands and start meetings). Type **@** to mention someone, **[[** to
  link a page, or **/** for commands: /page, /mention, /date, /task (in a meeting), /meet, /schedule.
- **Meetings** – schedule one (the link is ready straight away) or start one now; invitations arrive under
  the bell, and by email when the admin has set up mail. Calls have microphone, camera and **screen sharing**
  (peer to peer with WebRTC; set STUN/TURN servers in `RTC_ICE_SERVERS` as JSON — the default is a public
  STUN server, enough on one network). The host, co-hosts and workspace owners choose per person who may
  talk, use the camera, share the screen and chat. Tasks can be prepared before the meeting. Each meeting
  has its own chat, kept after it ends but read-only. In a browser the camera and microphone need HTTPS
  (the desktop and phone apps work over plain HTTP); Android's app can't share its screen.
- **Languages** – English and **Arabic (العربية)**, in Settings → Appearance → Language. Arabic turns the
  whole interface right-to-left (dates in Arabic too, and the editor's own menus); writing in a page takes
  each paragraph's own direction, so Arabic and English sit correctly side by side in any language.
- **Phones and the Android app** – a phone layout of its own: a bottom navigation bar, windows as sheets
  that slide up, menus as bottom sheets with large rows, an editing toolbar above the keyboard (add block,
  bold, italic, lists, indent, undo/redo, AI), swipe from the left edge for the sidebar, and the Android back
  button closing sheets and menus before going back. The status and navigation bars follow the app's theme.
- **AI study and data tools** (with an AI connection) – **AI autofill** database properties (a prompt fills each
  card from its properties and page), **Search my workspace** in the assistant (it answers from your pages,
  databases and files), `/ai` to write at the cursor, **Flashcards & quiz** on any page (cards made by hand or
  by AI, studied with spaced repetition on each person's schedule, plus AI multiple-choice quizzes; due cards
  show on Today), and **transcription** of audio and video attachments (OpenAI/Groq Whisper or Gemini; set
  `AI_TRANSCRIBE_MODEL` to use another speech model).
- **AI everywhere** (with an AI connection) – select text in any page or card and choose **AI** to improve,
  shorten, fix, summarise, translate or do anything you type (replace it or insert below); **Ask AI** in any
  block's ⋮⋮ menu also works on tasks (rename, reschedule, mark done) and files (summarise, notes). A small
  **Ask AI** assistant in the corner of every page reads that page. Questions are saved at once and answers
  arrive in the background, so you can leave and come back; past questions can be **edited** and re-asked.
- **AI assistant** – an **AI assistant** screen that works with your own API key from **Anthropic (Claude)**,
  **OpenAI** or any OpenAI-compatible service (OpenRouter, Groq, Mistral, DeepSeek, or local models with
  Ollama / LM Studio), or **Google Gemini**. It knows every part of the app, so it can answer "how do I…"
  questions with exact steps, and it can **build** in the workspace: documents (including sub-pages under any
  page, and text added to the end of an existing page), dated to-dos that show on Today, **databases** (board,
  list, table, calendar, timeline or gallery, with properties, cards and card notes, placed inside a document),
  and calendar events and tasks with colours, reminders and repeats, linked inside the plan page. Attach PDFs,
  Word, Excel, PowerPoint or text files, pick pages from the workspace, and let it see your calendar — e.g. ask
  for a **study plan** from your deadline, books and free time. Everything it makes is shown for review and added
  only when you click **Add**. Keys are stored encrypted on the server and never sent back to the browser.
- **Admin panel** – a separate panel on its own port (see below) to manage accounts (search, create, switch off,
  reset passwords, delete), see and delete workspaces, close sign-ups to invited people only, and give
  everyone AI through one server-wide connection — with a switch for whether people may still use their own key.
- **Themes** – 14 themes, each in light or dark: accent themes (Default, Dandelion, Lavender, Lemonade,
  Ocean, Forest, Rose, Graphite, Sunset, Mint) and full-palette ones (Nord, Sepia, Midnight, High contrast).
  Plus any custom accent colour, Sans/Serif/Mono/Rounded font, text size, page width (default, wide, full)
  and compact spacing (Settings → Appearance).
- **Reading PDFs** – the viewer's moon button shows **dark pages** (also for scanned PDFs; your handwriting
  keeps its colours, and highlighter strokes glow brighter so they stand out on the dark page), and scanned PDFs that use JPEG 2000 or JBIG2 images display properly. Clicking a file
  attachment in a page or card opens it in the app's viewer in the same tab (Back returns to the page; the
  ↗ button still opens a new tab). Attachments show as cards so they're easy to spot.
- **Your own colours** – Settings → Appearance → *Your own colours* changes any colour of the app (page
  background, sidebar, menus, cards, text, borders, accent…) separately for light and dark mode, on top of
  any theme. *Copy my colours* / *Paste colours* move them to another device or person.
- **Polish** – page icons and covers (a colour, an **uploaded picture** or an image link, which you can move
  up or down; a picture of a different shape opens a window to choose which part shows), Markdown export, and a phone-friendly layout (touch-visible controls,
  auto-closing sidebar, no zooming into fields).

## Run it with Docker

Requirements: Docker Desktop (Windows/macOS) or Docker Engine with the Compose plugin (Linux).

```bash
cd atrium
docker compose up -d --build
```

Open <http://localhost:3000>, click **Sign up**, and create the first account. That's it — every new
account gets its own workspace, and you can invite others from **Settings & members**.

Useful commands:

```bash
docker compose logs -f app     # follow the app logs
docker compose down            # stop (your data is kept in Docker volumes)
docker compose up -d --build   # rebuild after changing the code
```

### Configuration

Copy `.env.example` to `.env` to change defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_PORT` | `3000` | Port the app is published on |
| `POSTGRES_PASSWORD` | `atrium` | Database password (applies when the database is first created) |
| `SECURE_COOKIES` | `false` | Set to `true` when serving over HTTPS |
| `MAX_UPLOAD_MB` | `25` | Largest allowed file upload |
| `MAX_IMPORT_MB` | `1024` | Largest export .zip that can be imported |
| `TZ` | `UTC` | Time zone for repeating tasks (they reset at midnight here), e.g. `Europe/London` |
| `CONVERT_PARALLEL` | `2` | How many document conversions (LibreOffice) run at once |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM` | — | Email (optional). When set, people can sign in and sign up with a 6-digit code sent by email |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | With email set up: new accounts must confirm their email with a code before using the app |
| `APP_NAME` | `Workspace` | Name shown in emails and to the desktop and phone apps |
| `ADMIN_PORT` | `3001` | Port of the admin panel (published on this machine only — see below) |
| `ADMIN_PASSWORD` | — | The admin panel's password. If not set, one is made on first start, kept in `/data/admin-password.txt` until you change it in the panel |
| `ADMIN_PANEL` | `true` | Set to `false` to turn the admin panel off |

Data lives in two Docker volumes: `db` (Postgres) and `data` (uploaded files and the session secret).

### Admin panel

The admin panel runs on its own port, **<http://localhost:3001>**, and the Docker setup only opens it on the
server itself — it is never on the same port as the app. To use it from another computer, use an SSH tunnel
(`ssh -L 3001:localhost:3001 you@server`, then open <http://localhost:3001>) or a VPN, rather than opening the
port to the internet. Sign in with `ADMIN_PASSWORD`, or — if you didn't set one — with the password made on
first start. It's kept in the data volume until you change it in the panel:

```bash
docker compose exec app cat /data/admin-password.txt
```

Lost it after changing it? Set `ADMIN_PASSWORD` in `.env` and run `docker compose up -d`; that password then works.

**Limits:** the **Limits** tab sets what everyone gets — how many workspaces they can own, total storage, the largest
file, people per workspace and AI requests a day (each can be unlimited). To give some people different limits,
tick them in **Accounts** and choose **Set limits**, or open one account; "Default" follows the Limits tab. People
see their usage under Settings → My account, and get a clear message when they reach a limit.

**Email:** the **Email** tab sets up sending (any SMTP service; presets for Gmail, Outlook, Zoho, SendGrid and
Mailgun). Settings are checked by signing in to the mail server before they're saved, the password is stored
encrypted, and **Send a test email** confirms it works. It takes over from the `SMTP_*` settings in `.env`, and also
has the switch for making new accounts confirm their email.

**AI for everyone:** in the panel's **AI** tab, add a provider, model and key; everyone can then use the AI
assistant without a key of their own (requests are billed to that key). Once it's set, a switch decides whether
people may still use their own key instead. With no server connection, people always can.

### Serving on a domain

Put any reverse proxy (Caddy, Nginx, Traefik) in front of port 3000 with HTTPS, forward WebSocket
upgrades for `/collab`, and set `SECURE_COOKIES=true`. Example Caddyfile:

```
notes.example.com {
  reverse_proxy localhost:3000
}
```

## Desktop (Windows) and phone (Android) apps

`apps/native` turns the web app into installable apps with [Tauri](https://tauri.app). On first launch
they ask where your workspace lives: your own server (enter its address, e.g. `192.168.1.20:3000`), or —
later — the hosted service. They then work like the website, and **keep working offline**:

- Every page, card, whiteboard and file you've opened is kept on the device, so it opens and can be edited
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
still works but the APK (`release/Workspace-unsigned.apk`) can't be installed until it's signed.

The universal APK holds all four processor types (~120 MB); `npm run build:android -- --split-per-abi`
makes one smaller APK per type (phones use `arm64-v8a`).

## Architecture

```
browser ──HTTP /api──▶ ┌────────────────────────────┐
        ──WS /collab─▶ │ app (Node.js)              │──▶ PostgreSQL
        ◀─static SPA── │  Fastify REST API          │
                       │  Hocuspocus (Yjs sync)     │──▶ /data/uploads
                       └────────────────────────────┘
```

- `server/` – TypeScript, Fastify, Hocuspocus, `pg`. SQL migrations in `server/migrations` run on start.
- `web/` – React, Vite, Tailwind, BlockNote, TanStack Query. Built into static files served by the app.

Page structure (titles, tree, icons) is stored in regular tables; page content is a Yjs document stored
in `page_content`, alongside an extracted plain-text copy used for search.

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

The previous Rust/Next.js attempt is kept in `legacy/` for reference.
