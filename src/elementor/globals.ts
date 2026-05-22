import { wpRequest } from "../api/wp-rest.js";
import { parseElementorData, walkElements } from "./data-parser.js";

export interface GlobalWidget {
  template_id: number;
  title: string;
  widget_type?: string;
  used_on_pages?: number[];
}

/**
 * List all global widgets on a site.
 * Global widgets are stored as posts of type `elementor_library` with
 * `_elementor_template_type = widget`.
 */
export async function listGlobalWidgets(siteId: string | undefined): Promise<GlobalWidget[]> {
  interface Tpl {
    id: number;
    title: { rendered: string };
    meta?: { _elementor_template_type?: string; _elementor_data?: string };
  }
  const items = await wpRequest<Tpl[]>("/wp/v2/elementor_library", {
    siteId,
    query: {
      context: "edit",
      per_page: 100,
      _fields: "id,title,meta",
    },
  });
  // Filter client-side — REST won't reliably filter on unregistered meta
  const widgetsOnly = items.filter((t) => t.meta?._elementor_template_type === "widget");
  return widgetsOnly.map((t) => {
    const data = parseElementorData(t.meta?._elementor_data ?? "[]");
    let widget_type: string | undefined;
    for (const { element } of walkElements(data)) {
      if (element.elType === "widget") {
        widget_type = element.widgetType;
        break;
      }
    }
    return {
      template_id: t.id,
      title: t.title.rendered,
      widget_type,
    };
  });
}

/**
 * In a parsed _elementor_data tree, find widgets that reference a global widget
 * template (Elementor stores a reference via the `templateID` setting on a
 * `global` widgetType).
 */
export function findGlobalReferences(data: unknown): { widget_id: string; template_id: number }[] {
  const out: { widget_id: string; template_id: number }[] = [];
  try {
    for (const { element } of walkElements(parseElementorData(data as string | []))) {
      if (element.elType === "widget" && element.widgetType === "global") {
        const tid = (element.settings as { template_id?: number; templateID?: number }).template_id
          ?? (element.settings as { template_id?: number; templateID?: number }).templateID;
        if (typeof tid === "number") out.push({ widget_id: element.id, template_id: tid });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}
