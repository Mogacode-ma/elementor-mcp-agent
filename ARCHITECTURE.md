# Architecture

## Layers

```
┌─────────────────────────────────────────────────────────┐
│  MCP stdio (Claude Desktop / Code / any MCP client)     │
└────────────────────────────────────────────────────┬────┘
                                                    │
                                          ┌─────────▼────────┐
                                          │  server.ts       │
                                          │  (MCP entry)     │
                                          └─────────┬────────┘
                                                    │
              ┌─────────────────────────────────────┼──────────────────────────────┐
              │                                     │                              │
       ┌──────▼──────┐                      ┌───────▼─────┐                ┌───────▼──────┐
       │  tools/     │                      │  resources/ │                │  config.ts   │
       │             │                      │  (docs)     │                │  (sites pool)│
       └──────┬──────┘                      └─────────────┘                └──────────────┘
              │
   ┌──────────┼──────────────┐
   │          │              │
┌──▼───┐ ┌────▼─────┐ ┌──────▼────────┐
│ api/ │ │ elementor│ │ throttle/     │
│ wp-  │ │ data-    │ │ token-bucket  │
│ rest │ │ parser   │ │ (per-site)    │
└──────┘ │ safety   │ └───────────────┘
         └──────────┘
```

## Design decisions

- **Stdio transport** — same as every other MCP. No HTTP server, no auth surface. The MCP client (Claude Desktop, Claude Code, etc.) spawns the binary, talks JSON-RPC over its stdin/stdout.
- **Per-site config, not per-call** — the LLM doesn't get to inject credentials. Sites are configured once in the env via JSON; tools take a `site_id` to pick one.
- **Zod everywhere** — every tool's input is validated with Zod before the handler runs. Same Zod schema is converted to JSON Schema Draft 7 for the MCP `tools/list` response.
- **Logs to stderr only** — stdio transport is sacred. A single `console.log` would corrupt the JSON-RPC stream. `pino.destination(2)` enforces stderr.
- **Token bucket per site** — 60 req/min default. Each site has its own bucket so one slow site doesn't block another.
- **Confirmation tokens for destructive ops** — 8-byte random hex, TTL 60s, single-use, intent-locked. Stored in-memory only (no disk). Surface area for accidental destruction is minimised.
- **Backup before edit** — `_elementor_data` is fragile. Every edit creates a timestamped postmeta backup first.

## Why not WP-CLI as primary transport?

WP-CLI is more powerful than the REST API (can do anything WordPress can do), but:

1. Requires SSH access — many managed hosts don't expose it.
2. Slower per-call (SSH handshake overhead).
3. Output is text — needs parsing each time.

So: REST API is the primary surface. WP-CLI is reserved for the v0.2 escape hatch.

## Why not include Elementor Pro version check?

Elementor Pro is paid and updates through Elementor's own server (not wordpress.org). Reliably detecting "is there a newer version?" requires either:

1. Hitting Elementor's licence server (not public).
2. Scraping `elementor.com/changelog/` (fragile).
3. Reading the Pro update transient on each site (works, in roadmap).

For v0.1 we surface the **installed** Pro version per site (good enough to spot fleet-wide drift) but don't compare against a "latest" until we wire option 3 properly.
