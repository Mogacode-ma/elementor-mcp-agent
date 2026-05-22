import { readFileSync } from "node:fs";
import { z } from "zod";

const SiteSchema = z.object({
  id: z.string().min(1, "site id required"),
  url: z.string().url("invalid site url"),
  username: z.string().min(1),
  application_password: z.string().min(20, "WP application password should be ~24 chars"),
  ssh: z
    .object({
      host: z.string(),
      user: z.string(),
      port: z.coerce.number().int().min(1).max(65535).default(22),
      path: z.string().describe("WP root path on remote, e.g. ~/sites/example.com"),
      key_path: z.string().optional().describe("absolute path to private key"),
      wp_cli_path: z.string().optional().describe("Explicit wp-cli invocation prefix. Examples: 'wp' (default, if wp is in PATH), 'php ~/bin/wp.phar', '/usr/local/bin/wp'. Auto-detected if omitted."),
    })
    .optional(),
});

const ConfigSchema = z.object({
  sites: z.array(SiteSchema).min(1, "at least one site is required"),
  default_site_id: z.string().optional(),
  rate_limit_per_minute: z.coerce.number().int().min(1).max(600).default(60),
  confirmation_ttl_seconds: z.coerce.number().int().min(10).max(600).default(60),
  log_level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export type Site = z.infer<typeof SiteSchema>;
export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

/**
 * Loads configuration from environment.
 *
 * Two supported formats:
 *   1) ELEMENTOR_MCP_SITES — JSON array of Site objects (recommended)
 *   2) ELEMENTOR_MCP_CONFIG_PATH — path to a JSON file containing {sites: [...], ...}
 *
 * Plus optional env vars: ELEMENTOR_MCP_DEFAULT_SITE_ID, ELEMENTOR_MCP_RATE_LIMIT,
 * ELEMENTOR_MCP_CONFIRMATION_TTL, LOG_LEVEL.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  let raw: unknown;
  if (process.env.ELEMENTOR_MCP_SITES) {
    try {
      raw = { sites: JSON.parse(process.env.ELEMENTOR_MCP_SITES) };
    } catch (e) {
      throw new Error("ELEMENTOR_MCP_SITES must be valid JSON: " + (e as Error).message);
    }
  } else if (process.env.ELEMENTOR_MCP_CONFIG_PATH) {
    try {
      raw = JSON.parse(readFileSync(process.env.ELEMENTOR_MCP_CONFIG_PATH, "utf8"));
    } catch (e) {
      throw new Error("Cannot read ELEMENTOR_MCP_CONFIG_PATH: " + (e as Error).message);
    }
  } else {
    throw new Error(
      [
        "No site configuration provided.",
        "",
        "How to set it up:",
        "  • Easiest: set ELEMENTOR_MCP_SITES to a JSON array of sites. Example:",
        '    ELEMENTOR_MCP_SITES=\'[{"id":"my-site","url":"https://example.com",',
        '      "username":"admin","application_password":"xxxx xxxx xxxx xxxx xxxx xxxx"}]\'',
        "",
        "  • Or: set ELEMENTOR_MCP_CONFIG_PATH to a JSON file with the same structure.",
        "",
        "Get a WordPress Application Password at:",
        "  https://{your-site}/wp-admin/profile.php#application-passwords-section",
        "",
        "Full docs: https://github.com/Mogacode-ma/elementor-mcp-agent#configure",
      ].join("\n"),
    );
  }

  const r = raw as Record<string, unknown>;
  const merged = {
    sites: (r.sites as unknown) ?? [],
    default_site_id: r.default_site_id ?? process.env.ELEMENTOR_MCP_DEFAULT_SITE_ID,
    rate_limit_per_minute:
      r.rate_limit_per_minute ?? process.env.ELEMENTOR_MCP_RATE_LIMIT ?? undefined,
    confirmation_ttl_seconds:
      r.confirmation_ttl_seconds ?? process.env.ELEMENTOR_MCP_CONFIRMATION_TTL ?? undefined,
    log_level: r.log_level ?? process.env.LOG_LEVEL ?? undefined,
  };

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      [
        "Invalid configuration — required values missing or malformed:",
        issues,
        "",
        "See https://github.com/Mogacode-ma/elementor-mcp-agent#configure",
      ].join("\n"),
    );
  }
  cached = parsed.data;
  return cached;
}

export function _resetConfigCache(): void {
  cached = null;
}

export function getSite(siteId?: string): Site {
  const cfg = loadConfig();
  if (!siteId) {
    const def = cfg.default_site_id ?? cfg.sites[0]?.id;
    if (!def) throw new Error("No site configured");
    const s = cfg.sites.find((x) => x.id === def);
    if (!s) throw new Error(`Default site '${def}' not found in sites list`);
    return s;
  }
  const s = cfg.sites.find((x) => x.id === siteId);
  if (!s) {
    const available = cfg.sites.map((x) => x.id).join(", ");
    throw new Error(`Site '${siteId}' not found. Available: ${available}`);
  }
  return s;
}
