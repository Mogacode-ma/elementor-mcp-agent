# elementor-mcp-agent

[![npm version](https://img.shields.io/npm/v/elementor-mcp-agent.svg)](https://www.npmjs.com/package/elementor-mcp-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **Agency-grade MCP server for WordPress Elementor.** Multi-site management, safe Elementor data editing with backup + dry-run + CSS-flush, template export/import across sites, version tracking, and a curated Elementor docs corpus exposed as MCP resources.

Built for agencies running many client sites on Elementor / Elementor Pro who want Claude (or any MCP client) to drive the toil — without breaking pages.

---

## Why this exists

There are ~25 WordPress MCP servers on GitHub today. None target the **agency** use case:

- **Multi-site** — list, ping, and act on a pool of sites in one prompt.
- **Elementor-aware** — understands `_elementor_data` structure, not just generic WP REST.
- **Defensive editing** — auto-backup before any change, dry-run + confirmation token for destructive ops, CSS regeneration on save.
- **Cross-site template sync** — export from staging, import on every client site in one shot.
- **Version oversight** — see who's running which Elementor / Elementor Pro version across the whole fleet.

This MCP starts with these four pillars and grows from there.

---

## ⚠️ Status: early days

v0.1.0 is shipped end-to-end (CI green, 14 tests passing, npm + MCP Registry listed) but the tool surface is intentionally focused. Expect rapid iteration. Don't run destructive operations on production without testing on staging first.

---

## Install

```bash
npx -y elementor-mcp-agent
```

Or globally:

```bash
npm install -g elementor-mcp-agent
```

## Configure

The server needs to know about your sites. The simplest path: an env var with a JSON array.

```bash
export ELEMENTOR_MCP_SITES='[
  {
    "id": "client-acme",
    "url": "https://acme.example.com",
    "username": "admin",
    "application_password": "xxxx xxxx xxxx xxxx xxxx xxxx"
  },
  {
    "id": "client-beta",
    "url": "https://beta.example.com",
    "username": "admin",
    "application_password": "yyyy yyyy yyyy yyyy yyyy yyyy"
  }
]'
```

Generate the **WordPress Application Password** at:
`https://{your-site}/wp-admin/profile.php#application-passwords-section`

(`Application Passwords` is a built-in WordPress 5.6+ feature. No plugin required.)

Or use a config file:

```bash
export ELEMENTOR_MCP_CONFIG_PATH="/path/to/sites.json"
```

With `sites.json`:
```json
{
  "sites": [
    { "id": "...", "url": "...", "username": "...", "application_password": "..." }
  ],
  "default_site_id": "client-acme",
  "rate_limit_per_minute": 60,
  "confirmation_ttl_seconds": 60
}
```

### Configure Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "elementor": {
      "command": "npx",
      "args": ["-y", "elementor-mcp-agent"],
      "env": {
        "ELEMENTOR_MCP_SITES": "[{\"id\":\"acme\",\"url\":\"https://acme.com\",\"username\":\"admin\",\"application_password\":\"xxxx...\"}]"
      }
    }
  }
}
```

### Configure Claude Code

```bash
claude mcp add elementor \
  -e ELEMENTOR_MCP_SITES='[{"id":"acme","url":"https://acme.com","username":"admin","application_password":"xxxx..."}]' \
  -- npx -y elementor-mcp-agent
```

---

## Tools (v0.1)

| Tool | What it does |
|---|---|
| `list_sites` | Lists every site in the pool (id, url, username, has_ssh). |
| `ping_site` | Verifies auth + reports WP / Elementor / Elementor Pro versions. |
| `list_elementor_pages` | Lists pages built with Elementor on a given site. |
| `read_page_elementor` | Returns a structured summary of a page's `_elementor_data` (widget counts by type, depth). Full tree with `verbose=true`. |
| `elementor_find_replace` | Find/replace plain text in every widget on a page. **Two-call destructive flow**: dry-run returns a count + token; second call with token applies after auto-backup. |
| `list_elementor_templates` | Lists library templates (sections, pages, popups, headers, footers). |
| `export_elementor_template` | Exports a template as portable JSON. |
| `import_elementor_template` | Imports a portable JSON template into a target site. |
| `check_elementor_versions` | Fleet-wide Elementor version audit. Flags outdated installs against wordpress.org latest. |

## Resources

The server exposes a hand-curated set of Elementor reference docs as MCP `resources`, so the LLM can look up hook names, widget structure, and safe editing patterns without leaving its context:

- `elementor-docs://hooks-actions.md` — common action hooks + filters
- `elementor-docs://widget-structure.md` — `_elementor_data` schema + common widget types
- `elementor-docs://safe-editing.md` — backup, dry-run, CSS flush patterns

---

## Safety patterns

Every destructive operation follows the same dance:

1. **First call** (no `confirmation` arg) → dry-run. Returns `match_count` + `confirmation_token` (TTL 60s, configurable).
2. **Second call** (same args + token) → applies after backing up the page's `_elementor_data` to a timestamped postmeta key.
3. **CSS flush** is triggered automatically (REST `/elementor/v1/css?action=regenerate`, falls back to re-save).

The backup is **never deleted** — purge old `_elementor_data_backup_*` postmeta keys yourself when no longer needed.

---

## Rate limiting

Per-site token bucket, default **60 req/min** (matches what most managed WordPress hosts allow on `wp-json`). Override via `rate_limit_per_minute` in config.

---

## Roadmap

**v0.2**
- [ ] `widget_swap` — replace one widget by another with field mapping
- [ ] `restore_elementor_backup` — restore a page from a timestamped backup
- [ ] `bulk_find_replace` — apply find/replace across all pages of a site
- [ ] WP-CLI runner via SSH for ops the REST API can't do

**v0.3**
- [ ] Cross-site template push (`push_template_to_all`)
- [ ] Fleet health: outdated plugins, broken links, PageSpeed snapshot
- [ ] Visual diff (screenshot before/after)
- [ ] Elementor Pro version detection from Pro server (currently free-only)

**v1.0**
- [ ] Mature widget mutation API (typed setters per widget type)
- [ ] Automated docs ingestion from developer.elementor.com
- [ ] Per-tool happy-path tests against a real Elementor install

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design rationale.

Short version: stdio MCP, Zod-validated tools, token-bucket throttling, confirmation tokens for destructive ops, pino logs to stderr (never stdout), tsup bundle, vitest tests.

---

## License

[MIT](./LICENSE) — © 2026 [MogaCode](https://mogacode.ma).
