import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "../utils/logger.js";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome(): string | null {
  // Honour explicit override
  if (process.env.ELEMENTOR_MCP_CHROME) {
    return existsSync(process.env.ELEMENTOR_MCP_CHROME) ? process.env.ELEMENTOR_MCP_CHROME : null;
  }
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function screenshotUrl(
  url: string,
  opts: { width?: number; height?: number; timeout_ms?: number; full_page?: boolean } = {},
): Promise<{ path: string; bytes: number }> {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      "Could not locate a Chrome/Chromium binary for screenshots. Set ELEMENTOR_MCP_CHROME to its path " +
      "or install Chrome at one of: " + CHROME_PATHS.join(", "),
    );
  }
  const filename = `elementor-mcp-${randomBytes(4).toString("hex")}-${Date.now()}.png`;
  const path = join(tmpdir(), filename);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--window-size=${opts.width ?? 1440},${opts.height ?? 900}`,
    `--screenshot=${path}`,
    ...(opts.full_page ? ["--virtual-time-budget=10000"] : []),
    "--default-background-color=00000000",
    url,
  ];
  const timeout = opts.timeout_ms ?? 60_000;
  logger.debug({ url, chrome }, "screenshot");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Screenshot timed out after ${timeout}ms`));
    }, timeout);
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) reject(new Error(`Chrome exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve();
    });
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
  });
  if (!existsSync(path)) throw new Error(`Screenshot file not created: ${path}`);
  const fs = await import("node:fs");
  const stat = fs.statSync(path);
  return { path, bytes: stat.size };
}
