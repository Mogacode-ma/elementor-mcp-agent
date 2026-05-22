import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import { loadConfig } from "../config.js";

async function fetchLatestElementor(): Promise<{ free: string }> {
  try {
    const free = await fetch("https://api.wordpress.org/plugins/info/1.0/elementor.json", {
      headers: { "User-Agent": "elementor-mcp-agent" },
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
    return { free: (free.version as string) ?? "unknown" };
  } catch { return { free: "unknown" }; }
}

export const checkElementorVersionsTool = defineTool({
  name: "check_elementor_versions",
  description: "Fleet-wide Elementor version audit. For every site, fetches installed Elementor/Pro versions and compares against wordpress.org latest. Flags outdated installs.",
  inputSchema: z.object({
    site_ids: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    checked: z.number(),
    latest_elementor_free: z.string(),
    sites: z.array(z.object({
      site_id: z.string(),
      url: z.string(),
      elementor_version: z.string().optional(),
      elementor_pro_version: z.string().optional(),
      outdated_free: z.boolean(),
      error: z.string().optional(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const cfg = loadConfig();
    const latest = await fetchLatestElementor();
    const targets = input.site_ids ? cfg.sites.filter((s) => input.site_ids?.includes(s.id)) : cfg.sites;
    const rows: Array<{
      site_id: string; url: string;
      elementor_version?: string; elementor_pro_version?: string;
      outdated_free: boolean; error?: string;
    }> = [];
    for (const site of targets) {
      try {
        const plugins = await wpRequest<Array<{ plugin: string; version: string }>>("/wp/v2/plugins", { siteId: site.id });
        let elementor_version: string | undefined;
        let elementor_pro_version: string | undefined;
        for (const p of plugins) {
          if (p.plugin.startsWith("elementor/") && p.plugin.endsWith("/elementor.php")) elementor_version = p.version;
          if (p.plugin.startsWith("elementor-pro/")) elementor_pro_version = p.version;
        }
        rows.push({
          site_id: site.id, url: site.url,
          elementor_version, elementor_pro_version,
          outdated_free: !!elementor_version && elementor_version !== latest.free && latest.free !== "unknown",
        });
      } catch (e) {
        rows.push({ site_id: site.id, url: site.url, outdated_free: false, error: (e as Error).message });
      }
    }
    return { checked: rows.length, latest_elementor_free: latest.free, sites: rows };
  },
});
