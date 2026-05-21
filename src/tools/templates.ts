import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { wpRequest } from "../api/wp-rest.js";
import { parseElementorData, summarize, serializeElementorData } from "../elementor/data-parser.js";

export const listTemplatesTool = defineTool({
  name: "list_elementor_templates",
  description: "List Elementor library templates on a site (saved sections, pages, popups). Type can be filtered: 'section', 'page', 'popup', 'header', 'footer'.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    type: z.enum(["section", "page", "popup", "header", "footer", "any"]).default("any"),
    per_page: z.number().int().min(1).max(100).default(50),
  }),
  outputSchema: z.object({
    total: z.number(),
    templates: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        type: z.string(),
        modified: z.string(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const query: Record<string, string | number> = {
      per_page: input.per_page,
      context: "edit",
      _fields: "id,title,modified,meta",
    };
    if (input.type !== "any") {
      query.meta_key = "_elementor_template_type";
      query.meta_value = input.type;
    }
    interface RawTpl {
      id: number;
      title: { rendered: string };
      modified: string;
      meta?: { _elementor_template_type?: string };
    }
    const items = await wpRequest<RawTpl[]>("/wp/v2/elementor_library", {
      siteId: input.site_id,
      query,
    });
    return {
      total: items.length,
      templates: items.map((t) => ({
        id: t.id,
        title: t.title.rendered,
        type: t.meta?._elementor_template_type ?? "unknown",
        modified: t.modified,
      })),
    };
  },
});

export const exportTemplateTool = defineTool({
  name: "export_elementor_template",
  description: "Export an Elementor template as a portable JSON object. Output is the same structure Elementor expects on import. Use it to copy sections between sites.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    template_id: z.number().int().positive(),
  }),
  outputSchema: z.object({
    template_id: z.number(),
    title: z.string(),
    type: z.string(),
    summary: z.object({
      totalElements: z.number(),
      widgets: z.number(),
      sections: z.number(),
    }),
    portable_json: z.string().describe("JSON-stringified payload ready to import via import_elementor_template."),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(input) {
    const tpl = await wpRequest<{
      id: number;
      title: { rendered: string };
      meta?: { _elementor_template_type?: string; _elementor_data?: string };
    }>(`/wp/v2/elementor_library/${input.template_id}?context=edit`, {
      siteId: input.site_id,
    });
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
  description: "Import an Elementor template (output of export_elementor_template) into a target site as a new template entry. Useful for syncing reusable sections across an agency's site fleet.",
  inputSchema: z.object({
    site_id: z.string().optional().describe("Target site id."),
    portable_json: z.string().describe("JSON-stringified payload from export_elementor_template."),
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
    try {
      payload = JSON.parse(input.portable_json);
    } catch (e) {
      throw new Error("portable_json is not valid JSON: " + (e as Error).message);
    }
    const title = input.override_title ?? payload.title;
    const data = Array.isArray(payload.content) ? payload.content : parseElementorData(payload.content as string);
    const res = await wpRequest<{ id: number; link: string }>(`/wp/v2/elementor_library`, {
      siteId: input.site_id,
      method: "POST",
      body: {
        title,
        status: "publish",
        meta: {
          _elementor_template_type: payload.type,
          _elementor_data: serializeElementorData(data),
          _elementor_edit_mode: "builder",
        },
      },
    });
    return {
      new_template_id: res.id,
      title,
      type: payload.type,
      url: res.link,
    };
  },
});
