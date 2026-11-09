# Roadmap

Planned work that isn't done yet. Nothing here has a date.

## API and Claude (MCP)

- **View settings beyond filters and sorting through the API:** chart, form and calculation settings
  of a view can only be changed in the app.
- **Filters on formula and rollup values in GET …/rows:** those values are worked out in the app, so
  the server skips filters and sorts on them.

Done in 1.11.6: views through the REST API and filtered card listings, `GET /api/openapi.json` with a CI
check against the API guide, and the MCP tools read_calendar, move_note, list_trash and restore_note.

## Apps

Done in 1.11.6: saving files to Downloads and printing in the Android app.
