import { ElementorData, ElementorElement, findElementById, walkElements } from "./data-parser.js";

/**
 * Operations on individual widgets inside an Elementor data tree.
 * All operations work on a deep-cloned tree — caller is responsible for
 * serializing the result and writing back.
 */

export function readWidget(data: ElementorData, widgetId: string): ElementorElement | null {
  return findElementById(data, widgetId);
}

/**
 * Shallow-merge new settings into an existing widget's settings.
 * Returns true if the widget was found and updated.
 */
export function updateWidgetSettings(
  data: ElementorData,
  widgetId: string,
  patch: Record<string, unknown>,
): boolean {
  const widget = findElementById(data, widgetId);
  if (!widget || widget.elType !== "widget") return false;
  widget.settings = { ...widget.settings, ...patch };
  return true;
}

/**
 * Delete a widget by id. Returns true if removed.
 */
export function deleteWidget(data: ElementorData, widgetId: string): boolean {
  function removeFrom(arr: ElementorElement[]): boolean {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === widgetId) {
        arr.splice(i, 1);
        return true;
      }
      if (arr[i].elements && removeFrom(arr[i].elements!)) return true;
    }
    return false;
  }
  return removeFrom(data);
}

/**
 * Find the parent (section/column/container) of a widget.
 */
export function findParent(data: ElementorData, widgetId: string): ElementorElement | null {
  for (const { element } of walkElements(data)) {
    if (element.elements?.some((e) => e.id === widgetId)) return element;
  }
  return null;
}

/**
 * Duplicate a widget in place (right after the original in the parent's elements array).
 * Generates a new id for the clone.
 */
export function duplicateWidget(data: ElementorData, widgetId: string): { ok: boolean; new_widget_id?: string } {
  const parent = findParent(data, widgetId);
  if (!parent || !parent.elements) return { ok: false };
  const idx = parent.elements.findIndex((e) => e.id === widgetId);
  if (idx < 0) return { ok: false };
  const clone = JSON.parse(JSON.stringify(parent.elements[idx])) as ElementorElement;
  clone.id = generateId();
  parent.elements.splice(idx + 1, 0, clone);
  return { ok: true, new_widget_id: clone.id };
}

/**
 * Replace a widget's type while preserving id, position, and as many compatible
 * settings as possible. Useful for migrating from one widget type to another
 * (e.g., heading → text-editor).
 */
export function swapWidgetType(
  data: ElementorData,
  widgetId: string,
  newType: string,
  newSettings: Record<string, unknown> = {},
): boolean {
  const widget = findElementById(data, widgetId);
  if (!widget || widget.elType !== "widget") return false;
  widget.widgetType = newType;
  widget.settings = newSettings;
  return true;
}

/**
 * Add a widget at the end of a parent container.
 */
export function addWidget(
  data: ElementorData,
  parentId: string,
  widgetType: string,
  settings: Record<string, unknown> = {},
): { ok: boolean; new_widget_id?: string } {
  const parent = findElementById(data, parentId);
  if (!parent) return { ok: false };
  if (!parent.elements) parent.elements = [];
  const newWidget: ElementorElement = {
    id: generateId(),
    elType: "widget",
    widgetType,
    settings,
    elements: [],
    isInner: false,
  };
  parent.elements.push(newWidget);
  return { ok: true, new_widget_id: newWidget.id };
}

/**
 * Move a widget to a different parent (or different position in same parent).
 */
export function moveWidget(
  data: ElementorData,
  widgetId: string,
  newParentId: string,
  position: number = -1,
): boolean {
  const widget = findElementById(data, widgetId);
  if (!widget) return false;
  const oldParent = findParent(data, widgetId);
  if (!oldParent || !oldParent.elements) return false;
  const newParent = findElementById(data, newParentId);
  if (!newParent) return false;
  if (!newParent.elements) newParent.elements = [];
  const idx = oldParent.elements.findIndex((e) => e.id === widgetId);
  if (idx < 0) return false;
  oldParent.elements.splice(idx, 1);
  if (position < 0 || position >= newParent.elements.length) {
    newParent.elements.push(widget);
  } else {
    newParent.elements.splice(position, 0, widget);
  }
  return true;
}

/**
 * Elementor uses 7-character hex ids by historical convention. We generate
 * something compatible-shaped.
 */
function generateId(): string {
  return Math.random().toString(16).slice(2, 9).padEnd(7, "0");
}
