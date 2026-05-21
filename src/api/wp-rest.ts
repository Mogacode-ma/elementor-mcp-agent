import { loadConfig, getSite, Site } from "../config.js";
import { bucketFor } from "../throttle/token-bucket.js";
import { fromHttp, WPError } from "./errors.js";
import { logger } from "../utils/logger.js";

function authHeader(site: Site): string {
  const encoded = Buffer.from(`${site.username}:${site.application_password}`).toString("base64");
  return `Basic ${encoded}`;
}

export interface RequestOptions {
  siteId?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

export async function wpRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const cfg = loadConfig();
  const site = getSite(opts.siteId);
  await bucketFor(site.id, cfg.rate_limit_per_minute).acquire();

  const url = new URL(path.startsWith("http") ? path : `${site.url.replace(/\/$/, "")}/wp-json${path.startsWith("/") ? "" : "/"}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const method = opts.method ?? (opts.body ? "POST" : "GET");
  const headers: Record<string, string> = {
    Authorization: authHeader(site),
    Accept: "application/json",
    "User-Agent": "elementor-mcp-agent",
    ...(opts.headers ?? {}),
  };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  logger.debug({ method, url: url.toString(), site_id: site.id }, "wp request");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new WPError("network", "fetch_failed", `Network error: ${(e as Error).message}`, e);
  }

  const text = await res.text();
  let parsed: unknown = text;
  if (text && (res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // fall through with raw text
    }
  }

  if (!res.ok) {
    throw fromHttp(res.status, parsed);
  }
  return parsed as T;
}
