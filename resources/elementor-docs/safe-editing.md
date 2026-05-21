# Safe editing patterns for Elementor

Elementor's data model is fragile. A malformed JSON in `_elementor_data` makes the
page unrenderable in the editor and often on the frontend too. This document
captures the patterns this MCP enforces.

## The 3-step safe edit

1. **Read** the page via the WP REST API with `?context=edit` (required to get postmeta).
2. **Backup** the current `_elementor_data` into a timestamped meta key (`_elementor_data_backup_2026-05-21T17-00-00`). The MCP keeps backups indefinitely — purge them yourself when no longer needed.
3. **Edit a deep clone** of the parsed data — never mutate the original.
4. **Validate** the result by re-serializing and re-parsing (catches accidental cycles / undefined values).
5. **PUT** the new JSON back via REST.
6. **Flush CSS** via `/elementor/v1/css?id={id}&action=regenerate` or by re-saving.

## Confirmation tokens for destructive ops

Operations that modify content (find/replace, widget swap, mass-delete) use a
two-call confirmation:

1. First call → dry-run, returns `{match_count, confirmation_token, expires_in_seconds: 60}`.
2. Second call with the same parameters + the `confirmation` token → actually applies.

The token is single-use and expires in 60s by default (configurable via
`ELEMENTOR_MCP_CONFIRMATION_TTL`).

## Restoring from a backup

To restore, you need to set the current `_elementor_data` to the value of one of
the backup meta keys. The MCP does not yet expose a `restore_elementor_backup`
tool — coming in v0.2. In the meantime, you can do it manually via WP-CLI:

```bash
wp post meta update <post_id> _elementor_data "$(wp post meta get <post_id> _elementor_data_backup_2026-05-21T17-00-00)"
wp elementor flush-css
```
