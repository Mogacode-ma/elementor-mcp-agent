/**
 * Hardcoded safety policies for the Elementor MCP.
 * These rules are intentionally inflexible — they encode lessons from real
 * production incidents on client sites.
 */

export const POLICIES = {
  // Always backup _elementor_data BEFORE any write
  BACKUP_BEFORE_WRITE: true,
  // Always backup _elementor_page_settings too (it carries page-level CSS, fonts, layout)
  BACKUP_PAGE_SETTINGS: true,
  // Re-validate the JSON after a programmatic edit; abort + auto-restore if invalid
  VALIDATE_JSON_AFTER_EDIT: true,
  // Block edits to global widgets unless caller explicitly opts in
  BLOCK_GLOBAL_WIDGET_WRITES_BY_DEFAULT: true,
  // Confirmation token TTL — short for destructive ops
  CONFIRMATION_TTL_SECONDS: 60,
  // Stricter TTL for global widget ops (less margin for mistakes)
  GLOBAL_WIDGET_CONFIRMATION_TTL_SECONDS: 30,
  // CSS flush is non-optional after _elementor_data writes
  FLUSH_CSS_AFTER_WRITE: true,
  // Maximum size of a single page's _elementor_data we'll touch (sanity bound)
  MAX_ELEMENTOR_DATA_BYTES: 5 * 1024 * 1024, // 5 MB
  // wp-cli commands matching this pattern require confirmation
  WP_CLI_DESTRUCTIVE_REQUIRES_CONFIRM: true,
} as const;

export const FORBIDDEN_WPCLI_PATTERNS: RegExp[] = [
  // Hard 'no' regardless of confirmation — we never accept these
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bdb\s+reset\s+--yes\b/i,
  /\bdb\s+drop\s+--yes\b/i,
];

export function isForbiddenWpCli(args: string): { forbidden: boolean; reason?: string } {
  for (const p of FORBIDDEN_WPCLI_PATTERNS) {
    if (p.test(args)) return { forbidden: true, reason: `Pattern ${p} is hard-blocked.` };
  }
  return { forbidden: false };
}
