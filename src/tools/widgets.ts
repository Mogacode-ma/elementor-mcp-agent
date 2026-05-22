import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import { parseElementorData, serializeElementorData } from "../elementor/data-parser.js";
import {
  readWidget, updateWidgetSettings, deleteWidget, duplicateWidget,
  swapWidgetType, addWidget, moveWidget,
} from "../elementor/widget-ops.js";
import { validateElementorData } from "../elementor/validator.js";
import { fullBackup } from "../elementor/backup.js";
import { flushCSS } from "../elementor/css-flush.js";
import { POLICIES } from "../elementor/policies.js";
import { issueConfirmation, consumeConfirmation } from "../utils/confirmation.js";

async function fetchData(siteId: string | undefined, pageId: number): Promise<{ raw: string; data: ReturnType<typeof parseElementorData> }> {
  const page = await wpRequest<{ meta?: Record<string, unknown> }>(
    `/wp/v2/pages/${pageId}?context=edit&_fields=meta`,
    { siteId },
  );
  const v = page.meta?._elementor_data;
  const raw = typeof v === "string" ? v : JSON.stringify(v ?? []);
  return { raw, data: parseElementorData(raw) };
}

async function writeData(siteId: string | undefined, pageId: number, data: ReturnType<typeof parseElementorData>): Promise<{ method: string }> {
  const ser = serializeElementorData(data);
  const validation = validateElementorData(ser);
  if (!validation.valid) {
    throw new Error("Validation failed after edit: " + validation.errors.join("; "));
  }
  await wpRequest(`/wp/v2/pages/${pageId}`, {
    siteId, method: "PUT",
    body: { meta: { _elementor_data: ser } },
  });
  const flush = await flushCSS(siteId, pageId);
  return { method: flush.method };
}

export const readWidgetTool = defineTool({
  name: "read_widget",
  description: "Fetch a single widget's full settings by id. Use list_widgets_in_page to find the id first.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
  }),
  outputSchema: z.object({
    widget_id: z.string(),
    widget_type: z.string().optional(),
    settings: z.record(z.any()),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const { data } = await fetchData(input.site_id, input.page_id);
    const w = readWidget(data, input.widget_id);
    if (!w) throw new Error(`Widget ${input.widget_id} not found on page ${input.page_id}`);
    return { widget_id: w.id, widget_type: w.widgetType, settings: w.settings as Record<string, unknown> };
  },
});

export const updateWidgetSettingsTool = defineTool({
  name: "update_widget_settings",
  description: "Shallow-merge a partial settings object into one widget. Backs up the page first; validates the result; auto-flushes CSS. Two-call confirmation flow.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    settings_patch: z.record(z.any()),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    page_id: z.number(),
    widget_id: z.string(),
    keys_changed: z.array(z.string()),
    confirmation_token: z.string().optional(),
    backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("update_widget_settings", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return {
        mode: "dry_run" as const,
        page_id: input.page_id,
        widget_id: input.widget_id,
        keys_changed: Object.keys(input.settings_patch),
        confirmation_token: token,
      };
    }
    const conf = consumeConfirmation(input.confirmation, "update_widget_settings");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { data } = await fetchData(input.site_id, input.page_id);
    if (!updateWidgetSettings(data, input.widget_id, input.settings_patch)) {
      throw new Error(`Widget ${input.widget_id} not found`);
    }
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      keys_changed: Object.keys(input.settings_patch),
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
    };
  },
});

export const deleteWidgetTool = defineTool({
  name: "delete_widget",
  description: "Remove a widget from a page by id. Two-call confirmation. Backs up before deleting.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    page_id: z.number(),
    widget_id: z.string(),
    confirmation_token: z.string().optional(),
    backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("delete_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, widget_id: input.widget_id, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "delete_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { data } = await fetchData(input.site_id, input.page_id);
    if (!deleteWidget(data, input.widget_id)) throw new Error(`Widget ${input.widget_id} not found`);
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
    };
  },
});

export const duplicateWidgetTool = defineTool({
  name: "duplicate_widget",
  description: "Duplicate a widget in place (right after the original). The clone gets a new id. Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    page_id: z.number(),
    source_widget_id: z.string(),
    new_widget_id: z.string().optional(),
    confirmation_token: z.string().optional(),
    backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("duplicate_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, source_widget_id: input.widget_id, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "duplicate_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { data } = await fetchData(input.site_id, input.page_id);
    const r = duplicateWidget(data, input.widget_id);
    if (!r.ok) throw new Error(`Widget ${input.widget_id} not found`);
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      source_widget_id: input.widget_id,
      new_widget_id: r.new_widget_id,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
    };
  },
});

export const swapWidgetTypeTool = defineTool({
  name: "swap_widget_type",
  description: "Replace a widget's type (e.g., heading → button) while preserving its position. Provide full new_settings — the old settings are NOT carried over (different widget types have incompatible schemas). Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    new_widget_type: z.string().min(1),
    new_settings: z.record(z.any()).default({}),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    page_id: z.number(),
    widget_id: z.string(),
    new_widget_type: z.string(),
    confirmation_token: z.string().optional(),
    backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("swap_widget_type", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, widget_id: input.widget_id, new_widget_type: input.new_widget_type, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "swap_widget_type");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { data } = await fetchData(input.site_id, input.page_id);
    if (!swapWidgetType(data, input.widget_id, input.new_widget_type, input.new_settings)) {
      throw new Error(`Widget ${input.widget_id} not found`);
    }
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      new_widget_type: input.new_widget_type,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
    };
  },
});

export const addWidgetTool = defineTool({
  name: "add_widget",
  description: "Append a new widget to a parent container (section, column, or container) on a page. Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    parent_id: z.string().min(1).describe("Id of the section/column/container that will receive the widget."),
    widget_type: z.string().min(1).describe("e.g., 'heading', 'text-editor', 'button', 'image'."),
    settings: z.record(z.any()).default({}),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    page_id: z.number(),
    parent_id: z.string(),
    widget_type: z.string(),
    new_widget_id: z.string().optional(),
    confirmation_token: z.string().optional(),
    backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("add_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, parent_id: input.parent_id, widget_type: input.widget_type, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "add_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { data } = await fetchData(input.site_id, input.page_id);
    const r = addWidget(data, input.parent_id, input.widget_type, input.settings);
    if (!r.ok) throw new Error(`Parent ${input.parent_id} not found`);
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      parent_id: input.parent_id,
      widget_type: input.widget_type,
      new_widget_id: r.new_widget_id,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
    };
  },
});

export const moveWidgetTool = defineTool({
  name: "move_widget",
  description: "Move a widget to a different parent (or different position in the same parent). Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    new_parent_id: z.string().min(1),
    position: z.number().int().default(-1).describe("0-based position in the new parent. -1 = append."),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    mode: z.enum(["dry_run", "applied"]),
    page_id: z.number(),
    widget_id: z.string(),
    new_parent_id: z.string(),
    confirmation_token: z.string().optional(),
    backup_meta_key: z.string().optional(),
    css_flush: z.string().optional(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("move_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, widget_id: input.widget_id, new_parent_id: input.new_parent_id, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "move_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { data } = await fetchData(input.site_id, input.page_id);
    if (!moveWidget(data, input.widget_id, input.new_parent_id, input.position)) {
      throw new Error(`Widget or parent not found`);
    }
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      new_parent_id: input.new_parent_id,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
    };
  },
});
