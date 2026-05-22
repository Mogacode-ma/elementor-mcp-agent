import { z } from "zod";
import { defineTool } from "../types/tool.js";
import { screenshotUrl } from "../transport/screenshot.js";
import { wpRequest } from "../api/wp-rest.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const screenshotPageTool = defineTool({
  name: "screenshot_page",
  description: "Capture a PNG screenshot of a page's frontend (visitor-facing URL). Requires a Chrome/Chromium binary on the host. Returns the local file path so the LLM can analyse it or compare against another shot.",
  inputSchema: z.object({
    site_id: z.string().optional(),
    page_id: z.number().int().positive().optional(),
    url: z.string().url().optional().describe("Alternative to page_id: hit any URL directly."),
    width: z.number().int().min(320).max(3840).default(1440),
    height: z.number().int().min(240).max(2400).default(900),
    full_page: z.boolean().default(false),
  }),
  outputSchema: z.object({
    url: z.string(),
    file_path: z.string(),
    bytes: z.number(),
    sha256: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  async handler(input) {
    let target = input.url;
    if (!target) {
      if (!input.page_id) throw new Error("Provide either 'url' or 'page_id'.");
      const page = await wpRequest<{ link: string }>(`/wp/v2/pages/${input.page_id}?_fields=link`, { siteId: input.site_id });
      target = page.link;
    }
    const shot = await screenshotUrl(target, { width: input.width, height: input.height, full_page: input.full_page });
    const hash = createHash("sha256").update(readFileSync(shot.path)).digest("hex");
    return {
      url: target,
      file_path: shot.path,
      bytes: shot.bytes,
      sha256: hash,
      width: input.width,
      height: input.height,
    };
  },
});

export const compareScreenshotsTool = defineTool({
  name: "compare_screenshots",
  description: "Compare two screenshot files via SHA-256 hash equality and size delta. Quick way to spot whether a page changed visually after an edit. For pixel diffs, use a dedicated tool externally.",
  inputSchema: z.object({
    before_path: z.string(),
    after_path: z.string(),
  }),
  outputSchema: z.object({
    identical: z.boolean(),
    before_bytes: z.number(),
    after_bytes: z.number(),
    delta_bytes: z.number(),
    before_sha256: z.string(),
    after_sha256: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler(input) {
    const a = readFileSync(input.before_path);
    const b = readFileSync(input.after_path);
    const ah = createHash("sha256").update(a).digest("hex");
    const bh = createHash("sha256").update(b).digest("hex");
    return {
      identical: ah === bh,
      before_bytes: a.length,
      after_bytes: b.length,
      delta_bytes: b.length - a.length,
      before_sha256: ah,
      after_sha256: bh,
    };
  },
});
