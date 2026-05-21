import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { loadConfig, getSite } from "../config.js";
import { wpRequest } from "../api/wp-rest.js";

export const listSitesTool = defineTool({
  name: "list_sites",
  description: "List every WordPress site configured in this MCP server's pool. Best called first in a session to discover available sites.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    total: z.number(),
    default_site_id: z.string().optional(),
    sites: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        username: z.string(),
        has_ssh: z.boolean(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler() {
    const cfg = loadConfig();
    return {
      total: cfg.sites.length,
      default_site_id: cfg.default_site_id ?? cfg.sites[0]?.id,
      sites: cfg.sites.map((s) => ({
        id: s.id,
        url: s.url,
        username: s.username,
        has_ssh: !!s.ssh,
      })),
    };
  },
});

export const pingSiteTool = defineTool({
  name: "ping_site",
  description: "Verify connectivity + authentication to a WordPress site. Calls /wp-json/wp/v2/users/me to validate credentials and returns the WP version + Elementor version if detected.",
  inputSchema: z.object({
    site_id: z.string().optional().describe("Site id from list_sites. Defaults to the default site."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    site_id: z.string(),
    url: z.string(),
    wp_version: z.string().optional(),
    elementor_version: z.string().optional(),
    elementor_pro_version: z.string().optional(),
    user: z.object({ id: z.number(), name: z.string(), roles: z.array(z.string()).optional() }).optional(),
    error: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const site = getSite(input.site_id);
    try {
      const me = await wpRequest<{ id: number; name: string; roles?: string[] }>(
        "/wp/v2/users/me?context=edit",
        { siteId: site.id },
      );
      // Site health (WP version) — best effort
      let wp_version: string | undefined;
      try {
        const health = await wpRequest<{ wordpress: { version: string } }>(
          "/wp-site-health/v1/info",
          { siteId: site.id },
        );
        wp_version = health.wordpress?.version;
      } catch {
        /* admin-restricted on some installs */
      }
      // Elementor / Pro versions via plugins endpoint
      let elementor_version: string | undefined;
      let elementor_pro_version: string | undefined;
      try {
        const plugins = await wpRequest<Array<{ plugin: string; version: string; status: string }>>(
          "/wp/v2/plugins",
          { siteId: site.id },
        );
        for (const p of plugins) {
          if (p.plugin.startsWith("elementor/") && p.plugin.endsWith("/elementor.php"))
            elementor_version = p.version;
          if (p.plugin.startsWith("elementor-pro/")) elementor_pro_version = p.version;
        }
      } catch {
        /* may require admin */
      }
      return {
        ok: true,
        site_id: site.id,
        url: site.url,
        wp_version,
        elementor_version,
        elementor_pro_version,
        user: { id: me.id, name: me.name, roles: me.roles },
      };
    } catch (e) {
      return {
        ok: false,
        site_id: site.id,
        url: site.url,
        error: (e as Error).message,
      };
    }
  },
});
