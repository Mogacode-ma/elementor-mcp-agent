# elementor-mcp-agent

[![npm version](https://img.shields.io/npm/v/elementor-mcp-agent.svg)](https://www.npmjs.com/package/elementor-mcp-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **Agency-grade MCP server for WordPress Elementor.** Multi-site management, safe Elementor edits with backup + auto-rollback + CSS flush, template export/import, global widget detection, screenshots, WP-CLI escape hatch.

Built for agencies running many client sites on Elementor / Elementor Pro who want Claude (or any MCP client) to drive the toil — **without breaking pages**.

---

## How this was built

elementor-mcp-agent was built end-to-end with Claude Code over ~48 hours. The process is intentionally open:

- Architecture, code, tests, docs — all generated through Claude Code pair-programming sessions
- The 7 bugs documented in [this post-mortem](https://dev.to/mogacode/7-bugs-i-caught-in-my-mcp-server-before-publishing-and-why-i-almost-shipped-a-data-corruption-5dfd) were caught in real E2E testing against a live WordPress + Elementor install, not after the fact
- v1.2's post-write verification pattern was shipped 2 hours after a reader's comment ([Mads Hansen on Dev.to](https://dev.to/mogacode/7-bugs-i-caught-in-my-mcp-server-before-publishing-and-why-i-almost-shipped-a-data-corruption-5dfd/comments)) — the changelog credits the source

This isn't vibe-coded software thrown over the wall. Every release ran through lint + typecheck + 27 unit tests + (for v1.0) full E2E against a real WordPress install before publishing. The MCP itself hardcodes guardrails that prevent the model from making destructive WP-CLI calls.

I run a small WordPress agency and use this tool every day on client sites. If you're skeptical about agentic codegen for production infrastructure, the entire commit history is in the open — judge for yourself.

---

## Why this exists

There are 25+ WordPress MCP servers on GitHub today. None targets the **agency multi-site workflow** with:

- **Real backup before every edit** (postmeta via WP-CLI when SSH available, JSON file fallback — never silently lost)
- **Two-call confirmation** for any destructive op (TTL 60s)
- **JSON validation + auto-rollback** if an edit produces invalid Elementor data
- **3-level CSS flush fallback** (REST → wp-cli native → option/meta delete → re-save)
- **Global widget awareness** — preflight check warns if a page references shared widgets
- **WP-CLI escape hatch** for everything the REST API can't do safely
- **Screenshots** via headless Chrome (no puppeteer dep)

---

## Install

```bash
npx -y elementor-mcp-agent
```

## Configure

```bash
export ELEMENTOR_MCP_SITES='[{
  "id": "client-acme",
  "url": "https://acme.example.com",
  "username": "admin",
  "application_password": "xxxx xxxx xxxx xxxx xxxx xxxx",
  "ssh": {
    "host": "host.example.com",
    "user": "username",
    "port": 22,
    "path": "/path/to/wordpress",
    "wp_cli_path": "wp"
  }
}]'
```

Generate the **WordPress Application Password** at `https://{your-site}/wp-admin/profile.php#application-passwords-section`.

The `ssh` block is **optional** but unlocks **8 additional tools** (WP-CLI escape hatch + reliable custom-postmeta backups). The MCP works without SSH — backups go to local JSON files instead.

`wp_cli_path` auto-detects if omitted (tries `wp`, then `~/bin/wp.phar`, then `~/wp-cli.phar`).

### Claude Desktop config

```json
{
  "mcpServers": {
    "elementor": {
      "command": "npx",
      "args": ["-y", "elementor-mcp-agent"],
      "env": {
        "ELEMENTOR_MCP_SITES": "[{\"id\":\"acme\",\"url\":\"https://acme.com\",\"username\":\"admin\",\"application_password\":\"...\"}]"
      }
    }
  }
}
```

---

## Tools (34)

### Sites & health
- `list_sites` — enumerate the pool
- `ping_site` — auth + version probe
- `site_health` — multi-call health snapshot

### Pages
- `list_elementor_pages` — pages in builder mode
- `read_page_elementor` — parsed summary + optional full tree
- `list_widgets_in_page` — flat widget inventory with excerpts
- `list_global_widgets` — shared widgets (edit one → affects every page using it)
- `preflight_check` — validate a page is safe to edit
- `elementor_find_replace` — text replace with **dry-run → token → apply → backup → validate → rollback if invalid**
- `list_elementor_backups` / `restore_elementor_backup` — full restore chain with pre-restore safety backup
- `duplicate_elementor_page` — clone within a site (data + page_settings + edit_mode)

### Templates
- `list_elementor_templates` — Theme Builder distinguished from regular library
- `export_elementor_template` — portable JSON
- `import_elementor_template` — drop into target site
- `apply_template_to_page` — push template data onto an existing page

### WP-CLI escape hatch (require SSH)
- `wp_cli_run` — arbitrary wp-cli command with destructive-pattern detection + confirmation
- `wp_search_replace` — `wp search-replace` with mandatory dry-run
- `wp_elementor_flush_css` — 3-level fallback
- `wp_plugin_list` / `wp_plugin_update` (with confirmation)

### Visual
- `screenshot_page` — headless Chrome PNG of any URL
- `compare_screenshots` — SHA-256 + byte-delta

### Widgets (v1.1 — widget-level CRUD)
- `read_widget` — fetch one widget by id (read-only)
- `update_widget_settings` — shallow-merge settings, with backup + validate + flush
- `delete_widget` — remove a widget from its parent container
- `duplicate_widget` — clone as sibling with fresh id
- `swap_widget_type` — replace widgetType + settings, preserve id + position
- `add_widget` — append a widget into a parent container
- `move_widget` — move a widget between containers (with position)

### Bulk & fleet (v1.1)
- `bulk_find_replace_site` — find/replace across every Elementor page of one site, per-page backup + validate + flush
- `fleet_find_replace` — same across **every site in the pool** (sequential, dry-run mandatory)
- `restore_from_file` — restore `_elementor_data` from a JSON file backup, with pre-restore safety backup

### Fleet
- `check_elementor_versions` — flag outdated installs against wordpress.org latest

---

## Post-write verification (v1.2)

Every mutating widget tool re-reads the page from canonical WP **after the
write** and surfaces persisted state to the model. The HTTP write API can
lie — return 200 OK while plugin filters or REST quirks silently drop the
payload. This contract makes that observable.

Every `applied` response carries:

```jsonc
{
  "mutated": true,                  // false = no-op OR silent drop
  "warnings": [],                   // non-fatal issues
  "verification": {
    "method": "Re-read /wp/v2/pages/42 and check widget abc settings…",
    "reread_ok": true,
    "matches_requested": true,      // false = write API lied
    "persisted": { /* canonical state */ },
    "notes": "…explanation when something diverged"
  }
}
```

If `verification.matches_requested === false`, treat as a failure even if
the HTTP layer said OK. The original payload survives in
`backup_meta_key` — restore via `restore_elementor_backup`.

---

## Safety guarantees

Hardcoded in `src/elementor/policies.ts`:

```ts
BACKUP_BEFORE_WRITE                 = true
BACKUP_PAGE_SETTINGS                = true
VALIDATE_JSON_AFTER_EDIT            = true
BLOCK_GLOBAL_WIDGET_WRITES_BY_DEFAULT = true
CONFIRMATION_TTL_SECONDS            = 60
GLOBAL_WIDGET_CONFIRMATION_TTL_SECONDS = 30
FLUSH_CSS_AFTER_WRITE               = true
MAX_ELEMENTOR_DATA_BYTES            = 5_000_000
```

And these wp-cli patterns are **hard-blocked** regardless of confirmation:
- `rm -rf`
- `sudo *`
- `db reset --yes` / `db drop --yes`

---

## End-to-end verified

v1.0.0 was tested in real conditions against a live WordPress install with Elementor 4.0.9:

- ✅ 21/24 tools validated end-to-end
- ✅ find_replace → backup → restore round-trip preserves data
- ✅ duplicate_page copies data + page_settings + edit_mode
- ✅ apply_template_to_page with auto-backup
- ✅ wp_cli_run destructive flow (post delete) requires confirmation
- ✅ screenshots identical detection via SHA-256
- ✅ CSS flush uses `wp elementor flush-css` when SSH available, falls back to option-delete otherwise

7 bugs found during testing, all fixed:
- REST API silently drops unregistered postmeta writes → switched to WP-CLI primary for backups
- `wp` not in SSH PATH on managed hosts → auto-detection + `wp_cli_path` config
- SSH post-quantum banner pollution → stderr filter
- Default Kit returned as "widget" → client-side filter
- `_elementor_page_settings` type object/string mismatch → normalisation
- Chrome cold-start screenshot timeout → bumped to 60s
- Templates listing same filter bug → fixed

---

## Roadmap

**v1.1** ✅ shipped
- Widget-level CRUD: `read_widget`, `update_widget_settings`, `delete_widget`, `duplicate_widget`, `swap_widget_type`, `add_widget`, `move_widget`
- `bulk_find_replace_site` (across all Elementor pages of one site)
- `fleet_find_replace` (across all sites in pool)
- `restore_from_file`

**v1.2**
- Global styles read/write
- Theme Builder template push across sites
- Section/column-level operations

**v2.0**
- WooCommerce-aware tools
- Visual diff (pixel comparison)
- Schedule + cron scheduling

---

## License

[MIT](./LICENSE) — © 2026 [MogaCode](https://mogacode.ma).
