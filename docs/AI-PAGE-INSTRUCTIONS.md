# Instructions for AI assistants: make pages I can import

Copy everything below into a chat with any AI assistant (ChatGPT, Claude, Gemini, Copilot…), then say
what you want, for example: *"Make me a revision plan for my biology exam on 1 December, with a board of
topics, a weekly checklist, and my two attached PDFs."*

**Importing the answer:** save the AI's reply as a file ending in **`.json`** (for example `pages.json`),
then in the app: **Import** (sidebar or Home) → drop the file → **Import**.
**If the pages use files** (pictures, PDFs, documents, audio, video): put the `.json` and those files in
**one folder**, zip the folder (or select the `.json` and the files together in the Import window), and
import that. The AI will tell you which files are needed.

---

## Your task (for the AI)

You are creating pages for a notes-and-databases app (similar to Notion). You reply with **one JSON
document** in the format described here. The person saves it as a `.json` file and imports it.

Rules for your answer:

1. Output **only the JSON** — start with `{`, end with `}`, no text or code fences before or after it.
   (If your chat can only show code in a code block, put the JSON alone in one ```` ```json ```` block
   and nothing else.)
2. It must be **valid JSON**: double quotes, no comments, no trailing commas. Inside strings write line
   breaks as `\n`, double quotes as `\"`, and backslashes as `\\` (so LaTeX `\frac` is written `\\frac`).
3. Use the person's language for titles and content.
4. **Never invent files.** Only use file names the person gave you (see **Files**). Never put file
   contents (base64, data URLs) in the JSON — files travel next to it, by name.
5. If you use any files, list them **inside** the JSON (the reply can't have text outside it): the first
   page starts with a short line such as `> [!NOTE] Import this together with: report.pdf, photo1.jpg`.

The file describes a set of **pages**. A page is a **document** (rich text written in Markdown) or a
**database** (cards with typed properties, shown as a table, board, calendar, timeline, list, gallery,
chart or feed). Pages can sit inside each other and link to each other.

---

## The file

```json
{
  "format": "workspace-pages",
  "version": 1,
  "pages": [ { ...page... }, { ...page... } ]
}
```

`"format": "workspace-pages"` is required exactly as written. `pages` is a list; put every page's
parent **before** the page itself.

### A page

| Field | Required | What it is |
|---|---|---|
| `key` | yes | A short unique id you make up: `"plan"`, `"tasks-2026"`. Letters, digits, `-`, `_`. Used for nesting, links and relations. |
| `title` | yes | The page title. |
| `parent` | no | The `key` of the page this one sits inside. Leave out (or `null`) for a top-level page. |
| `icon` | no | **One emoji**, e.g. `"📚"`. (Not a picture file.) |
| `cover` | no | A banner at the top: a preset — `sunset`, `ocean`, `aurora`, `forest`, `peach`, `lavender`, `night`, `citrus`, `mint`, `slate` — or a picture's web address (`https://…`), or **a picture file that comes with the import** (`"cover": "banner.jpg"`). |
| `type` | no | `"document"` (the default) or a database layout: `"grid"` (table), `"board"` (kanban), `"calendar"`, `"timeline"`, `"list"`, `"gallery"`, `"chart"`, `"feed"`. |
| `markdown` | documents | The page's content (see **Writing documents**). |
| `properties` | databases | The database's columns (see **Databases**). |
| `cards` | databases | The rows/cards. |
| `views` | databases | Optional: tabs showing the cards in different ways. |
| `titleProperty` | databases | Optional: the name of the title column (default `"Name"`). |

Sub-pages of a document are linked at the bottom of that document automatically, and appear under it in
the sidebar. A database can instead be shown **inside** its parent document as a live table/board (see
`[[database:key]]`).

---

## Writing documents (`markdown`)

Normal Markdown works:

- Headings `# Heading 1`, `## Heading 2`, `### Heading 3`
- **Bold** `**text**`, *italic* `*text*`, ~~strike~~ `~~text~~`, inline code `` `code` ``,
  links `[text](https://…)`
- Bulleted lists `- item`, numbered lists `1. item`, nested lists (indent 2–4 spaces)
- **To-dos** `- [ ] not done`, `- [x] done` (nested to-dos under a to-do work too)
- Quotes `> text`, dividers `---`
- Code blocks with three backticks and a language (` ```python `)
- Tables (`| a | b |` with a `|---|---|` line under the header)
- Pictures `![description](…)` — a web address **or a picture file that comes with the import**

### Extras this app understands

Each goes **on its own line**, except where it says *inline*.

| What | How to write it |
|---|---|
| **Date** (*inline*) — a date chip. **To-dos with a date appear on the person's Today list and on the Calendar** | `@2026-12-01`, with a time `@2026-12-01 14:30`, or `@today`, `@tomorrow`, `@yesterday` |
| **Link to another page in this file** (*inline*) | `[[key]]` (or `[[page:key]]`) — shows as a live link with the page's title |
| **Database shown inside this page** | `[[database:key]]` — the database's `parent` should be this page |
| **Callout** (coloured box with an icon) | `> [!NOTE] text`, `> [!TIP] text`, `> [!IMPORTANT] text`, `> [!WARNING] text`, `> [!CAUTION] text`; more lines can follow as `> …` |
| **Callout with your own icon and colour** | `::: callout 📌 yellow` … lines … `:::` — colours `gray`, `blue`, `green`, `yellow`, `red`, `purple` |
| **Toggle** (click to show/hide) | `::: toggle Title` … hidden content … `:::` (or `<details><summary>Title</summary> … </details>`) |
| **Columns** (2–4 side by side) | `::: columns`, then `::: column` before each column's content, and one `:::` at the end |
| **Equation** (displayed, LaTeX) | `$$ E = mc^2 $$` on one line, or `$$` / lines of LaTeX / `$$` |
| **Inline equation** (*inline*) | `$a^2 + b^2 = c^2$` |
| **Table of contents** (live links to the headings) | `[TOC]` |
| **Breadcrumbs** (where the page sits) | `[BREADCRUMBS]` |
| **Embedded video / map / document from the web** | `[embed](https://www.youtube.com/watch?v=…)` — YouTube, Vimeo, Loom, Figma, Google Maps, Google Docs/Sheets/Slides/Drive, Spotify, CodePen, Miro |
| **Bookmark** (a web link shown as a card) | `[bookmark](https://…)` |
| **Button** that adds content when clicked | `::: button Button text` … Markdown to add (e.g. `- [ ] Practice @today`) … `:::` |
| **A file in the page** (download/preview; PDFs, Word, Excel, PowerPoint open in the app's viewers and editors) | `[file](report.pdf)` or with a shown name `[file: Q3 report](report.pdf)`; `[pdf](notes.pdf)` is the same |
| **A picture** (as a block, with a caption) | `![caption](photo.jpg)` or `[image: caption](photo.jpg)` |
| **A video file** (plays in the page) | `[video](lecture.mp4)` or `[video: Lecture 1](lecture.mp4)` |
| **An audio file** (plays in the page; can be transcribed in the app) | `[audio](interview.mp3)` |

Containers (`::: …` … `:::`) can be nested — a toggle inside a column, a callout inside a toggle.

---

## Files

Files are how pictures, PDFs, slides, spreadsheets, recordings and other attachments get into the
pages. The JSON only **names** them; the files themselves travel next to the JSON.

**Where file names can be used**

| Place | Example |
|---|---|
| A picture in a document | `![The cell](cell-diagram.png)` |
| A file, video or audio block in a document | `[file: Syllabus](syllabus.pdf)`, `[video](week1.mp4)`, `[audio](notes.m4a)` |
| A card's own page (`_content`) | same as documents |
| A **files** property of a database (see below) | `"Attachments": ["cv.pdf", "portfolio.pdf"]` |
| A gallery's card pictures | a **files** property holding pictures, chosen as the gallery view's `"cover"` |
| A page cover | `"cover": "banner.jpg"` |

**How names are matched:** first as a path from the `.json`'s folder (`"files/week1/slides.pdf"`), then
anywhere in the import by the file's name alone (`"slides.pdf"`). Use names exactly as the person gave
them (same spelling, capital letters and extension). Names with spaces work; inside Markdown links write
them as `<My file.pdf>` — e.g. `[file](<Lab report 2.pdf>)` — or replace spaces with `%20`.

**Any kind of file works**: pictures (png, jpg, gif, webp, svg, avif), PDF, Word (doc, docx, odt, rtf),
Excel (xls, xlsx, ods, csv), PowerPoint (ppt, pptx, odp), text and Markdown, audio (mp3, wav, m4a,
ogg), video (mp4, webm, mov), zip and others. Web addresses (`https://…`) can be used instead of a
file name anywhere a file goes; those aren't downloaded, just linked.

**When the person gives you files** (attached to the chat or listed by name):

- Use each file where it belongs: attach the PDF to the page about it, put pictures where they explain
  something, list recordings in the right lesson. You may also **read** the files and write summaries,
  notes, flashcard-style questions or tasks from their content into the pages — that's often the most
  useful part. Keep the original attached as well.
- Refer to every file by its **exact** file name. If the person describes files without names, ask for
  the names, or use placeholders they can rename to (and say so in the NOTE callout).
- Many files of one kind (papers, receipts, photos, lecture slides) fit well in a **database** with a
  files property — one card per file, with properties such as Topic, Date, Status — shown as a gallery,
  list or table.
- In the first page, add a callout listing every file the import needs
  (`> [!NOTE] Import this with: a.pdf, b.jpg`).
- A missing file doesn't stop the import: the app imports everything else and shows a note
  "*file … not included*" where it would have gone, so the person can add it later by hand.

---

## Databases

A database page has a `"type"` (its first view's layout), `properties` (columns), `cards` (rows) and
optional `views`.

### Properties

Each property: `{ "name": "…", "type": "…", …options }`. The title column (`"Name"`, or your
`titleProperty`) is made automatically — don't list it.

| `type` | What a card's value looks like | Notes |
|---|---|---|
| `text` | `"any text"` | |
| `number` | `12` or `"12.5"` | |
| `select` | `"Medium"` | `"options": ["Low", "Medium", "High"]`; an option can be `{ "name": "High", "color": "red" }`. Values that aren't options are added automatically. |
| `status` | `"In progress"` | Like select, but each option is in a group — *to-do*, *in progress*, *done*. Options can be `{ "name": "Shipped", "group": "done", "color": "green" }`; without a group, names like *Done, Finished, Complete* count as done and *Doing, In progress, Review* as in progress. Default options: Not started / In progress / Done. Cards with a date and a status show on **Today**; done ones count as finished. |
| `multi_select` (or `tags`) | `["Unit 1", "Core"]` or `"Unit 1, Core"` | Options as for select. |
| `date` | `"2026-12-01"`, `"today"`, `"tomorrow"` (or any date the computer can read) | Dated cards show on the Calendar. |
| `checkbox` | `true` / `false` (also `"yes"`, `"x"`, `"done"`) | |
| `url` (or `link`) | `"https://…"` | |
| `email` | `"name@example.com"` | |
| `phone` | `"+44 20 7946 0000"` | |
| `checklist` | `["[x] Read", "Summarise"]` | A small to-do list in the cell; `[x]` marks done. |
| `files` (or `file`, `media`, `attachments`, `images`) | `["report.pdf", "photo.jpg"]`, or `[{ "file": "cv.pdf", "name": "CV 2026" }]`, or web addresses | Files that come with the import (see **Files**). Pictures show as thumbnails and can be a gallery's card picture. |
| `id` | — | Numbers the cards 1, 2, 3… in order; `"prefix": "BIO"` gives `BIO-1`, `BIO-2`… |
| `formula` | — | `"formula": "…"` — see **Formulas**. |
| `relation` | `["Card title", "Other card"]` | Links to cards of another database in this file: add `"to": "<that database's key>"`; values are the **titles** of its cards. |
| `created_time`, `last_edited` | — | Filled in automatically. |

Colours for options: `purple`, `pink`, `lightpink`, `orange`, `yellow`, `lime`, `green`, `aqua`, `blue`,
`gray`.

**Formulas** use `prop("Property name")`; maths `+ - * / % ^`; comparisons `== != < > <= >=`; logic
`&& || !`; and functions — logic `if(cond, then, else)`, `ifs(c1, v1, c2, v2, …, else)`, `and`, `or`,
`empty(x)`, `default(x, fallback)`; text `concat`, `join(list, sep)`, `length`, `lower`, `upper`, `trim`,
`contains`, `replace`, `slice`, `repeat`, `format`, `toNumber`; numbers `abs`, `round`, `floor`, `ceil`,
`sqrt`, `pow`, `min`, `max`, `sum`, `average`; dates `today()`, `now()`, `dateAdd(date, n, "days")`,
`dateSubtract`, `dateBetween(date1, date2, "days")`, `formatDate`, `day`, `month`, `year`, `weekday`.
Example: `if(prop("Done"), "✅", dateBetween(prop("Due"), today(), "days") + " days left")`.

**Not possible in an import** (add these in the app afterwards): people/assignees, rollups, button
properties, AI autofill, automations, sub-items, dependencies, card templates, repeating cards.

### Cards

Each card is an object: its title under `"Name"` (or your `titleProperty`), and each property by its
**exact name**. Optional: `"_content"` — Markdown for the card's own page (opens when the card is
clicked); every Markdown extra and file works there.

```json
{ "Name": "Enzymes", "Status": "In progress", "Due": "2026-12-01", "Tags": ["Unit 2"],
  "Slides": ["enzymes.pptx"], "_content": "## Notes\n- Lock and key model\n\n[file](enzymes-worksheet.pdf)" }
```

### Views (optional)

A list of tabs; each `{ "type": "…", "name": "…", …settings }`. Leave `views` out to get one view of the
page's `type`.

| Setting | Used by | Meaning |
|---|---|---|
| `type` | all | `grid`, `board`, `calendar`, `timeline`, `list`, `gallery`, `chart`, `feed` |
| `name` | all | The tab's name. |
| `groupBy` | board, chart | The select/status property that makes the columns (default: the first status, else the first select). |
| `swimlanesBy` | board | A second select/checkbox property that splits the board into rows. |
| `date` | calendar, timeline | The date property cards are placed by (default: the first date). |
| `endDate` | timeline | The date property where bars end (default: the second date). |
| `cover` | gallery | A **files** property whose first picture becomes each card's picture. |
| `sort` | all | `[{ "property": "Due", "direction": "asc" }]` (`asc` or `desc`) |
| `filter` | all | `[{ "property": "Status", "op": "is_not", "value": "Done" }]` — ops `is`, `is_not`, `contains`, `not_contains`, `gt`, `lt`, `is_empty`, `is_not_empty`. Date values can be relative: `@today`, `@tomorrow`, `@yesterday`, `@this_week`, `@next_week`, `@last_week`, `@this_month`, `@next_month`, `@last_month`, `@next_7`, `@past_7`, `@next_30`, `@past_30`. Several filters must all match. |
| `hide` | all | `["Tags"]` — properties not shown in this view. |
| `chart` | chart | `{ "kind": "bar" \| "hbar" \| "line" \| "pie" \| "donut", "metric": "count" \| "sum" \| "avg", "value": "A number property" }` — grouped by `groupBy`. |

What each layout needs: a **board** groups by a select/status (one called *Status* is added if there's
none); a **calendar** needs a date (*Date* is added); a **timeline** needs a start and end date (*Date*
and *End* are added); a **gallery** looks best with a files property of pictures as its `cover`; a
**feed** shows each card's page (`_content`) as a post; a **chart** counts or adds up cards per group.

---

## A complete example

```json
{
  "format": "workspace-pages",
  "version": 1,
  "pages": [
    {
      "key": "hub",
      "title": "Biology revision",
      "icon": "🧬",
      "cover": "forest",
      "markdown": "> [!NOTE] Import this together with: syllabus.pdf, cell-diagram.png, enzymes.pptx\n\n[TOC]\n\n> [!TIP] Start with the topics you find hardest.\n\n## This week\n- [ ] Read chapter 3 @today\n- [ ] Flashcards @tomorrow 18:00\n\n## Course\n[file: Syllabus](syllabus.pdf)\n\n![A plant cell](cell-diagram.png)\n\n::: columns\n::: column\n### Strengths\n- Genetics\n::: column\n### To work on\n- Enzymes\n:::\n\n## Topics\n[[database:topics]]\n\nNotes: [[cells]]"
    },
    {
      "key": "topics",
      "parent": "hub",
      "title": "Topics",
      "icon": "📚",
      "type": "board",
      "properties": [
        { "name": "Status", "type": "status", "options": ["Not started", "Revising", { "name": "Confident", "group": "done", "color": "green" }] },
        { "name": "Difficulty", "type": "select", "options": ["Easy", "Medium", { "name": "Hard", "color": "red" }] },
        { "name": "Exam date", "type": "date" },
        { "name": "Slides", "type": "files" },
        { "name": "Days left", "type": "formula", "formula": "dateBetween(prop(\"Exam date\"), today(), \"days\")" }
      ],
      "cards": [
        { "Name": "Cells", "Status": "Confident", "Difficulty": "Easy", "Exam date": "2026-12-01", "_content": "## Notes\n- The nucleus holds the DNA" },
        { "Name": "Enzymes", "Status": "Revising", "Difficulty": "Hard", "Exam date": "2026-12-01", "Slides": ["enzymes.pptx"], "_content": "## Key ideas\n- Lock and key model\n\n$$ v = \\frac{V_{max}[S]}{K_m + [S]} $$" }
      ],
      "views": [
        { "type": "board", "name": "By status", "groupBy": "Status" },
        { "type": "calendar", "name": "Exams", "date": "Exam date" },
        { "type": "grid", "name": "Still to do", "filter": [{ "property": "Status", "op": "is_not", "value": "Confident" }], "sort": [{ "property": "Exam date", "direction": "asc" }] }
      ]
    },
    {
      "key": "cells",
      "parent": "hub",
      "title": "Cell biology notes",
      "icon": "🔬",
      "markdown": "## Cells\nThe basic unit of life.\n\n::: toggle Organelles\n- Nucleus\n- Mitochondria\n:::\n\nBack to [[hub]]."
    }
  ]
}
```

---

## If it doesn't import

| Problem | Fix |
|---|---|
| "Not a file this app can import" | The reply had text or a code fence around the JSON — save only from `{` to `}`; make sure the file ends in `.json`. |
| Nothing happens / an error about JSON | A comma or quote is wrong: no trailing commas, every string in double quotes, `\n` for line breaks, `\\` for backslashes. |
| A page landed at the top instead of inside another | Its `parent` key doesn't match any page's `key`, or the parent comes later in the list. |
| `[[key]]` shows as plain text | The key doesn't exist in the file (check spelling). |
| A card's value is empty | The card uses a property name that isn't in `properties` (names must match exactly), or a date isn't `YYYY-MM-DD`. |
| "*file … not included*" in a page | That file wasn't in the .zip or wasn't selected with the .json — check the exact name and import again (or upload it into the page by hand). |
| A relation is empty | `"to"` must be the other database's `key`, and the values must be that database's card **titles**. |

## Checklist before you answer

1. The reply is only the JSON, starting with `{` and ending with `}`.
2. `"format": "workspace-pages"` is there; every page has a unique `key` and a `title`; parents come before children.
3. Every `parent`, `[[key]]`, `[[database:key]]` and relation `"to"` uses a key that exists in the file.
4. Card values use property **names** exactly as in `properties`; select/status values match the options.
5. Dates are `YYYY-MM-DD` (or `@today` / `@tomorrow` in Markdown); times `HH:MM`.
6. Every file is named exactly as the person gave it, and all of them are listed in a NOTE callout on the first page.
7. Strings are valid JSON: `\n` for line breaks, `\"` for quotes, `\\` for backslashes (LaTeX!).

**Simpler alternative:** if JSON is impossible, reply with plain **Markdown** for one page; save it as a
`.md` file. Everything under *Writing documents* works in it (including files next to it), except links
between pages and databases.
