import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wpRequest } from "../api/wp-rest.js";
import { sshWpCli } from "../transport/ssh-wpcli.js";
import { getSite } from "../config.js";
import { logger } from "../utils/logger.js";

const BACKUP_DIR = process.env.ELEMENTOR_MCP_BACKUP_DIR ?? join(tmpdir(), "elementor-mcp-backups");

export interface BackupResult {
  meta_key: string;
  page_settings_meta_key?: string;
  file_path?: string;
  size_bytes: number;
  method: "wp-cli" | "file" | "rest";
}

/**
 * Full backup of _elementor_data + _elementor_page_settings.
 *
 * Strategy (priorities):
 *   1) WP-CLI via SSH — always works, writes real postmeta even for unregistered keys
 *   2) File-based — if SSH unavailable, dump to /tmp/elementor-mcp-backups/
 *   3) REST PUT — only works if the meta key is registered with show_in_rest=true
 *      (NOT the case for our timestamped backup keys → silent loss)
 *
 * REST is deliberately deprioritized because WP silently drops writes to
 * unregistered meta keys. We always prefer WP-CLI when available.
 */
export async function fullBackup(
  siteId: string | undefined,
  postId: number,
  opts: { to_file?: boolean; force_file_only?: boolean } = {},
): Promise<BackupResult> {
  // Read current state via REST (works for the canonical Elementor keys)
  const current = await wpRequest<{ meta: Record<string, unknown>; title: { rendered: string } }>(
    `/wp/v2/pages/${postId}?context=edit&_fields=meta,title`,
    { siteId },
  );
  const data_raw_v = current.meta?._elementor_data;
  const data_raw = typeof data_raw_v === "string" ? data_raw_v : JSON.stringify(data_raw_v ?? []);
  const settings_raw_v = current.meta?._elementor_page_settings;
  const settings_raw = typeof settings_raw_v === "string" ? settings_raw_v : JSON.stringify(settings_raw_v ?? {});
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const meta_key = `_elementor_data_backup_${ts}`;
  const page_settings_meta_key = `_elementor_page_settings_backup_${ts}`;
  const size_bytes = data_raw.length + settings_raw.length;

  const site = getSite(siteId);
  let method: BackupResult["method"] = "file";

  // Strategy 1: WP-CLI postmeta write (preferred)
  if (site.ssh && !opts.force_file_only) {
    try {
      // wp post meta update uses positional args; we pipe the value via stdin to avoid shell quoting issues
      const setDataCmd = `post meta update ${postId} ${meta_key} ${shellQuote(data_raw)}`;
      const setSettingsCmd = `post meta update ${postId} ${page_settings_meta_key} ${shellQuote(settings_raw)}`;
      const r1 = await sshWpCli(site, setDataCmd, { timeout_ms: 30_000 });
      if (r1.exitCode !== 0) throw new Error(`wp-cli postmeta data set failed: ${r1.stderr}`);
      const r2 = await sshWpCli(site, setSettingsCmd, { timeout_ms: 30_000 });
      if (r2.exitCode !== 0) throw new Error(`wp-cli postmeta settings set failed: ${r2.stderr}`);
      method = "wp-cli";
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "WP-CLI backup failed, falling back to file");
    }
  }

  // Strategy 2: File backup (always do it if requested OR if WP-CLI failed AND no postmeta was written)
  let file_path: string | undefined;
  if (opts.to_file || method !== "wp-cli") {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const safeSiteId = (siteId ?? "default").replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${safeSiteId}_page${postId}_${ts}.json`;
    file_path = join(BACKUP_DIR, filename);
    writeFileSync(file_path, JSON.stringify({
      site_id: siteId,
      page_id: postId,
      title: current.title.rendered,
      timestamp: ts,
      _elementor_data: data_raw,
      _elementor_page_settings: settings_raw,
    }, null, 2));
    if (method !== "wp-cli") method = "file";
    logger.info({ file_path }, "backup written to file");
  }

  return {
    meta_key,
    page_settings_meta_key,
    file_path,
    size_bytes,
    method,
  };
}

/**
 * Restore from a postmeta backup (created by fullBackup with WP-CLI strategy).
 * Uses WP-CLI to read the backup meta value (since REST won't expose it) and
 * then REST to write back the canonical _elementor_data.
 */
export async function restoreBackup(
  siteId: string | undefined,
  postId: number,
  data_meta_key: string,
  settings_meta_key?: string,
): Promise<{ restored: boolean; method: "wp-cli" | "rest" }> {
  const site = getSite(siteId);
  if (!site.ssh) {
    throw new Error("Restoring from postmeta backup requires SSH (WP-CLI). For file backups, use restoreFromFile.");
  }
  // Read backup value via WP-CLI
  const r1 = await sshWpCli(site, `post meta get ${postId} ${data_meta_key}`, { timeout_ms: 30_000 });
  if (r1.exitCode !== 0) throw new Error(`Backup '${data_meta_key}' not found: ${r1.stderr}`);
  const data_value = r1.stdout;
  if (!data_value) throw new Error(`Backup '${data_meta_key}' is empty`);

  let settings_value: string | undefined;
  if (settings_meta_key) {
    const r2 = await sshWpCli(site, `post meta get ${postId} ${settings_meta_key}`, { timeout_ms: 30_000 });
    if (r2.exitCode === 0 && r2.stdout) settings_value = r2.stdout;
  }

  // Write back via WP-CLI (so we don't depend on _elementor_data being REST-writable; it is, but consistency)
  const writeData = await sshWpCli(site, `post meta update ${postId} _elementor_data ${shellQuote(data_value)}`, { timeout_ms: 30_000 });
  if (writeData.exitCode !== 0) throw new Error(`Restore write failed: ${writeData.stderr}`);
  if (settings_value !== undefined) {
    await sshWpCli(site, `post meta update ${postId} _elementor_page_settings ${shellQuote(settings_value)}`, { timeout_ms: 30_000 });
  }
  return { restored: true, method: "wp-cli" };
}

/**
 * List backups on a page using WP-CLI (REST won't expose custom postmeta keys).
 */
export async function listBackups(
  siteId: string | undefined,
  postId: number,
): Promise<Array<{ meta_key: string; settings_key?: string; timestamp: string }>> {
  const site = getSite(siteId);
  if (!site.ssh) {
    throw new Error("Listing postmeta backups requires SSH (WP-CLI). REST API doesn't expose unregistered custom postmeta keys.");
  }
  const r = await sshWpCli(site, `post meta list ${postId} --format=json --fields=meta_key`, { timeout_ms: 30_000 });
  if (r.exitCode !== 0) throw new Error(`wp-cli post meta list failed: ${r.stderr}`);
  interface MetaKey { meta_key: string; }
  const all = JSON.parse(r.stdout) as MetaKey[];
  const dataBackupKeys = all.filter((m) => m.meta_key.startsWith("_elementor_data_backup_"));
  const settingsBackupKeys = new Set(all.filter((m) => m.meta_key.startsWith("_elementor_page_settings_backup_")).map((m) => m.meta_key));
  return dataBackupKeys.map((m) => {
    const ts = m.meta_key.replace("_elementor_data_backup_", "");
    const expectedSettingsKey = `_elementor_page_settings_backup_${ts}`;
    return {
      meta_key: m.meta_key,
      settings_key: settingsBackupKeys.has(expectedSettingsKey) ? expectedSettingsKey : undefined,
      timestamp: ts,
    };
  });
}

/**
 * Restore from a file backup (output of fullBackup with to_file=true).
 * Uses WP-CLI if available, falls back to REST (works for _elementor_data which is registered).
 */
export async function restoreFromFile(
  siteId: string | undefined,
  postId: number,
  file_path: string,
): Promise<{ restored: boolean; method: "wp-cli" | "rest" }> {
  if (!existsSync(file_path)) throw new Error(`Backup file not found: ${file_path}`);
  const j = JSON.parse(readFileSync(file_path, "utf8")) as {
    _elementor_data?: string;
    _elementor_page_settings?: string;
  };
  if (!j._elementor_data) throw new Error("Backup file missing _elementor_data");

  const site = getSite(siteId);
  if (site.ssh) {
    await sshWpCli(site, `post meta update ${postId} _elementor_data ${shellQuote(j._elementor_data)}`, { timeout_ms: 30_000 });
    if (j._elementor_page_settings) {
      await sshWpCli(site, `post meta update ${postId} _elementor_page_settings ${shellQuote(j._elementor_page_settings)}`, { timeout_ms: 30_000 });
    }
    return { restored: true, method: "wp-cli" };
  }
  // REST fallback (works for _elementor_data, may silently no-op for _elementor_page_settings)
  await wpRequest(`/wp/v2/pages/${postId}`, {
    siteId, method: "PUT",
    body: {
      meta: {
        _elementor_data: j._elementor_data,
        ...(j._elementor_page_settings ? { _elementor_page_settings: j._elementor_page_settings } : {}),
      },
    },
  });
  return { restored: true, method: "rest" };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
