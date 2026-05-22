import { parseElementorData, ElementorData, ElementorElement } from "./data-parser.js";
import { POLICIES } from "./policies.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate Elementor data shape integrity. Used after programmatic edits to
 * catch corruption before we PUT back to the server.
 *
 * Checks:
 *   - Each element has id, elType, settings
 *   - id is a non-empty string (don't enforce hex format — Elementor's evolved)
 *   - elType is one of the known values
 *   - settings is an object (not null, not array)
 *   - Recursive: every `.elements` array is also valid
 *   - Size cap
 */
export function validateElementorData(input: string | ElementorData): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof input === "string" && input.length > POLICIES.MAX_ELEMENTOR_DATA_BYTES) {
    errors.push(`_elementor_data exceeds ${POLICIES.MAX_ELEMENTOR_DATA_BYTES} bytes (got ${input.length})`);
    return { valid: false, errors, warnings };
  }

  let data: ElementorData;
  try {
    data = parseElementorData(input);
  } catch (e) {
    errors.push(`JSON parse failed: ${(e as Error).message}`);
    return { valid: false, errors, warnings };
  }

  function validateElement(el: ElementorElement, depth: number, path: string[]): void {
    const here = [...path, el.id ?? "?"];
    if (typeof el.id !== "string" || el.id.length === 0) {
      errors.push(`element at ${here.join(".")}: missing or empty id`);
    }
    if (!["section", "container", "column", "widget"].includes(el.elType)) {
      errors.push(`element ${el.id}: unknown elType "${el.elType}"`);
    }
    if (el.elType === "widget" && (typeof el.widgetType !== "string" || el.widgetType.length === 0)) {
      errors.push(`widget ${el.id}: missing widgetType`);
    }
    if (el.settings === null || el.settings === undefined || typeof el.settings !== "object" || Array.isArray(el.settings)) {
      errors.push(`element ${el.id}: settings must be an object (got ${typeof el.settings})`);
    }
    if (depth > 20) warnings.push(`element ${el.id}: depth ${depth} is unusually deep`);
    if (Array.isArray(el.elements)) {
      for (const child of el.elements) validateElement(child, depth + 1, here);
    }
  }

  if (!Array.isArray(data)) {
    errors.push("Top-level must be an array");
    return { valid: false, errors, warnings };
  }
  for (const el of data) validateElement(el, 0, []);

  return { valid: errors.length === 0, errors, warnings };
}
