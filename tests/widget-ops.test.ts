import { describe, it, expect } from "vitest";
import { parseElementorData, serializeElementorData } from "../src/elementor/data-parser.js";
import {
  readWidget, updateWidgetSettings, deleteWidget, duplicateWidget,
  swapWidgetType, addWidget, moveWidget,
} from "../src/elementor/widget-ops.js";

const sample = JSON.stringify([
  {
    id: "sec1", elType: "section", settings: {}, elements: [
      {
        id: "col1", elType: "column", settings: { _column_size: 100 }, elements: [
          { id: "wA", elType: "widget", widgetType: "heading", settings: { title: "Hello" }, elements: [] },
          { id: "wB", elType: "widget", widgetType: "text-editor", settings: { editor: "Body" }, elements: [] },
        ],
      },
    ],
  },
  {
    id: "sec2", elType: "section", settings: {}, elements: [
      { id: "col2", elType: "column", settings: {}, elements: [] },
    ],
  },
]);

describe("widget-ops", () => {
  it("readWidget finds a widget by id", () => {
    const d = parseElementorData(sample);
    const w = readWidget(d, "wA");
    expect(w?.widgetType).toBe("heading");
  });

  it("updateWidgetSettings merges new settings", () => {
    const d = parseElementorData(sample);
    expect(updateWidgetSettings(d, "wA", { title: "New", _animation: "fadeIn" })).toBe(true);
    const w = readWidget(d, "wA");
    expect(w?.settings.title).toBe("New");
    expect(w?.settings._animation).toBe("fadeIn");
  });

  it("deleteWidget removes from tree", () => {
    const d = parseElementorData(sample);
    expect(deleteWidget(d, "wA")).toBe(true);
    expect(readWidget(d, "wA")).toBeNull();
    expect(readWidget(d, "wB")).not.toBeNull();
  });

  it("duplicateWidget creates a sibling with new id", () => {
    const d = parseElementorData(sample);
    const r = duplicateWidget(d, "wA");
    expect(r.ok).toBe(true);
    expect(r.new_widget_id).toBeDefined();
    expect(r.new_widget_id).not.toBe("wA");
    const cloned = readWidget(d, r.new_widget_id!);
    expect(cloned?.widgetType).toBe("heading");
    expect(cloned?.settings.title).toBe("Hello");
  });

  it("swapWidgetType changes type while preserving id", () => {
    const d = parseElementorData(sample);
    expect(swapWidgetType(d, "wA", "button", { text: "Click" })).toBe(true);
    const w = readWidget(d, "wA");
    expect(w?.widgetType).toBe("button");
    expect(w?.settings.text).toBe("Click");
  });

  it("addWidget appends to a parent container", () => {
    const d = parseElementorData(sample);
    const r = addWidget(d, "col2", "image", { url: "test.jpg" });
    expect(r.ok).toBe(true);
    const w = readWidget(d, r.new_widget_id!);
    expect(w?.widgetType).toBe("image");
  });

  it("moveWidget moves between containers", () => {
    const d = parseElementorData(sample);
    expect(moveWidget(d, "wA", "col2")).toBe(true);
    // wA should now be under col2
    expect(d[1].elements?.[0].elements?.[0].id).toBe("wA");
    // and gone from col1
    expect(d[0].elements?.[0].elements?.find((e) => e.id === "wA")).toBeUndefined();
  });

  it("returns false for missing widgets", () => {
    const d = parseElementorData(sample);
    expect(updateWidgetSettings(d, "missing", {})).toBe(false);
    expect(deleteWidget(d, "missing")).toBe(false);
    expect(duplicateWidget(d, "missing").ok).toBe(false);
    expect(swapWidgetType(d, "missing", "x")).toBe(false);
    expect(addWidget(d, "missing", "x").ok).toBe(false);
    expect(moveWidget(d, "missing", "col1")).toBe(false);
  });

  it("serialization round-trip preserves edits", () => {
    const d = parseElementorData(sample);
    updateWidgetSettings(d, "wA", { title: "Round-trip" });
    const ser = serializeElementorData(d);
    const d2 = parseElementorData(ser);
    expect(readWidget(d2, "wA")?.settings.title).toBe("Round-trip");
  });
});
