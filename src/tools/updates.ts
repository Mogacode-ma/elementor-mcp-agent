import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import { loadConfig } from "../config.js";

interface PluginInfo {
  plugin: string;
  version: string;
  status: string;
  name?: string;
  plugin_uri?: string;
}

async function fetchLatestElementor(): Promise<{ free: string; pro?: string }> {
  // Elementor (free) is on the WordPress.org plugin API
  const free = await fetch("https://api.wordpress.org/plugins/info/1.0/elementor.json").then((r) => r.json()).catch(() => null);
  // Elementor Pro is commercial — we can scrape the changelog but it requires HTML parsing.
  // For now we return only the free version (the most common upgrade signal).
  return { free: (free?.version as string) ?? "unknown" };
}

export const checkElementorVersionsTool = defineTool({
  name: "check_elementor_versions",
  description: "For every configured site, fetch the installed Elementor / Elementor Pro version and compare against the latest available on wordpress.org. Returns a per-site row with 'outdated' flag.",
  inputSchema: z.object({
    site_ids: z.array(z.string()).optional().describe("Subset of sites to check. Defaults to all."),
  }),
  outputSchema: z.object({
    checked: z.number(),
    latest_elementor_free: z.string(),
    sites: z.array(
      z.object({
        site_id: z.string(),
        url: z.string(),
        elementor_version: z.string().optional(),
        elementor_pro_version: z.string().optional(),
        outdated_free: z.boolean(),
        error: z.string().optional(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const cfg = loadConfig();
    const latest = await fetchLatestElementor();
    const targets = input.site_ids
      ? cfg.sites.filter((s) => input.site_ids?.includes(s.id))
      : cfg.sites;
    const rows = [];
    for (const site of targets) {
      try {
        const plugins = await wpRequest<PluginInfo[]>("/wp/v2/plugins", { siteId: site.id });
        let elementor_version: string | undefined;
        let elementor_pro_version: string | undefined;
        for (const p of plugins) {
          if (p.plugin.startsWith("elementor/") && p.plugin.endsWith("/elementor.php"))
            elementor_version = p.version;
          if (p.plugin.startsWith("elementor-pro/")) elementor_pro_version = p.version;
        }
        rows.push({
          site_id: site.id,
          url: site.url,
          elementor_version,
          elementor_pro_version,
          outdated_free: !!elementor_version && elementor_version !== latest.free && latest.free !== "unknown",
        });
      } catch (e) {
        rows.push({
          site_id: site.id,
          url: site.url,
          outdated_free: false,
          error: (e as Error).message,
        });
      }
    }
    return {
      checked: rows.length,
      latest_elementor_free: latest.free,
      sites: rows,
    };
  },
});
