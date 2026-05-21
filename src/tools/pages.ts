import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import { parseElementorData, summarize, serializeElementorData, findReplaceInWidgets } from "../elementor/data-parser.js";
import { backupElementorData, flushElementorCSS } from "../elementor/safety.js";
import { issueConfirmation, consumeConfirmation } from "../utils/confirmation.js";
import { loadConfig } from "../config.js";

export const listElementorPagesTool = defineTool({
  name: "list_elementor_pages",
  description: "List pages on a site that are built with Elementor (i.e. have _elementor_edit_mode = 'builder'). Returns id, title, slug, status, modified date.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    per_page: z.number().int().min(1).max(100).default(25),
    search: z.string().optional(),
  }),
  outputSchema: z.object({
    total: z.number(),
    pages: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        slug: z.string(),
        status: z.string(),
        link: z.string(),
        modified: z.string(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    interface RawPage {
      id: number;
      title: { rendered: string };
      slug: string;
      status: string;
      link: string;
      modified: string;
      meta?: Record<string, unknown>;
    }
    const pages = await wpRequest<RawPage[]>("/wp/v2/pages", {
      siteId: input.site_id,
      query: {
        per_page: input.per_page,
        search: input.search,
        meta_key: "_elementor_edit_mode",
        meta_value: "builder",
        context: "edit",
        _fields: "id,title,slug,status,link,modified",
      },
    });
    return {
      total: pages.length,
      pages: pages.map((p) => ({
        id: p.id,
        title: p.title.rendered,
        slug: p.slug,
        status: p.status,
        link: p.link,
        modified: p.modified,
      })),
    };
  },
});

export const readPageElementorTool = defineTool({
  name: "read_page_elementor",
  description: "Fetch the raw _elementor_data of a page and return a structured summary (counts by widget type, depth, total elements). Optionally returns the full parsed tree (verbose=true) which may be very large.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    verbose: z.boolean().default(false).describe("If true, return the entire parsed Elementor data tree (can be MBs)."),
  }),
  outputSchema: z.object({
    page_id: z.number(),
    title: z.string(),
    summary: z.object({
      totalElements: z.number(),
      sections: z.number(),
      containers: z.number(),
      columns: z.number(),
      widgets: z.number(),
      maxDepth: z.number(),
      byWidgetType: z.record(z.number()),
    }),
    data: z.array(z.any()).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const page = await wpRequest<{ id: number; title: { rendered: string }; meta?: Record<string, unknown> }>(
      `/wp/v2/pages/${input.page_id}?context=edit`,
      { siteId: input.site_id },
    );
    const raw = (page.meta?._elementor_data as string) ?? "[]";
    const data = parseElementorData(raw);
    const summary = summarize(data);
    return {
      page_id: page.id,
      title: page.title.rendered,
      summary,
      data: input.verbose ? data : undefined,
    };
  },
});

export const findReplaceTool = defineTool({
  name: "elementor_find_replace",
  description: "Find/replace plain text in every widget's settings on a single page. TWO-CALL DESTRUCTIVE FLOW: first call without `confirmation` performs a dry-run and returns a confirmation token + match count. Second call with the token actually applies the change after backing up the page's elementor data.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    find: z.string().min(1),
    replace: z.string(),
    widget_type: z.string().optional().describe("Restrict to one widget type, e.g. 'heading'."),
    case_sensitive: z.boolean().default(false),
    confirmation: z.string().optional().describe("Token returned from the dry-run call."),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    page_id: z.number(),
    match_count: z.number(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
    backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const cfg = loadConfig();
    // Always do the dry-run first to get the count
    const page = await wpRequest<{ id: number; title: { rendered: string }; meta?: Record<string, unknown> }>(
      `/wp/v2/pages/${input.page_id}?context=edit`,
      { siteId: input.site_id },
    );
    const raw = (page.meta?._elementor_data as string) ?? "[]";
    const data = parseElementorData(raw);
    const dry = findReplaceInWidgets(JSON.parse(JSON.stringify(data)), input.find, input.replace, {
      widgetType: input.widget_type,
      caseSensitive: input.case_sensitive,
    });

    if (!input.confirmation) {
      if (dry.replacementCount === 0) {
        return { mode: "dry_run" as const, page_id: input.page_id, match_count: 0 };
      }
      const token = issueConfirmation(
        "elementor_find_replace",
        { page_id: input.page_id, find: input.find, replace: input.replace },
        cfg.confirmation_ttl_seconds,
      );
      return {
        mode: "dry_run" as const,
        page_id: input.page_id,
        match_count: dry.replacementCount,
        confirmation_token: token,
        expires_in_seconds: cfg.confirmation_ttl_seconds,
      };
    }

    // Actually apply
    const conf = consumeConfirmation(input.confirmation, "elementor_find_replace");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const original = conf.payload as { page_id: number; find: string; replace: string };
    if (original.page_id !== input.page_id || original.find !== input.find || original.replace !== input.replace) {
      throw new Error("Confirmation parameters don't match the original dry-run");
    }

    // Backup first
    const backup = await backupElementorData(input.site_id, input.page_id);
    // Apply on a fresh copy
    const applied = findReplaceInWidgets(parseElementorData(raw), input.find, input.replace, {
      widgetType: input.widget_type,
      caseSensitive: input.case_sensitive,
    });
    await wpRequest(`/wp/v2/pages/${input.page_id}`, {
      siteId: input.site_id,
      method: "PUT",
      body: { meta: { _elementor_data: serializeElementorData(applied.data) } },
    });
    const flush = await flushElementorCSS(input.site_id, input.page_id);
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      match_count: applied.replacementCount,
      backup_meta_key: backup.meta_key,
      css_flush: flush.method,
    };
  },
});
