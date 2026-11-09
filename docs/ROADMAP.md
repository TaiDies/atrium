# Roadmap

Planned work that isn't done yet. Nothing here has a date.

## API and Claude (MCP)

- **Views through the REST API:** list, create, change and delete a database's views (board, calendar,
  table…), and use a view's filters and sorting when listing cards (`GET /api/pages/:id/rows?view=…`).
  Today cards can be listed, made, changed and deleted, but every listing returns all cards.
- **`GET /api/openapi.json`:** a machine-readable description generated from the server's real routes,
  plus a CI check that fails when a route is missing from the API guide (`/api/docs`).
- **More MCP tools:** read the calendar, move a note under another one, and list and restore notes in the
  trash.

## Apps

- **Saving files and printing in the Android app:** exporting (Markdown, PDF, .zip, .docx, .xlsx) and
  printing do nothing there yet (see *Known limit* under Android in INSTALL.md). It needs a native save
  path and Android's print service.
