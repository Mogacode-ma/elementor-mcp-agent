import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { getSite } from "../config.js";
import { sshWpCli, isDestructiveWpCli } from "../transport/ssh-wpcli.js";
import { isForbiddenWpCli, POLICIES } from "../elementor/policies.js";
import { issueConfirmation, consumeConfirmation } from "../utils/confirmation.js";

export const wpCliRunTool = defineTool({
  name: "wp_cli_run",
  description: "Execute an arbitrary wp-cli command on a site via SSH. The `wp` prefix and `--path` are added automatically — pass only the args (e.g. 'post list --post_type=page'). Destructive commands (delete, drop, search-replace without --dry-run, plugin deactivate/uninstall) require a two-call confirmation flow.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    args: z.string().min(1).describe("WP-CLI args without leading 'wp', e.g. 'post list --post_type=page'"),
    timeout_ms: z.number().int().min(1000).max(300_000).default(60_000),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run_destructive", "executed"]),
    command: z.string(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exit_code: z.number().optional(),
    duration_ms: z.number().optional(),
    destructive_pattern_detected: z.boolean().optional(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const forbidden = isForbiddenWpCli(input.args);
    if (forbidden.forbidden) {
      throw new Error(`Forbidden wp-cli command. ${forbidden.reason}`);
    }
    const isDestructive = isDestructiveWpCli(input.args);

    if (isDestructive && !input.confirmation) {
      const token = issueConfirmation("wp_cli_run", { site_id: input.site_id, args: input.args }, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run_destructive" as const,
        command: `wp <path> ${input.args}`,
        destructive_pattern_detected: true,
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }
    if (isDestructive && input.confirmation) {
      const conf = consumeConfirmation(input.confirmation, "wp_cli_run");
      if (!conf) throw new Error("Invalid or expired confirmation token");
      const o = conf.payload as { args: string; site_id?: string };
      if (o.args !== input.args || o.site_id !== input.site_id) {
        throw new Error("Confirmation parameters don't match the original dry-run");
      }
    }

    const site = getSite(input.site_id);
    const r = await sshWpCli(site, input.args, { timeout_ms: input.timeout_ms });
    return {
      mode: "executed" as const,
      command: r.command,
      stdout: r.stdout,
      stderr: r.stderr,
      exit_code: r.exitCode,
      duration_ms: r.duration_ms,
      destructive_pattern_detected: isDestructive,
    };
  },
});

export const wpSearchReplaceTool = defineTool({
  name: "wp_search_replace",
  description: "Run `wp search-replace` against wp_postmeta (default) — the standard agency way to update Elementor text content. ALWAYS dry-run first; the apply call requires a confirmation token. Includes --precise --all-tables-with-prefix by default if you specify table='all'.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    find: z.string().min(1),
    replace: z.string(),
    table: z.string().default("wp_postmeta"),
    include_columns: z.string().optional().describe("e.g. 'meta_value'. Default: meta_value when table=wp_postmeta."),
    precise: z.boolean().default(true),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    command: z.string(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exit_code: z.number().optional(),
    replacement_count: z.number().optional(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const includeCols = input.include_columns ?? (input.table === "wp_postmeta" ? "meta_value" : "");
    const baseArgs = [
      "search-replace",
      `'${input.find.replace(/'/g, "'\\''")}'`,
      `'${input.replace.replace(/'/g, "'\\''")}'`,
      input.table,
      includeCols ? `--include-columns=${includeCols}` : "",
      input.precise ? "--precise" : "",
    ].filter(Boolean).join(" ");

    const site = getSite(input.site_id);

    if (!input.confirmation) {
      // Dry run
      const dry = await sshWpCli(site, baseArgs + " --dry-run");
      const m = dry.stdout.match(/Success: (\d+) replacement/);
      const count = m ? parseInt(m[1], 10) : 0;
      if (count === 0) {
        return { mode: "dry_run" as const, command: dry.command, stdout: dry.stdout, exit_code: dry.exitCode, replacement_count: 0 };
      }
      const token = issueConfirmation("wp_search_replace", { args: baseArgs, site_id: input.site_id }, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        command: dry.command,
        stdout: dry.stdout,
        replacement_count: count,
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }
    const conf = consumeConfirmation(input.confirmation, "wp_search_replace");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const o = conf.payload as { args: string; site_id?: string };
    if (o.args !== baseArgs || o.site_id !== input.site_id) throw new Error("Confirmation params mismatch");
    const r = await sshWpCli(site, baseArgs);
    const m = r.stdout.match(/Success: (\d+) replacement/);
    return {
      mode: "applied" as const,
      command: r.command,
      stdout: r.stdout,
      stderr: r.stderr,
      exit_code: r.exitCode,
      replacement_count: m ? parseInt(m[1], 10) : 0,
    };
  },
});

export const wpElementorFlushCssTool = defineTool({
  name: "wp_elementor_flush_css",
  description: "Flush Elementor's CSS cache on a site using the 3-level fallback strategy (REST endpoint → wp-cli native → option/meta delete). Always call after writing _elementor_data programmatically.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive().optional().describe("Optional: flush only this page's cache. If omitted, flushes site-wide."),
  }),
  outputSchema: z.object({
    method: z.enum(["rest", "wp-cli", "option-delete", "resave", "none"]),
    details: z.string().optional(),
  }),
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const { flushCSS } = await import("../elementor/css-flush.js");
    return flushCSS(input.site_id, input.page_id);
  },
});

export const wpPluginListTool = defineTool({
  name: "wp_plugin_list",
  description: "List installed plugins on a site with name, version, status (active/inactive), and update_version (if outdated). Uses WP-CLI for accurate version data including update_version.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    only_outdated: z.boolean().default(false),
  }),
  outputSchema: z.object({
    total: z.number(),
    plugins: z.array(z.object({
      name: z.string(),
      status: z.string(),
      version: z.string(),
      update: z.string().optional(),
      update_version: z.string().optional(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const site = getSite(input.site_id);
    const r = await sshWpCli(site, "plugin list --format=json");
    if (r.exitCode !== 0) throw new Error(`wp plugin list failed: ${r.stderr}`);
    interface PluginRow { name: string; status: string; version: string; update: string; update_version?: string; }
    const arr = JSON.parse(r.stdout) as PluginRow[];
    const filtered = input.only_outdated ? arr.filter((p) => p.update === "available") : arr;
    return { total: filtered.length, plugins: filtered };
  },
});

export const wpPluginUpdateTool = defineTool({
  name: "wp_plugin_update",
  description: "Update one or more plugins on a site to their latest version. Requires confirmation token (uses wp-cli).",
  inputSchema: z.object({
    site_id: z.string().optional(),
    plugins: z.array(z.string()).min(1).describe("Plugin slugs to update, e.g. ['elementor', 'elementor-pro']. Use 'all' for everything outdated."),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    plugins: z.array(z.string()),
    command: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exit_code: z.number().optional(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("wp_plugin_update", { site_id: input.site_id, plugins: input.plugins }, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        plugins: input.plugins,
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }
    const conf = consumeConfirmation(input.confirmation, "wp_plugin_update");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const site = getSite(input.site_id);
    const target = input.plugins.includes("all") ? "--all" : input.plugins.map((p) => `'${p}'`).join(" ");
    const r = await sshWpCli(site, `plugin update ${target}`, { timeout_ms: 180_000 });
    return {
      mode: "applied" as const,
      plugins: input.plugins,
      command: r.command,
      stdout: r.stdout,
      stderr: r.stderr,
      exit_code: r.exitCode,
    };
  },
});
