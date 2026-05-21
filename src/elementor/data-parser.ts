/**
 * Elementor stores its page builder data as a JSON string in postmeta
 * (`_elementor_data`). Each top-level entry is a "section". Sections contain
 * columns, which contain widgets. Widgets have a `widgetType` ("heading",
 * "text-editor", "image", etc.) and a `settings` object.
 *
 * This module provides a typed wrapper + safe deep traversal helpers.
 */

export interface ElementorElement {
  id: string;
  elType: "section" | "column" | "widget" | "container";
  widgetType?: string;
  settings: Record<string, unknown>;
  elements?: ElementorElement[];
  isInner?: boolean;
}

export type ElementorData = ElementorElement[];

export function parseElementorData(raw: string | ElementorData): ElementorData {
  if (Array.isArray(raw)) return raw;
  if (!raw || raw === "[]") return [];
  try {
    const decoded = JSON.parse(raw);
    if (!Array.isArray(decoded)) throw new Error("not an array");
    return decoded as ElementorData;
  } catch (e) {
    throw new Error(`Failed to parse _elementor_data JSON: ${(e as Error).message}`);
  }
}

export function serializeElementorData(data: ElementorData): string {
  return JSON.stringify(data);
}

/**
 * Walks every element top-down, yielding {element, path, depth}.
 * Path is the array of ids from root to current element.
 */
export function* walkElements(
  data: ElementorData,
  path: string[] = [],
  depth = 0,
): Generator<{ element: ElementorElement; path: string[]; depth: number }> {
  for (const el of data) {
    const here = [...path, el.id];
    yield { element: el, path: here, depth };
    if (el.elements && el.elements.length > 0) {
      yield* walkElements(el.elements, here, depth + 1);
    }
  }
}

export function findElementById(data: ElementorData, id: string): ElementorElement | null {
  for (const { element } of walkElements(data)) {
    if (element.id === id) return element;
  }
  return null;
}

export function findWidgets(
  data: ElementorData,
  widgetType?: string,
): { widget: ElementorElement; path: string[] }[] {
  const out: { widget: ElementorElement; path: string[] }[] = [];
  for (const { element, path } of walkElements(data)) {
    if (element.elType === "widget") {
      if (!widgetType || element.widgetType === widgetType) {
        out.push({ widget: element, path });
      }
    }
  }
  return out;
}

/**
 * Find/replace plain-text occurrences in every widget's settings.
 * Returns the modified data + how many replacements happened.
 *
 * Replacement is limited to string fields. Nested objects are recursed into.
 */
export function findReplaceInWidgets(
  data: ElementorData,
  find: string,
  replace: string,
  options: { widgetType?: string; caseSensitive?: boolean } = {},
): { data: ElementorData; replacementCount: number } {
  let count = 0;
  const flags = options.caseSensitive ? "g" : "gi";
  const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

  function replaceInValue(value: unknown): unknown {
    if (typeof value === "string") {
      const next = value.replace(pattern, () => {
        count++;
        return replace;
      });
      return next;
    }
    if (Array.isArray(value)) return value.map(replaceInValue);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = replaceInValue(v);
      return out;
    }
    return value;
  }

  for (const { element } of walkElements(data)) {
    if (element.elType !== "widget") continue;
    if (options.widgetType && element.widgetType !== options.widgetType) continue;
    element.settings = replaceInValue(element.settings) as Record<string, unknown>;
  }

  return { data, replacementCount: count };
}

/**
 * Summary of an Elementor page — counts by widgetType and section depth.
 */
export function summarize(data: ElementorData): {
  totalElements: number;
  sections: number;
  containers: number;
  columns: number;
  widgets: number;
  byWidgetType: Record<string, number>;
  maxDepth: number;
} {
  let totalElements = 0;
  let sections = 0;
  let containers = 0;
  let columns = 0;
  let widgets = 0;
  let maxDepth = 0;
  const byWidgetType: Record<string, number> = {};
  for (const { element, depth } of walkElements(data)) {
    totalElements++;
    maxDepth = Math.max(maxDepth, depth);
    if (element.elType === "section") sections++;
    else if (element.elType === "container") containers++;
    else if (element.elType === "column") columns++;
    else if (element.elType === "widget") {
      widgets++;
      const w = element.widgetType ?? "unknown";
      byWidgetType[w] = (byWidgetType[w] ?? 0) + 1;
    }
  }
  return { totalElements, sections, containers, columns, widgets, byWidgetType, maxDepth };
}
