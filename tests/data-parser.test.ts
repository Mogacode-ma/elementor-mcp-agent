import { describe, it, expect } from "vitest";
import {
  parseElementorData,
  summarize,
  findReplaceInWidgets,
  findElementById,
  serializeElementorData,
} from "../src/elementor/data-parser.js";

const sample = JSON.stringify([
  {
    id: "sec01",
    elType: "section",
    settings: {},
    elements: [
      {
        id: "col01",
        elType: "column",
        settings: {},
        elements: [
          { id: "w001", elType: "widget", widgetType: "heading", settings: { title: "Hello world" }, elements: [] },
          { id: "w002", elType: "widget", widgetType: "heading", settings: { title: "Hello again" }, elements: [] },
          {
            id: "w003",
            elType: "widget",
            widgetType: "text-editor",
            settings: { editor: "<p>Some text with Hello inside</p>" },
            elements: [],
          },
        ],
      },
    ],
  },
]);

describe("parseElementorData", () => {
  it("parses a JSON string", () => {
    const d = parseElementorData(sample);
    expect(d).toHaveLength(1);
    expect(d[0].id).toBe("sec01");
  });
  it("returns empty array for empty input", () => {
    expect(parseElementorData("[]")).toEqual([]);
    expect(parseElementorData("")).toEqual([]);
  });
  it("throws on malformed JSON", () => {
    expect(() => parseElementorData("not json")).toThrow();
  });
});

describe("summarize", () => {
  it("counts every element type", () => {
    const s = summarize(parseElementorData(sample));
    expect(s.sections).toBe(1);
    expect(s.columns).toBe(1);
    expect(s.widgets).toBe(3);
    expect(s.byWidgetType.heading).toBe(2);
    expect(s.byWidgetType["text-editor"]).toBe(1);
    expect(s.maxDepth).toBeGreaterThan(0);
  });
});

describe("findElementById", () => {
  it("finds a deep widget", () => {
    const d = parseElementorData(sample);
    const w = findElementById(d, "w002");
    expect(w).not.toBeNull();
    expect(w?.widgetType).toBe("heading");
  });
});

describe("findReplaceInWidgets", () => {
  it("counts and applies replacements across all widgets", () => {
    const d = parseElementorData(sample);
    const r = findReplaceInWidgets(d, "Hello", "Hi");
    expect(r.replacementCount).toBe(3); // 2 in heading.title + 1 in editor html
    const ser = serializeElementorData(r.data);
    expect(ser).not.toContain("Hello");
    expect(ser).toContain("Hi");
  });
  it("filters by widgetType", () => {
    const d = parseElementorData(sample);
    const r = findReplaceInWidgets(d, "Hello", "Hi", { widgetType: "heading" });
    expect(r.replacementCount).toBe(2);
  });
  it("respects caseSensitive", () => {
    const d = parseElementorData(sample);
    const r1 = findReplaceInWidgets(d, "hello", "X", { caseSensitive: true });
    expect(r1.replacementCount).toBe(0);
  });
});
