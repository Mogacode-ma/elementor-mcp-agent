import { wpRequest } from "../api/wp-rest.js";

/**
 * Backup a page's _elementor_data to a custom postmeta key with a timestamp.
 * Returns the meta_key created.
 */
export async function backupElementorData(siteId: string | undefined, postId: number): Promise<{ meta_key: string; size_bytes: number }> {
  const current = await wpRequest<{ meta: Record<string, unknown> }>(`/wp/v2/pages/${postId}?context=edit&_fields=meta`, { siteId });
  const raw = (current.meta?._elementor_data as string) ?? "[]";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const meta_key = `_elementor_data_backup_${ts}`;
  await wpRequest(`/wp/v2/pages/${postId}`, {
    siteId,
    method: "PUT",
    body: { meta: { [meta_key]: raw } },
  });
  return { meta_key, size_bytes: raw.length };
}

/**
 * Trigger Elementor's CSS regeneration. Two strategies:
 *  1) Hit the elementor REST endpoint /elementor/v1/css if available (newer)
 *  2) Fallback: re-save the page (which causes Elementor to regen on next view)
 */
export async function flushElementorCSS(
  siteId: string | undefined,
  postId: number,
): Promise<{ method: "rest" | "resave" }> {
  try {
    await wpRequest(`/elementor/v1/css?id=${postId}&action=regenerate`, { siteId, method: "POST" });
    return { method: "rest" };
  } catch {
    await wpRequest(`/wp/v2/pages/${postId}`, {
      siteId,
      method: "PUT",
      body: { date: new Date().toISOString() },
    });
    return { method: "resave" };
  }
}
