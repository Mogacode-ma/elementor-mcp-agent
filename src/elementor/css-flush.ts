import { wpRequest } from "../api/wp-rest.js";
import { sshWpCli } from "../transport/ssh-wpcli.js";
import { getSite } from "../config.js";
import { logger } from "../utils/logger.js";

export type FlushMethod = "rest" | "wp-cli" | "option-delete" | "resave" | "none";

export interface FlushResult {
  method: FlushMethod;
  details?: string;
}

/**
 * Flush Elementor CSS cache. Three-level fallback strategy:
 *   1) REST endpoint (newer Elementor versions)
 *   2) WP-CLI `wp elementor flush-css` (if SSH configured + plugin CLI extension installed)
 *   3) Manual option/meta delete via REST or WP-CLI
 *   4) Last resort: re-save the page (causes regen on next view)
 */
export async function flushCSS(
  siteId: string | undefined,
  postId?: number,
): Promise<FlushResult> {
  // Strategy 1: REST endpoint
  try {
    const url = postId ? `/elementor/v1/css?id=${postId}&action=regenerate` : `/elementor/v1/css?action=regenerate`;
    await wpRequest(url, { siteId, method: "POST" });
    return { method: "rest" };
  } catch (e) {
    logger.debug({ err: (e as Error).message }, "REST css flush failed, trying next");
  }

  // Strategy 2: WP-CLI native command
  try {
    const site = getSite(siteId);
    if (site.ssh) {
      const r = await sshWpCli(site, "elementor flush-css");
      if (r.exitCode === 0) return { method: "wp-cli", details: r.stdout };
    }
  } catch (e) {
    logger.debug({ err: (e as Error).message }, "WP-CLI css flush failed, trying next");
  }

  // Strategy 3: option + post-meta delete via WP-CLI
  try {
    const site = getSite(siteId);
    if (site.ssh) {
      await sshWpCli(site, "option delete _elementor_global_css", { timeout_ms: 30_000 });
      await sshWpCli(site, "post meta delete-all _elementor_css", { timeout_ms: 30_000 });
      return { method: "option-delete" };
    }
  } catch (e) {
    logger.debug({ err: (e as Error).message }, "WP-CLI option-delete failed, trying next");
  }

  // Strategy 4: re-save the page to trigger regen
  if (postId) {
    try {
      await wpRequest(`/wp/v2/pages/${postId}`, {
        siteId,
        method: "PUT",
        body: { date: new Date().toISOString() },
      });
      return { method: "resave" };
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "Resave fallback also failed");
    }
  }

  return { method: "none", details: "All CSS flush strategies failed" };
}
