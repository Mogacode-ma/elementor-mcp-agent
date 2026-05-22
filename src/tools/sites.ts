import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { loadConfig, getSite } from "../config.js";
import { wpRequest } from "../api/wp-rest.js";

export const listSitesTool = defineTool({
  name: "list_sites",
  description: "List every WordPress site configured. Best called first in a session.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    total: z.number(),
    default_site_id: z.string().optional(),
    sites: z.array(z.object({
      id: z.string(), url: z.string(), username: z.string(), has_ssh: z.boolean(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler() {
    const cfg = loadConfig();
    return {
      total: cfg.sites.length,
      default_site_id: cfg.default_site_id ?? cfg.sites[0]?.id,
      sites: cfg.sites.map((s) => ({ id: s.id, url: s.url, username: s.username, has_ssh: !!s.ssh })),
    };
  },
});

export const pingSiteTool = defineTool({
  name: "ping_site",
  description: "Verify connectivity + authentication to a WordPress site. Returns user identity + WP/Elementor/Elementor Pro versions if accessible.",
  inputSchema: z.object({ site_id: z.string().optional() }),
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
      const me = await wpRequest<{ id: number; name: string; roles?: string[] }>("/wp/v2/users/me?context=edit", { siteId: site.id });
      let wp_version: string | undefined;
      try {
        const health = await wpRequest<{ wordpress: { version: string } }>("/wp-site-health/v1/info", { siteId: site.id });
        wp_version = health.wordpress?.version;
      } catch { /* admin restricted */ }
      let elementor_version: string | undefined;
      let elementor_pro_version: string | undefined;
      try {
        const plugins = await wpRequest<Array<{ plugin: string; version: string; status: string }>>("/wp/v2/plugins", { siteId: site.id });
        for (const p of plugins) {
          if (p.plugin.startsWith("elementor/") && p.plugin.endsWith("/elementor.php")) elementor_version = p.version;
          if (p.plugin.startsWith("elementor-pro/")) elementor_pro_version = p.version;
        }
      } catch { /* may require admin */ }
      return {
        ok: true, site_id: site.id, url: site.url,
        wp_version, elementor_version, elementor_pro_version,
        user: { id: me.id, name: me.name, roles: me.roles },
      };
    } catch (e) {
      return { ok: false, site_id: site.id, url: site.url, error: (e as Error).message };
    }
  },
});

export const siteHealthTool = defineTool({
  name: "site_health",
  description: "Comprehensive site health snapshot: WP/PHP/Elementor versions, disk space (if SSH), plugin count, theme info. Aggregates multiple REST calls into a single overview.",
  inputSchema: z.object({ site_id: z.string().optional() }),
  outputSchema: z.object({
    site_id: z.string(),
    url: z.string(),
    wp_version: z.string().optional(),
    php_version: z.string().optional(),
    elementor_version: z.string().optional(),
    elementor_pro_version: z.string().optional(),
    active_theme: z.string().optional(),
    plugins_total: z.number().optional(),
    plugins_active: z.number().optional(),
    plugins_outdated: z.number().optional(),
    elementor_pages_count: z.number().optional(),
    errors: z.array(z.string()),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const site = getSite(input.site_id);
    const errors: string[] = [];
    let wp_version, php_version, elementor_version, elementor_pro_version, active_theme;
    let plugins_total, plugins_active, plugins_outdated, elementor_pages_count;

    try {
      const info = await wpRequest<{ wordpress: { version: string }; "wp-server"?: { fields?: { php_version?: { value?: string } } } }>("/wp-site-health/v1/info", { siteId: site.id });
      wp_version = info.wordpress?.version;
      php_version = info["wp-server"]?.fields?.php_version?.value;
    } catch (e) { errors.push("site-health: " + (e as Error).message); }

    try {
      const plugins = await wpRequest<Array<{ plugin: string; version: string; status: string }>>("/wp/v2/plugins", { siteId: site.id });
      plugins_total = plugins.length;
      plugins_active = plugins.filter((p) => p.status === "active").length;
      for (const p of plugins) {
        if (p.plugin.startsWith("elementor/") && p.plugin.endsWith("/elementor.php")) elementor_version = p.version;
        if (p.plugin.startsWith("elementor-pro/")) elementor_pro_version = p.version;
      }
    } catch (e) { errors.push("plugins: " + (e as Error).message); }

    try {
      const themes = await wpRequest<Array<{ stylesheet: string; status: string; name: { raw: string } }>>("/wp/v2/themes", { siteId: site.id });
      const active = themes.find((t) => t.status === "active");
      active_theme = active?.name?.raw;
    } catch (e) { errors.push("themes: " + (e as Error).message); }

    try {
      const pages = await wpRequest<unknown[]>("/wp/v2/pages", { siteId: site.id, query: { meta_key: "_elementor_edit_mode", meta_value: "builder", per_page: 1, _fields: "id" } });
      // We don't get total from headers easily — at least say "≥ 1" if any
      elementor_pages_count = pages.length > 0 ? -1 : 0; // -1 means "at least one, count not reliably known"
    } catch (e) { errors.push("pages: " + (e as Error).message); }

    return {
      site_id: site.id, url: site.url,
      wp_version, php_version, elementor_version, elementor_pro_version, active_theme,
      plugins_total, plugins_active, plugins_outdated,
      elementor_pages_count,
      errors,
    };
  },
});
