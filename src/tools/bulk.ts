import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import { loadConfig } from "../config.js";
import { parseElementorData, serializeElementorData, findReplaceInWidgets } from "../elementor/data-parser.js";
import { fullBackup, restoreFromFile } from "../elementor/backup.js";
import { flushCSS } from "../elementor/css-flush.js";
import { validateElementorData } from "../elementor/validator.js";
import { POLICIES } from "../elementor/policies.js";
import { issueConfirmation, consumeConfirmation } from "../utils/confirmation.js";

async function listElementorPageIds(siteId: string | undefined): Promise<Array<{ id: number; title: string }>> {
  interface P { id: number; title: { rendered: string } }
  const out: Array<{ id: number; title: string }> = [];
  let page = 1;
  for (;;) {
    const items = await wpRequest<P[]>("/wp/v2/pages", {
      siteId,
      query: {
        meta_key: "_elementor_edit_mode",
        meta_value: "builder",
        context: "edit",
        per_page: 100,
        page,
        _fields: "id,title",
      },
    });
    if (items.length === 0) break;
    out.push(...items.map((p) => ({ id: p.id, title: p.title.rendered })));
    if (items.length < 100) break;
    page++;
    if (page > 50) break; // sanity cap: 5000 pages
  }
  return out;
}

export const bulkFindReplaceSiteTool = defineTool({
  name: "bulk_find_replace_site",
  description: "Find/replace plain text in every Elementor page on a single site. TWO-CALL FLOW: dry-run returns per-page match_count + total + confirmation_token. Apply iterates each page (auto-backup + validate + flush per page). Slower than wp_search_replace but works without SSH and gives per-page granularity.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    find: z.string().min(1),
    replace: z.string(),
    widget_type: z.string().optional(),
    case_sensitive: z.boolean().default(false),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    site_id: z.string(),
    pages_scanned: z.number(),
    total_match_count: z.number(),
    pages_with_matches: z.array(z.object({
      page_id: z.number(),
      title: z.string(),
      match_count: z.number(),
    })),
    pages_applied: z.array(z.object({
      page_id: z.number(),
      backup_meta_key: z.string().optional(),
      css_flush: z.string().optional(),
      mode: z.enum(["applied", "rolled_back", "skipped"]),
      error: z.string().optional(),
    })).optional(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const pages = await listElementorPageIds(input.site_id);
    const matches: Array<{ page_id: number; title: string; match_count: number }> = [];
    for (const p of pages) {
      try {
        const page = await wpRequest<{ meta?: Record<string, unknown> }>(`/wp/v2/pages/${p.id}?context=edit&_fields=meta`, { siteId: input.site_id });
        const v = page.meta?._elementor_data;
        const raw = typeof v === "string" ? v : JSON.stringify(v ?? []);
        const data = parseElementorData(raw);
        const dry = findReplaceInWidgets(JSON.parse(JSON.stringify(data)), input.find, input.replace, {
          widgetType: input.widget_type, caseSensitive: input.case_sensitive,
        });
        if (dry.replacementCount > 0) matches.push({ page_id: p.id, title: p.title, match_count: dry.replacementCount });
      } catch { /* skip pages we can't read */ }
    }
    const total = matches.reduce((s, m) => s + m.match_count, 0);

    if (!input.confirmation) {
      if (total === 0) {
        return {
          mode: "dry_run" as const,
          site_id: loadConfig().default_site_id ?? "default",
          pages_scanned: pages.length,
          total_match_count: 0,
          pages_with_matches: [],
        };
      }
      const token = issueConfirmation("bulk_find_replace_site", { find: input.find, replace: input.replace, page_ids: matches.map((m) => m.page_id) }, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        site_id: input.site_id ?? loadConfig().default_site_id ?? "default",
        pages_scanned: pages.length,
        total_match_count: total,
        pages_with_matches: matches,
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }

    const conf = consumeConfirmation(input.confirmation, "bulk_find_replace_site");
    if (!conf) throw new Error("Invalid or expired confirmation token");

    const applied: Array<{ page_id: number; backup_meta_key?: string; css_flush?: string; mode: "applied" | "rolled_back" | "skipped"; error?: string }> = [];
    for (const m of matches) {
      try {
        const page = await wpRequest<{ meta?: Record<string, unknown> }>(`/wp/v2/pages/${m.page_id}?context=edit&_fields=meta`, { siteId: input.site_id });
        const v = page.meta?._elementor_data;
        const raw = typeof v === "string" ? v : JSON.stringify(v ?? []);
        const data = parseElementorData(raw);
        findReplaceInWidgets(data, input.find, input.replace, { widgetType: input.widget_type, caseSensitive: input.case_sensitive });
        const ser = serializeElementorData(data);
        const validation = validateElementorData(ser);
        if (!validation.valid) {
          applied.push({ page_id: m.page_id, mode: "rolled_back", error: validation.errors.join("; ") });
          continue;
        }
        const backup = await fullBackup(input.site_id, m.page_id);
        await wpRequest(`/wp/v2/pages/${m.page_id}`, {
          siteId: input.site_id, method: "PUT",
          body: { meta: { _elementor_data: ser } },
        });
        const flush = await flushCSS(input.site_id, m.page_id);
        applied.push({ page_id: m.page_id, backup_meta_key: backup.meta_key, css_flush: flush.method, mode: "applied" });
      } catch (e) {
        applied.push({ page_id: m.page_id, mode: "skipped", error: (e as Error).message });
      }
    }
    return {
      mode: "applied" as const,
      site_id: input.site_id ?? loadConfig().default_site_id ?? "default",
      pages_scanned: pages.length,
      total_match_count: total,
      pages_with_matches: matches,
      pages_applied: applied,
    };
  },
});

export const fleetFindReplaceTool = defineTool({
  name: "fleet_find_replace",
  description: "Find/replace plain text across every Elementor page of every site in the pool. Same flow as bulk_find_replace_site but iterates across sites. Returns per-site + grand-total summary. Dry-run first; second call applies. Use sparingly — this is the nuclear option.",
  inputSchema: z.object({
    find: z.string().min(1),
    replace: z.string(),
    site_ids: z.array(z.string()).optional().describe("Subset of sites to hit. Defaults to all."),
    widget_type: z.string().optional(),
    case_sensitive: z.boolean().default(false),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    sites_scanned: z.number(),
    total_match_count: z.number(),
    by_site: z.array(z.object({
      site_id: z.string(),
      url: z.string(),
      pages_scanned: z.number(),
      matches: z.number(),
      error: z.string().optional(),
    })),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const cfg = loadConfig();
    const targets = input.site_ids ? cfg.sites.filter((s) => input.site_ids?.includes(s.id)) : cfg.sites;
    const by_site: Array<{ site_id: string; url: string; pages_scanned: number; matches: number; error?: string }> = [];
    let total = 0;

    for (const site of targets) {
      try {
        const pages = await listElementorPageIds(site.id);
        let siteMatches = 0;
        for (const p of pages) {
          try {
            const page = await wpRequest<{ meta?: Record<string, unknown> }>(`/wp/v2/pages/${p.id}?context=edit&_fields=meta`, { siteId: site.id });
            const v = page.meta?._elementor_data;
            const raw = typeof v === "string" ? v : JSON.stringify(v ?? []);
            const data = parseElementorData(raw);
            const dry = findReplaceInWidgets(JSON.parse(JSON.stringify(data)), input.find, input.replace, {
              widgetType: input.widget_type, caseSensitive: input.case_sensitive,
            });
            siteMatches += dry.replacementCount;
          } catch { /* skip */ }
        }
        by_site.push({ site_id: site.id, url: site.url, pages_scanned: pages.length, matches: siteMatches });
        total += siteMatches;
      } catch (e) {
        by_site.push({ site_id: site.id, url: site.url, pages_scanned: 0, matches: 0, error: (e as Error).message });
      }
    }

    if (!input.confirmation) {
      if (total === 0) {
        return {
          mode: "dry_run" as const,
          sites_scanned: by_site.length,
          total_match_count: 0,
          by_site,
        };
      }
      const token = issueConfirmation("fleet_find_replace", { find: input.find, replace: input.replace }, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        sites_scanned: by_site.length,
        total_match_count: total,
        by_site,
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }

    const conf = consumeConfirmation(input.confirmation, "fleet_find_replace");
    if (!conf) throw new Error("Invalid or expired confirmation token");

    // Re-apply per site (sequentially — could parallelize later, but parallel writes across the fleet are scary)
    for (const site of targets) {
      const pages = await listElementorPageIds(site.id);
      for (const p of pages) {
        try {
          const page = await wpRequest<{ meta?: Record<string, unknown> }>(`/wp/v2/pages/${p.id}?context=edit&_fields=meta`, { siteId: site.id });
          const v = page.meta?._elementor_data;
          const raw = typeof v === "string" ? v : JSON.stringify(v ?? []);
          const data = parseElementorData(raw);
          const r = findReplaceInWidgets(data, input.find, input.replace, { widgetType: input.widget_type, caseSensitive: input.case_sensitive });
          if (r.replacementCount === 0) continue;
          const ser = serializeElementorData(data);
          const validation = validateElementorData(ser);
          if (!validation.valid) continue;
          await fullBackup(site.id, p.id);
          await wpRequest(`/wp/v2/pages/${p.id}`, {
            siteId: site.id, method: "PUT",
            body: { meta: { _elementor_data: ser } },
          });
          await flushCSS(site.id, p.id);
        } catch { /* skip */ }
      }
    }

    return {
      mode: "applied" as const,
      sites_scanned: by_site.length,
      total_match_count: total,
      by_site,
    };
  },
});

export const restoreFromFileTool = defineTool({
  name: "restore_from_file",
  description: "Restore a page from a JSON backup file (created by ANY earlier op with backup_to_file=true or by direct fullBackup with to_file). Requires the file_path returned by that backup. Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    file_path: z.string().min(1),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "restored"]),
    page_id: z.number(),
    file_path: z.string(),
    method: z.enum(["wp-cli", "rest"]).optional(),
    pre_restore_backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
    confirmation_token: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("restore_from_file", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        page_id: input.page_id,
        file_path: input.file_path,
        confirmation_token: token,
      };
    }
    const conf = consumeConfirmation(input.confirmation, "restore_from_file");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const pre = await fullBackup(input.site_id, input.page_id);
    const r = await restoreFromFile(input.site_id, input.page_id, input.file_path);
    const flush = await flushCSS(input.site_id, input.page_id);
    return {
      mode: "restored" as const,
      page_id: input.page_id,
      file_path: input.file_path,
      method: r.method,
      pre_restore_backup_meta_key: pre.meta_key,
      css_flush: flush.method,
    };
  },
});
