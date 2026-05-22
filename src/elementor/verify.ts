/**
 * Post-write verification — never trust the write API, always re-read.
 *
 * Background: WordPress REST API silently drops writes to unregistered postmeta
 * keys and returns 200 OK. Other failure modes exist (cache layers, race
 * conditions, plugin filters mutating data on save). A tool that returns
 * `{ success: true }` based purely on the HTTP response is lying to the model.
 *
 * This module re-fetches the canonical state from WP after every write and
 * runs an operation-specific predicate against it. The result is folded into
 * the tool response as a `verification` block, so the model can decide based
 * on what actually persisted, not what the API claimed.
 *
 * Pattern proposed by Mads Hansen (dev.to, May 22 2026) in response to the
 * v1.0 "REST silently drops writes" gotcha — implemented in v1.2 as a
 * generic primitive every mutating tool plugs into.
 */
import { z } from "zod";
import { wpRequest } from "../api/wp-rest.js";
import { parseElementorData, type ElementorData } from "./data-parser.js";

export const VerificationSchema = z.object({
  /** Plain-English description of what we re-read and compared. */
  method: z.string(),
  /** Whether a canonical re-read of the page succeeded. */
  reread_ok: z.boolean(),
  /** Op-specific: did the change we requested actually persist? */
  matches_requested: z.boolean(),
  /** Op-specific extra data (e.g. the actual persisted widget settings). */
  persisted: z.record(z.any()).optional(),
  /** Free-text notes / explanation when matches_requested is false. */
  notes: z.string().optional(),
});

export type Verification = z.infer<typeof VerificationSchema>;

/**
 * Re-fetches the page's `_elementor_data` from WP (canonical source after the
 * write) and runs the predicate. The predicate returns whether the requested
 * mutation is present in the persisted state.
 */
export async function verifyWrite(args: {
  siteId: string | undefined;
  pageId: number;
  predicate: (data: ElementorData) => { ok: boolean; persisted?: Record<string, unknown>; notes?: string };
  description: string;
}): Promise<Verification> {
  try {
    const page = await wpRequest<{ meta?: Record<string, unknown> }>(
      `/wp/v2/pages/${args.pageId}?context=edit&_fields=meta`,
      { siteId: args.siteId },
    );
    const v = page.meta?._elementor_data;
    const raw = typeof v === "string" ? v : JSON.stringify(v ?? []);
    const data = parseElementorData(raw);
    const result = args.predicate(data);
    return {
      method: args.description,
      reread_ok: true,
      matches_requested: result.ok,
      persisted: result.persisted,
      notes: result.notes,
    };
  } catch (err) {
    return {
      method: args.description,
      reread_ok: false,
      matches_requested: false,
      notes: `Canonical re-read failed: ${(err as Error).message}`,
    };
  }
}

/** Deep equality good-enough for Elementor settings comparison. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
