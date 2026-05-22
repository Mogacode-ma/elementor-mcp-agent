import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import {
  parseElementorData,
  serializeElementorData,
  findElementById,
} from "../elementor/data-parser.js";
import {
  readWidget, updateWidgetSettings, deleteWidget, duplicateWidget,
  swapWidgetType, addWidget, moveWidget,
} from "../elementor/widget-ops.js";
import { validateElementorData } from "../elementor/validator.js";
import { fullBackup } from "../elementor/backup.js";
import { flushCSS } from "../elementor/css-flush.js";
import { POLICIES } from "../elementor/policies.js";
import { issueConfirmation, consumeConfirmation } from "../utils/confirmation.js";
import { verifyWrite, deepEqual, VerificationSchema } from "../elementor/verify.js";

/**
 * Shared output contract for every mutating widget tool (v1.2+).
 *
 * Beyond the legacy `mode/page_id/...` fields we keep for compatibility, every
 * `applied` response now includes:
 *
 *  - `verification` — canonical re-read of the page after write + per-op
 *    predicate. `matches_requested: false` means the write API lied
 *    (e.g. REST silently dropped the meta update). The model MUST treat
 *    a falsy `matches_requested` as a hard failure even if the HTTP layer
 *    said OK.
 *  - `mutated` — true iff the serialized `_elementor_data` actually changed.
 *    `false` means the requested op was a no-op (idempotent re-apply, or
 *    silent drop — disambiguated by `verification.matches_requested`).
 *  - `warnings` — non-fatal issues collected during the op (CSS flush
 *    fallback used, SSH stderr noise, etc.). Always an array, never null.
 *  - `backup_meta_key` — postmeta key where the pre-write snapshot lives,
 *    so a model or operator can `restore_elementor_backup` if needed.
 *
 * This contract was prompted by Mads Hansen's comment on the v1.0 write-bug
 * post-mortem: a mutating tool MUST force the model to see ground truth,
 * not the write API's optimistic 200 OK.
 */
const MutationResponseShape = {
  mode: z.enum(["dry_run", "applied"]),
  page_id: z.number(),
  confirmation_token: z.string().optional(),
  backup_meta_key: z.string().optional(),
  css_flush: z.string().optional(),
  mutated: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  verification: VerificationSchema.optional(),
};

async function fetchData(
  siteId: string | undefined,
  pageId: number,
): Promise<{ raw: string; data: ReturnType<typeof parseElementorData> }> {
  const page = await wpRequest<{ meta?: Record<string, unknown> }>(
    `/wp/v2/pages/${pageId}?context=edit&_fields=meta`,
    { siteId },
  );
  const v = page.meta?._elementor_data;
  const raw = typeof v === "string" ? v : JSON.stringify(v ?? []);
  return { raw, data: parseElementorData(raw) };
}

async function writeData(
  siteId: string | undefined,
  pageId: number,
  data: ReturnType<typeof parseElementorData>,
): Promise<{ method: string; serialized: string }> {
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
  return { method: flush.method, serialized: ser };
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
  description: "Shallow-merge a partial settings object into one widget. Backs up the page first, validates the result, auto-flushes CSS, then re-reads the page and verifies the patch persisted (matches_requested in the response). Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    settings_patch: z.record(z.any()),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    ...MutationResponseShape,
    widget_id: z.string(),
    keys_changed: z.array(z.string()),
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
    const { raw: rawBefore, data } = await fetchData(input.site_id, input.page_id);
    if (!updateWidgetSettings(data, input.widget_id, input.settings_patch)) {
      throw new Error(`Widget ${input.widget_id} not found`);
    }
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    const verification = await verifyWrite({
      siteId: input.site_id,
      pageId: input.page_id,
      description: `Re-read /wp/v2/pages/${input.page_id} and check widget ${input.widget_id} settings include the requested patch`,
      predicate: (canonical) => {
        const widget = findElementById(canonical, input.widget_id);
        if (!widget) return { ok: false, notes: "Widget no longer present after write" };
        const persisted = widget.settings as Record<string, unknown>;
        const mismatches: string[] = [];
        for (const [k, want] of Object.entries(input.settings_patch)) {
          if (!deepEqual(persisted[k], want)) mismatches.push(k);
        }
        return {
          ok: mismatches.length === 0,
          persisted,
          notes: mismatches.length === 0
            ? undefined
            : `Persisted state diverges from requested patch on key(s): ${mismatches.join(", ")}`,
        };
      },
    });
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      keys_changed: Object.keys(input.settings_patch),
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
      mutated: rawBefore !== w.serialized,
      warnings: [],
      verification,
    };
  },
});

export const deleteWidgetTool = defineTool({
  name: "delete_widget",
  description: "Remove a widget from a page by id. Two-call confirmation. Backs up before deleting; re-reads to confirm the widget is gone.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    ...MutationResponseShape,
    widget_id: z.string(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("delete_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, widget_id: input.widget_id, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "delete_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { raw: rawBefore, data } = await fetchData(input.site_id, input.page_id);
    if (!deleteWidget(data, input.widget_id)) throw new Error(`Widget ${input.widget_id} not found`);
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    const verification = await verifyWrite({
      siteId: input.site_id,
      pageId: input.page_id,
      description: `Re-read /wp/v2/pages/${input.page_id} and assert widget ${input.widget_id} is gone`,
      predicate: (canonical) => {
        const found = findElementById(canonical, input.widget_id);
        return {
          ok: found === null,
          notes: found ? "Widget still present in canonical re-read — delete did not persist" : undefined,
        };
      },
    });
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
      mutated: rawBefore !== w.serialized,
      warnings: [],
      verification,
    };
  },
});

export const duplicateWidgetTool = defineTool({
  name: "duplicate_widget",
  description: "Duplicate a widget in place (right after the original). The clone gets a new id. Re-reads to confirm the clone persisted. Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    ...MutationResponseShape,
    source_widget_id: z.string(),
    new_widget_id: z.string().optional(),
  }),
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("duplicate_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, source_widget_id: input.widget_id, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "duplicate_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { raw: rawBefore, data } = await fetchData(input.site_id, input.page_id);
    const r = duplicateWidget(data, input.widget_id);
    if (!r.ok || !r.new_widget_id) throw new Error(`Widget ${input.widget_id} not found`);
    const newId = r.new_widget_id;
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    const verification = await verifyWrite({
      siteId: input.site_id,
      pageId: input.page_id,
      description: `Re-read /wp/v2/pages/${input.page_id} and assert the clone (${newId}) exists alongside the source`,
      predicate: (canonical) => {
        const source = findElementById(canonical, input.widget_id);
        const clone = findElementById(canonical, newId);
        return {
          ok: source !== null && clone !== null,
          notes: !clone ? "Clone not present in canonical re-read" : (!source ? "Original is missing after duplicate" : undefined),
        };
      },
    });
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      source_widget_id: input.widget_id,
      new_widget_id: newId,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
      mutated: rawBefore !== w.serialized,
      warnings: [],
      verification,
    };
  },
});

export const swapWidgetTypeTool = defineTool({
  name: "swap_widget_type",
  description: "Replace a widget's type (e.g., heading → button) while preserving its id and position. Provide full new_settings — the old settings are NOT carried over (different widget types have incompatible schemas). Re-reads to confirm. Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    new_widget_type: z.string().min(1),
    new_settings: z.record(z.any()).default({}),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    ...MutationResponseShape,
    widget_id: z.string(),
    new_widget_type: z.string(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("swap_widget_type", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, widget_id: input.widget_id, new_widget_type: input.new_widget_type, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "swap_widget_type");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { raw: rawBefore, data } = await fetchData(input.site_id, input.page_id);
    if (!swapWidgetType(data, input.widget_id, input.new_widget_type, input.new_settings)) {
      throw new Error(`Widget ${input.widget_id} not found`);
    }
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    const verification = await verifyWrite({
      siteId: input.site_id,
      pageId: input.page_id,
      description: `Re-read /wp/v2/pages/${input.page_id} and assert widget ${input.widget_id} now has widgetType="${input.new_widget_type}"`,
      predicate: (canonical) => {
        const widget = findElementById(canonical, input.widget_id);
        if (!widget) return { ok: false, notes: "Widget missing after swap" };
        return {
          ok: widget.widgetType === input.new_widget_type,
          persisted: { widgetType: widget.widgetType, settings: widget.settings },
          notes: widget.widgetType === input.new_widget_type
            ? undefined
            : `Expected widgetType="${input.new_widget_type}", canonical state has "${widget.widgetType}"`,
        };
      },
    });
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      new_widget_type: input.new_widget_type,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
      mutated: rawBefore !== w.serialized,
      warnings: [],
      verification,
    };
  },
});

export const addWidgetTool = defineTool({
  name: "add_widget",
  description: "Append a new widget to a parent container (section, column, or container) on a page. Re-reads to confirm the new widget exists under the parent. Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    parent_id: z.string().min(1).describe("Id of the section/column/container that will receive the widget."),
    widget_type: z.string().min(1).describe("e.g., 'heading', 'text-editor', 'button', 'image'."),
    settings: z.record(z.any()).default({}),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    ...MutationResponseShape,
    parent_id: z.string(),
    widget_type: z.string(),
    new_widget_id: z.string().optional(),
  }),
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("add_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, parent_id: input.parent_id, widget_type: input.widget_type, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "add_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { raw: rawBefore, data } = await fetchData(input.site_id, input.page_id);
    const r = addWidget(data, input.parent_id, input.widget_type, input.settings);
    if (!r.ok || !r.new_widget_id) throw new Error(`Parent ${input.parent_id} not found`);
    const newId = r.new_widget_id;
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    const verification = await verifyWrite({
      siteId: input.site_id,
      pageId: input.page_id,
      description: `Re-read /wp/v2/pages/${input.page_id} and assert new widget ${newId} exists under parent ${input.parent_id} with widgetType="${input.widget_type}"`,
      predicate: (canonical) => {
        const widget = findElementById(canonical, newId);
        if (!widget) return { ok: false, notes: "New widget not found after add" };
        const parent = findElementById(canonical, input.parent_id);
        const isUnderParent = parent?.elements?.some((e) => e.id === newId) === true;
        return {
          ok: widget.widgetType === input.widget_type && isUnderParent,
          notes: !isUnderParent
            ? `Widget exists but is not under expected parent ${input.parent_id}`
            : widget.widgetType !== input.widget_type
              ? `Widget exists with wrong widgetType "${widget.widgetType}"`
              : undefined,
        };
      },
    });
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      parent_id: input.parent_id,
      widget_type: input.widget_type,
      new_widget_id: newId,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
      mutated: rawBefore !== w.serialized,
      warnings: [],
      verification,
    };
  },
});

export const moveWidgetTool = defineTool({
  name: "move_widget",
  description: "Move a widget to a different parent (or different position in the same parent). Re-reads to confirm new parent. Two-call confirmation.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive(),
    widget_id: z.string().min(1),
    new_parent_id: z.string().min(1),
    position: z.number().int().default(-1).describe("0-based position in the new parent. -1 = append."),
    confirmation: z.string().optional(),
  }),
  outputSchema: z.object({
    ...MutationResponseShape,
    widget_id: z.string(),
    new_parent_id: z.string(),
  }),
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    if (!input.confirmation) {
      const token = issueConfirmation("move_widget", input, POLICIES.CONFIRMATION_TTL_SECONDS);
      return { mode: "dry_run" as const, page_id: input.page_id, widget_id: input.widget_id, new_parent_id: input.new_parent_id, confirmation_token: token };
    }
    const conf = consumeConfirmation(input.confirmation, "move_widget");
    if (!conf) throw new Error("Invalid or expired confirmation token");
    const { raw: rawBefore, data } = await fetchData(input.site_id, input.page_id);
    if (!moveWidget(data, input.widget_id, input.new_parent_id, input.position)) {
      throw new Error(`Widget or parent not found`);
    }
    const backup = await fullBackup(input.site_id, input.page_id);
    const w = await writeData(input.site_id, input.page_id, data);
    const verification = await verifyWrite({
      siteId: input.site_id,
      pageId: input.page_id,
      description: `Re-read /wp/v2/pages/${input.page_id} and assert widget ${input.widget_id} is now a direct child of ${input.new_parent_id}`,
      predicate: (canonical) => {
        const parent = findElementById(canonical, input.new_parent_id);
        const isUnderNewParent = parent?.elements?.some((e) => e.id === input.widget_id) === true;
        return {
          ok: isUnderNewParent,
          notes: isUnderNewParent ? undefined : `Widget ${input.widget_id} not found under ${input.new_parent_id} after move`,
        };
      },
    });
    return {
      mode: "applied" as const,
      page_id: input.page_id,
      widget_id: input.widget_id,
      new_parent_id: input.new_parent_id,
      backup_meta_key: backup.meta_key,
      css_flush: w.method,
      mutated: rawBefore !== w.serialized,
      warnings: [],
      verification,
    };
  },
});
