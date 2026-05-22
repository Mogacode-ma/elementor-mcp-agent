import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import {
  parseElementorData,
  summarize,
  serializeElementorData,
  findReplaceInWidgets,
  walkElements,
  findElementById,
} from "../elementor/data-parser.js";
import { fullBackup, listBackups, restoreBackup } from "../elementor/backup.js";
import { flushCSS } from "../elementor/css-flush.js";
import { validateElementorData } from "../elementor/validator.js";
import { listGlobalWidgets, findGlobalReferences } from "../elementor/globals.js";
import { issueConfirmation, consumeConfirmation } from "../utils/confirmation.js";
import { POLICIES } from "../elementor/policies.js";

export const listElementorPagesTool = defineTool({
  name: "list_elementor_pages",
  description: "List pages built with Elementor (have _elementor_edit_mode = 'builder'). Returns id, title, slug, status, modified date.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    per_page: z.number().int().min(1).max(100).default(25),
    search: z.string().optional(),
  }),
  outputSchema: z.object({
    total: z.number(),
    pages: z.array(z.object({
      id: z.number(), title: z.string(), slug: z.string(), status: z.string(),
      link: z.string(), modified: z.string(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    interface RawPage { id: number; title: { rendered: string }; slug: string; status: string; link: string; modified: string; }
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
        id: p.id, title: p.title.rendered, slug: p.slug,
        status: p.status, link: p.link, modified: p.modified,
      })),
    };
  },
});

export const readPageElementorTool = defineTool({
  name: "read_page_elementor",
  description: "Fetch a page's Elementor data structure summary. With verbose=true returns the full parsed tree (potentially MBs).",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    verbose: z.boolean().default(false),
  }),
  outputSchema: z.object({
    page_id: z.number(),
    title: z.string(),
    summary: z.object({
      totalElements: z.number(), sections: z.number(), containers: z.number(),
      columns: z.number(), widgets: z.number(), maxDepth: z.number(),
      byWidgetType: z.record(z.number()),
    }),
    global_references: z.array(z.object({ widget_id: z.string(), template_id: z.number() })),
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
    return {
      page_id: page.id,
      title: page.title.rendered,
      summary: summarize(data),
      global_references: findGlobalReferences(raw),
      data: input.verbose ? data : undefined,
    };
  },
});

export const listWidgetsInPageTool = defineTool({
  name: "list_widgets_in_page",
  description: "Flat list of every widget in a page with id, type, parent path, and an excerpt of the first text setting (for spot-checking before find/replace).",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_type: z.string().optional(),
  }),
  outputSchema: z.object({
    page_id: z.number(),
    total: z.number(),
    widgets: z.array(z.object({
      widget_id: z.string(),
      widget_type: z.string(),
      path: z.array(z.string()),
      excerpt: z.string().optional(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const page = await wpRequest<{ id: number; meta?: Record<string, unknown> }>(
      `/wp/v2/pages/${input.page_id}?context=edit&_fields=id,meta`,
      { siteId: input.site_id },
    );
    const data = parseElementorData((page.meta?._elementor_data as string) ?? "[]");
    const widgets: Array<{ widget_id: string; widget_type: string; path: string[]; excerpt?: string }> = [];
    for (const { element, path } of walkElements(data)) {
      if (element.elType !== "widget") continue;
      if (input.widget_type && element.widgetType !== input.widget_type) continue;
      // First string field as excerpt
      let excerpt: string | undefined;
      for (const v of Object.values(element.settings ?? {})) {
        if (typeof v === "string" && v.length > 0) {
          excerpt = v.replace(/<[^>]+>/g, "").slice(0, 80);
          break;
        }
      }
      widgets.push({
        widget_id: element.id,
        widget_type: element.widgetType ?? "unknown",
        path: path.slice(0, -1),
        excerpt,
      });
    }
    return { page_id: page.id, total: widgets.length, widgets };
  },
});

export const listGlobalWidgetsTool = defineTool({
  name: "list_global_widgets",
  description: "List all global widgets on a site (Elementor library entries of type 'widget'). These are shared across pages — editing one affects every page using it.",
  inputSchema: z.object({ site_id: z.string().optional() }),
  outputSchema: z.object({
    total: z.number(),
    globals: z.array(z.object({
      template_id: z.number(),
      title: z.string(),
      widget_type: z.string().optional(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const globals = await listGlobalWidgets(input.site_id);
    return { total: globals.length, globals };
  },
});

export const preflightCheckTool = defineTool({
  name: "preflight_check",
  description: "Validate a page is safe to edit. Checks: page exists, is Elementor-built, data parses cleanly, references valid global widgets, isn't currently locked by another editor.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
  }),
  outputSchema: z.object({
    safe_to_edit: z.boolean(),
    page_id: z.number(),
    title: z.string(),
    issues: z.array(z.string()),
    warnings: z.array(z.string()),
    data_bytes: z.number(),
    global_widget_references: z.number(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const issues: string[] = [];
    const warnings: string[] = [];
    let title = "";
    let data_bytes = 0;
    let global_widget_references = 0;
    try {
      const page = await wpRequest<{ id: number; title: { rendered: string }; meta?: Record<string, unknown> }>(
        `/wp/v2/pages/${input.page_id}?context=edit`,
        { siteId: input.site_id },
      );
      title = page.title.rendered;
      const raw = (page.meta?._elementor_data as string) ?? "[]";
      data_bytes = raw.length;
      if ((page.meta?._elementor_edit_mode as string) !== "builder") {
        issues.push("Page is not in Elementor builder mode");
      }
      const v = validateElementorData(raw);
      if (!v.valid) issues.push(...v.errors);
      warnings.push(...v.warnings);
      global_widget_references = findGlobalReferences(raw).length;
      if (global_widget_references > 0) {
        warnings.push(`Page references ${global_widget_references} global widget(s). Edits via find_replace will NOT affect the globals themselves — modify the global template directly if needed.`);
      }
      if (data_bytes > POLICIES.MAX_ELEMENTOR_DATA_BYTES) {
        issues.push(`Elementor data exceeds policy max (${POLICIES.MAX_ELEMENTOR_DATA_BYTES} bytes)`);
      }
    } catch (e) {
      issues.push(`Cannot fetch page: ${(e as Error).message}`);
    }
    return { safe_to_edit: issues.length === 0, page_id: input.page_id, title, issues, warnings, data_bytes, global_widget_references };
  },
});

export const findReplaceTool = defineTool({
  name: "elementor_find_replace",
  description: "Find/replace plain text in every widget on one page. TWO-CALL FLOW: dry-run returns match_count + detailed widget hits + confirmation_token. Second call with token applies the change with auto-backup + JSON validation + auto-rollback if validation fails + CSS flush.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    find: z.string().min(1),
    replace: z.string(),
    widget_type: z.string().optional(),
    case_sensitive: z.boolean().default(false),
    backup_to_file: z.boolean().default(false).describe("Also dump backup to /tmp/elementor-mcp-backups/"),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied", "rolled_back"]),
    page_id: z.number(),
    match_count: z.number(),
    affected_widgets: z.array(z.object({
      widget_id: z.string(),
      widget_type: z.string(),
      before: z.string(),
      after: z.string(),
    })).optional(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
    backup_meta_key: z.string().optional(),
    backup_file: z.string().optional(),
    css_flush: z.string().optional(),
    validation_error: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const page = await wpRequest<{ id: number; meta?: Record<string, unknown> }>(
      `/wp/v2/pages/${input.page_id}?context=edit&_fields=id,meta`,
      { siteId: input.site_id },
    );
    const raw = (page.meta?._elementor_data as string) ?? "[]";
    // Dry run on a deep copy
    const dryData = parseElementorData(raw);
    const dry = findReplaceInWidgets(JSON.parse(JSON.stringify(dryData)), input.find, input.replace, {
      widgetType: input.widget_type,
      caseSensitive: input.case_sensitive,
    });

    // Enrich dry-run: collect affected widgets with before/after excerpts
    const affected: Array<{ widget_id: string; widget_type: string; before: string; after: string }> = [];
    const beforeData = parseElementorData(raw);
    const afterCopy = JSON.parse(JSON.stringify(beforeData));
    findReplaceInWidgets(afterCopy, input.find, input.replace, {
      widgetType: input.widget_type, caseSensitive: input.case_sensitive,
    });
    function collectAffected(orig: ReturnType<typeof parseElementorData>, modified: ReturnType<typeof parseElementorData>): void {
      const beforeMap = new Map<string, { type: string; first: string }>();
      for (const { element } of walkElements(orig)) {
        if (element.elType !== "widget") continue;
        const firstStr = Object.values(element.settings ?? {}).find((v) => typeof v === "string") as string | undefined;
        if (firstStr) beforeMap.set(element.id, { type: element.widgetType ?? "?", first: firstStr });
      }
      for (const { element } of walkElements(modified)) {
        if (element.elType !== "widget") continue;
        const firstStr = Object.values(element.settings ?? {}).find((v) => typeof v === "string") as string | undefined;
        const b = beforeMap.get(element.id);
        if (b && firstStr && b.first !== firstStr) {
          affected.push({
            widget_id: element.id,
            widget_type: element.widgetType ?? "?",
            before: b.first.slice(0, 120),
            after: firstStr.slice(0, 120),
          });
        }
      }
    }
    collectAffected(beforeData, afterCopy);

    if (!input.confirmation) {
      if (dry.replacementCount === 0) {
        return {
          mode: "dry_run" as const,
          page_id: input.page_id,
          match_count: 0,
          affected_widgets: [],
        };
      }
      const token = issueConfirmation(
        "elementor_find_replace",
        { page_id: input.page_id, find: input.find, replace: input.replace },
        POLICIES.CONFIRMATION_TTL_SECONDS,
      );
      return {
        mode: "dry_run" as const,
        page_id: input.page_id,
        match_count: dry.replacementCount,
        affected_widgets: affected.slice(0, 25),
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }

    // Apply
    const conf = consumeConfirmation(input.confirmation, "elementor_find_replace");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const o = conf.payload as { page_id: number; find: string; replace: string };
    if (o.page_id !== input.page_id || o.find !== input.find || o.replace !== input.replace) {
      throw new Error("Confirmation parameters don't match the original dry-run");
    }

    const backup = await fullBackup(input.site_id, input.page_id, { to_file: input.backup_to_file });
    const newData = parseElementorData(raw);
    findReplaceInWidgets(newData, input.find, input.replace, {
      widgetType: input.widget_type, caseSensitive: input.case_sensitive,
    });
    const serialized = serializeElementorData(newData);

    // Validate before write
    const validation = validateElementorData(serialized);
    if (!validation.valid) {
      return {
        mode: "rolled_back" as const,
        page_id: input.page_id,
        match_count: dry.replacementCount,
        affected_widgets: affected.slice(0, 25),
        backup_meta_key: backup.meta_key,
        validation_error: validation.errors.join("; "),
      };
    }

    await wpRequest(`/wp/v2/pages/${input.page_id}`, {
      siteId: input.site_id,
      method: "PUT",
      body: { meta: { _elementor_data: serialized } },
    });
    const flush = POLICIES.FLUSH_CSS_AFTER_WRITE ? await flushCSS(input.site_id, input.page_id) : { method: "none" as const };
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      match_count: dry.replacementCount,
      affected_widgets: affected.slice(0, 25),
      backup_meta_key: backup.meta_key,
      backup_file: backup.file_path,
      css_flush: flush.method,
    };
  },
});

export const listElementorBackupsTool = defineTool({
  name: "list_elementor_backups",
  description: "List timestamped backups of a page's Elementor data (created by previous edit ops). Use restore_elementor_backup with one of these meta keys to roll back.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
  }),
  outputSchema: z.object({
    page_id: z.number(),
    total: z.number(),
    backups: z.array(z.object({
      meta_key: z.string(),
      settings_key: z.string().optional(),
      timestamp: z.string(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const backups = await listBackups(input.site_id, input.page_id);
    return {
      page_id: input.page_id,
      total: backups.length,
      backups,
    };
  },
});

export const restoreElementorBackupTool = defineTool({
  name: "restore_elementor_backup",
  description: "Restore a page's _elementor_data and _elementor_page_settings from a backup created by a previous edit. TWO-CALL FLOW with confirmation token.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    backup_meta_key: z.string().describe("From list_elementor_backups."),
    settings_meta_key: z.string().optional(),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "restored"]),
    page_id: z.number(),
    backup_meta_key: z.string(),
    settings_meta_key: z.string().optional(),
    confirmation_token: z.string().optional(),
    expires_in_seconds: z.number().optional(),
    css_flush: z.string().optional(),
    pre_restore_backup_meta_key: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("restore_elementor_backup", {
        page_id: input.page_id, backup_meta_key: input.backup_meta_key,
      }, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        page_id: input.page_id,
        backup_meta_key: input.backup_meta_key,
        settings_meta_key: input.settings_meta_key,
        confirmation_token: token,
        expires_in_seconds: POLICIES.CONFIRMATION_TTL_SECONDS,
      };
    }
    const conf = consumeConfirmation(input.confirmation, "restore_elementor_backup");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    // Snapshot current state before restoring
    const pre = await fullBackup(input.site_id, input.page_id);
    await restoreBackup(input.site_id, input.page_id, input.backup_meta_key, input.settings_meta_key);
    const flush = await flushCSS(input.site_id, input.page_id);
    return {
      mode: "restored" as const,
      page_id: input.page_id,
      backup_meta_key: input.backup_meta_key,
      settings_meta_key: input.settings_meta_key,
      css_flush: flush.method,
      pre_restore_backup_meta_key: pre.meta_key,
    };
  },
});

export const duplicateElementorPageTool = defineTool({
  name: "duplicate_elementor_page",
  description: "Duplicate an Elementor page within the same site. Creates a new draft page, copies _elementor_data + _elementor_page_settings + _elementor_edit_mode, flushes CSS.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    source_page_id: z.number().int().positive(),
    new_title: z.string().optional().describe("Defaults to '<original> (Copy)'"),
    status: z.enum(["draft", "publish", "private"]).default("draft"),
  }),
  outputSchema: z.object({
    new_page_id: z.number(),
    new_page_url: z.string(),
    source_page_id: z.number(),
    title: z.string(),
    status: z.string(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    const source = await wpRequest<{ id: number; title: { rendered: string }; meta?: Record<string, unknown> }>(
      `/wp/v2/pages/${input.source_page_id}?context=edit`,
      { siteId: input.site_id },
    );
    const title = input.new_title ?? `${source.title.rendered} (Copy)`;
    const data_raw = (source.meta?._elementor_data as string) ?? "[]";
    const settings_raw = (source.meta?._elementor_page_settings as string) ?? "{}";
    const created = await wpRequest<{ id: number; link: string }>("/wp/v2/pages", {
      siteId: input.site_id,
      method: "POST",
      body: {
        title,
        status: input.status,
        meta: {
          _elementor_data: data_raw,
          _elementor_page_settings: parseSettingsForRest(settings_raw),
          _elementor_edit_mode: "builder",
        },
      },
    });
    const flush = await flushCSS(input.site_id, created.id);
    return {
      new_page_id: created.id,
      new_page_url: created.link,
      source_page_id: input.source_page_id,
      title,
      status: input.status,
      css_flush: flush.method,
    };
  },
});

// re-export helper not used here directly but consumed elsewhere
export { findElementById };

/**
 * The WP REST API expects _elementor_page_settings as an object, not a JSON-encoded string.
 * Parse it if it looks like JSON; fall back to empty object on parse failure.
 */
function parseSettingsForRest(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}
