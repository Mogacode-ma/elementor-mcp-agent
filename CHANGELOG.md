# Changelog

## 1.2.0 — Post-write verification (never trust the write API)

Every mutating widget tool now re-reads the page from canonical WP after the
write and runs an operation-specific predicate against persisted state.
The response carries a structured `verification` block that surfaces ground
truth to the model, so it can't be fooled by an optimistic HTTP 200.

Triggered by Mads Hansen's comment on the v1.0 post-mortem
([dev.to thread](https://dev.to/mogacode/7-bugs-i-caught-in-my-mcp-server-before-publishing-and-why-i-almost-shipped-a-data-corruption-5dfd)):
a mutating MCP tool MUST force the model to see ground truth, not the write
API's optimistic acknowledgement.

### Contract change (additive, backwards-compatible)

Every `update_widget_settings`, `delete_widget`, `duplicate_widget`,
`swap_widget_type`, `add_widget`, and `move_widget` `applied` response now
includes:

```jsonc
{
  // …legacy fields unchanged…
  "mutated": true,            // false = no-op OR silent drop (see verification)
  "warnings": [],             // non-fatal issues (always an array)
  "verification": {
    "method": "Re-read /wp/v2/pages/42 and check widget abc settings include the requested patch",
    "reread_ok": true,
    "matches_requested": true,  // false = write API lied, treat as failure
    "persisted": { /* op-specific: the canonical state we read back */ },
    "notes": "…explanation when matches_requested is false"
  }
}
```

If `verification.matches_requested === false`, the tool's write claim is
unreliable — the REST API or a plugin filter silently dropped or mutated the
payload. The model should escalate / rollback regardless of HTTP status.

### New module
- `src/elementor/verify.ts` — `verifyWrite()` generic primitive + `deepEqual`
- 4 new unit tests (27 total, all green)

## 1.1.0 — Widget-level CRUD + bulk/fleet ops

10 new tools, all reusing the v1.0 safety primitives (backup → validate → flush → auto-rollback).

### Widget-level CRUD (7 tools)
- `read_widget` — fetch one widget by id (read-only)
- `update_widget_settings` — shallow-merge settings on a widget, with full safety flow
- `delete_widget` — remove a widget from its parent container
- `duplicate_widget` — clone as a sibling with a fresh Elementor-shaped id
- `swap_widget_type` — replace widgetType + settings while preserving id + position
- `add_widget` — append a new widget into a parent container
- `move_widget` — move a widget between containers (sections/columns) with optional position

### Bulk & fleet (3 tools)
- `bulk_find_replace_site` — iterate every Elementor page on one site; per-page backup, validate, flush
- `fleet_find_replace` — same across every site in the pool, sequential to avoid concurrent writes
- `restore_from_file` — restore `_elementor_data` from a JSON file backup, with pre-restore safety backup

### Internal
- New `src/elementor/widget-ops.ts` with 9 unit tests
- Shared `fetchData()` / `writeData()` helpers wrap the v1.0 backup + validator chain
- Total tools: 24 → 34

## 1.0.0 — Agency-grade release

First production-ready release. 24 tools, end-to-end verified against a live WordPress + Elementor install.

### Tools
- 3 sites: `list_sites`, `ping_site`, `site_health`
- 9 pages: list, read, widgets x2, preflight, find_replace, backups list/restore, duplicate
- 4 templates: list (Theme Builder distinguished), export, import, apply_to_page
- 5 wp-cli escape: run, search_replace, flush_css, plugin list/update
- 2 visual: screenshot_page, compare_screenshots
- 1 fleet: check_elementor_versions

### Safety patterns
- WP-CLI primary for backups (REST silently drops custom postmeta)
- 3-level CSS flush fallback
- Two-call confirmation with TTL for every destructive op
- JSON validation + auto-rollback after edits
- Global widget detection in preflight
- Hard-blocked wp-cli patterns (rm -rf, sudo, db reset)
- Token bucket per site (60 req/min default)

### Bugs found & fixed during e2e testing
- REST API silently drops writes to unregistered postmeta keys
- `wp` binary not in non-interactive SSH PATH on managed hosts
- SSH post-quantum banner polluting stderr
- Default Kit returned by `template_type=widget` filter
- `_elementor_page_settings` type mismatch (object via REST vs string via WP-CLI)
- Chrome cold-start screenshot timeout
- Templates listing same client-side filter issue
