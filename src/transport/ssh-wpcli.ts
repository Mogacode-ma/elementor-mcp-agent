import { spawn } from "node:child_process";
import { logger } from "../utils/logger.js";
import type { Site } from "../config.js";

export interface WpCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration_ms: number;
  command: string;
}

const wpCliPathCache = new Map<string, string>();

async function detectWpCliPath(site: Site, sshOpts: string[]): Promise<string> {
  if (site.ssh?.wp_cli_path) return site.ssh.wp_cli_path;
  const cached = wpCliPathCache.get(site.id);
  if (cached) return cached;
  // Try a probe command: which wp || ls ~/bin/wp.phar || ls ~/wp-cli.phar
  const probe = `command -v wp 2>/dev/null && echo wp || (test -f "$HOME/bin/wp.phar" && echo "php $HOME/bin/wp.phar") || (test -f "$HOME/wp-cli.phar" && echo "php $HOME/wp-cli.phar") || echo NONE`;
  const { spawn } = await import("node:child_process");
  const result = await new Promise<string>((resolve) => {
    const child = spawn("ssh", [...sshOpts, `${site.ssh!.user}@${site.ssh!.host}`, probe], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.on("close", () => resolve(out.trim().split("\n").pop() ?? "NONE"));
  });
  const detected = result === "NONE" ? "wp" : result;
  wpCliPathCache.set(site.id, detected);
  return detected;
}

export async function sshWpCli(site: Site, wpArgs: string, opts: { timeout_ms?: number } = {}): Promise<WpCliResult> {
  if (!site.ssh) {
    throw new Error(
      `Site '${site.id}' has no SSH configuration. WP-CLI tools require SSH access. ` +
      `Add an "ssh" object to the site config with at least {host, user, path}.`,
    );
  }
  const { host, user, port, path: wpPath, key_path } = site.ssh;
  const timeout = opts.timeout_ms ?? 60_000;

  const sshArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${Math.min(15, Math.floor(timeout / 1000))}`,
    "-p", String(port ?? 22),
  ];
  if (key_path) sshArgs.push("-i", key_path);

  const wpCmd = await detectWpCliPath(site, sshArgs);
  sshArgs.push(`${user}@${host}`);
  const remoteCmd = `${wpCmd} --path=${shellEscape(wpPath)} ${wpArgs}`;
  sshArgs.push(remoteCmd);

  logger.debug({ site_id: site.id, cmd: remoteCmd }, "ssh wp-cli");
  const t0 = Date.now();

  return new Promise<WpCliResult>((resolve, reject) => {
    const child = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`SSH wp-cli timed out after ${timeout}ms: ${remoteCmd}`));
    }, timeout);
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(killer);
      const duration_ms = Date.now() - t0;
      // Filter out non-error SSH banner warnings that pollute stderr (e.g. post-quantum advisory)
      const cleanedStderr = stderr.split("\n").filter((l) => !l.includes("post-quantum") && !l.includes("openssh.com/pq") && !l.includes("decrypt later") && !l.includes("This session may be") && !l.includes("server may need to be")).join("\n").trim();
      resolve({
        stdout: stdout.trim(),
        stderr: cleanedStderr,
        exitCode: code ?? -1,
        duration_ms,
        command: remoteCmd,
      });
    });
  });
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export const DESTRUCTIVE_WPCLI_PATTERNS: RegExp[] = [
  /\bdelete-all\b/i,
  /\bdelete\b(?!.*--dry-run)/i,
  /\bdrop\b/i,
  /\bdb\s+(reset|drop)\b/i,
  /\bpost\s+delete\b/i,
  /\boption\s+delete\b/i,
  /\bplugin\s+(deactivate|uninstall)\b/i,
  /\bsearch-replace\b(?!.*--dry-run)/i,
  /\buser\s+delete\b/i,
];

export function isDestructiveWpCli(args: string): boolean {
  return DESTRUCTIVE_WPCLI_PATTERNS.some((p) => p.test(args));
}
