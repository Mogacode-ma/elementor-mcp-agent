import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import { parseElementorData, summarize, serializeElementorData } from "../elementor/data-parser.js";

const TEMPLATE_TYPES = ["section", "page", "popup", "header", "footer", "archive", "single", "widget", "any"] as const;

export const listTemplatesTool = defineTool({
  name: "list_elementor_templates",
  description: "List Elementor library entries on a site: saved sections, pages, popups, headers/footers (Theme Builder Pro), single/archive templates (Theme Builder Pro), and global widgets. Type filter narrows results.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    type: z.enum(TEMPLATE_TYPES).default("any"),
    per_page: z.number().int().min(1).max(100).default(50),
  }),
  outputSchema: z.object({
    total: z.number(),
    templates: z.array(z.object({
      id: z.number(),
      title: z.string(),
      type: z.string(),
      is_theme_builder: z.boolean(),
      display_conditions_count: z.number(),
      modified: z.string(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const query: Record<string, string | number> = {
      per_page: input.per_page, context: "edit",
      _fields: "id,title,modified,meta",
    };
    interface RawTpl {
      id: number;
      title: { rendered: string };
      modified: string;
      meta?: { _elementor_template_type?: string; _elementor_conditions?: string };
    }
    const allItems = await wpRequest<RawTpl[]>("/wp/v2/elementor_library", { siteId: input.site_id, query });
    // Filter client-side — REST won't reliably filter on unregistered meta keys
    const items = input.type === "any"
      ? allItems
      : allItems.filter((t) => t.meta?._elementor_template_type === input.type);
    const themeBuilderTypes = new Set(["header", "footer", "archive", "single"]);
    return {
      total: items.length,
      templates: items.map((t) => {
        const type = t.meta?._elementor_template_type ?? "unknown";
        let conds = 0;
        try {
          const c = t.meta?._elementor_conditions;
          if (typeof c === "string") conds = (JSON.parse(c) as unknown[]).length;
          else if (Array.isArray(c)) conds = (c as unknown[]).length;
        } catch { /* ignore */ }
        return {
          id: t.id,
          title: t.title.rendered,
          type,
          is_theme_builder: themeBuilderTypes.has(type),
          display_conditions_count: conds,
          modified: t.modified,
        };
      }),
    };
  },
});

export const exportTemplateTool = defineTool({
  name: "export_elementor_template",
  description: "Export an Elementor template (section, page, header, footer, etc.) as a portable JSON object. Output goes into import_elementor_template on another site.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    template_id: z.number().int().positive(),
  }),
  outputSchema: z.object({
    template_id: z.number(),
    title: z.string(),
    type: z.string(),
    summary: z.object({ totalElements: z.number(), widgets: z.number(), sections: z.number() }),
    portable_json: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const tpl = await wpRequest<{
      id: number;
      title: { rendered: string };
      meta?: { _elementor_template_type?: string; _elementor_data?: string };
    }>(`/wp/v2/elementor_library/${input.template_id}?context=edit`, { siteId: input.site_id });
    const data = parseElementorData(tpl.meta?._elementor_data ?? "[]");
    const sum = summarize(data);
    const portable = {
      version: "0.4",
      title: tpl.title.rendered,
      type: tpl.meta?._elementor_template_type ?? "page",
      content: data,
    };
    return {
      template_id: tpl.id,
      title: tpl.title.rendered,
      type: tpl.meta?._elementor_template_type ?? "unknown",
      summary: { totalElements: sum.totalElements, widgets: sum.widgets, sections: sum.sections },
      portable_json: JSON.stringify(portable),
    };
  },
});

export const importTemplateTool = defineTool({
  name: "import_elementor_template",
  description: "Import a portable template JSON (output of export_elementor_template) into a target site as a new library entry. Useful for cross-site template sync.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    portable_json: z.string(),
    override_title: z.string().optional(),
  }),
  outputSchema: z.object({
    new_template_id: z.number(),
    title: z.string(),
    type: z.string(),
    url: z.string(),
  }),
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    let payload: { title: string; type: string; content: unknown };
    try { payload = JSON.parse(input.portable_json); }
    catch (e) { throw new Error("portable_json is not valid JSON: " + (e as Error).message); }
    const title = input.override_title ?? payload.title;
    const data = Array.isArray(payload.content) ? payload.content : parseElementorData(payload.content as string);
    const res = await wpRequest<{ id: number; link: string }>(`/wp/v2/elementor_library`, {
      siteId: input.site_id, method: "POST",
      body: {
        title, status: "publish",
        meta: {
          _elementor_template_type: payload.type,
          _elementor_data: serializeElementorData(data),
          _elementor_edit_mode: "builder",
        },
      },
    });
    return { new_template_id: res.id, title, type: payload.type, url: res.link };
  },
});

export const applyTemplateToPageTool = defineTool({
  name: "apply_template_to_page",
  description: "Copy the _elementor_data + _elementor_page_settings of a SOURCE template (or page) onto a TARGET page on the same site. Backs up the target first. Use to apply a section/page template to an existing draft.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    source_id: z.number().int().positive().describe("Source post id: a template or a page."),
    target_page_id: z.number().int().positive(),
    backup_to_file: z.boolean().default(false),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    target_page_id: z.number(),
    source_id: z.number(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
    backup_meta_key: z.string().optional(),
    backup_file: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const { issueConfirmation, consumeConfirmation } = await import("../utils/confirmation.js");
    const { POLICIES } = await import("../elementor/policies.js");
    const { fullBackup } = await import("../elementor/backup.js");
    const { flushCSS } = await import("../elementor/css-flush.js");

    if (!input.confirmation) {
      const token = issueConfirmation("apply_template_to_page", { src: input.source_id, tgt: input.target_page_id, site: input.site_id }, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        target_page_id: input.target_page_id,
        source_id: input.source_id,
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }
    const conf = consumeConfirmation(input.confirmation, "apply_template_to_page");
    if (!conf) throw new Error("Invalid or expired confirmation token");

    // Read source (try elementor_library first, fallback to pages)
    let src_meta: Record<string, unknown> | undefined;
    try {
      const src = await wpRequest<{ meta?: Record<string, unknown> }>(`/wp/v2/elementor_library/${input.source_id}?context=edit`, { siteId: input.site_id });
      src_meta = src.meta;
    } catch {
      const src = await wpRequest<{ meta?: Record<string, unknown> }>(`/wp/v2/pages/${input.source_id}?context=edit`, { siteId: input.site_id });
      src_meta = src.meta;
    }
    const data_raw = (src_meta?._elementor_data as string) ?? "[]";
    const settings_raw = (src_meta?._elementor_page_settings as string) ?? "{}";

    // Backup target
    const backup = await fullBackup(input.site_id, input.target_page_id, { to_file: input.backup_to_file });
    // Apply
    await wpRequest(`/wp/v2/pages/${input.target_page_id}`, {
      siteId: input.site_id, method: "PUT",
      body: {
        meta: {
          _elementor_data: data_raw,
          _elementor_page_settings: parseSettingsForRest(settings_raw),
          _elementor_edit_mode: "builder",
        },
      },
    });
    const flush = await flushCSS(input.site_id, input.target_page_id);
    return {
      mode: "applied" as const,
      target_page_id: input.target_page_id,
      source_id: input.source_id,
      backup_meta_key: backup.meta_key,
      backup_file: backup.file_path,
      css_flush: flush.method,
    };
  },
});

function parseSettingsForRest(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}
