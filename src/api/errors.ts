export type WPErrorKind = "auth" | "not_found" | "validation" | "rate_limited" | "server" | "network" | "unknown";

export class WPError extends Error {
  constructor(
    public readonly kind: WPErrorKind,
    public readonly code: string,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "WPError";
  }
}

export function fromHttp(status: number, body: unknown, fallback = "WordPress API error"): WPError {
  const raw = body as Record<string, unknown> | undefined;
  const code = (raw?.code as string) ?? `http_${status}`;
  const msg = (raw?.message as string) ?? fallback;
  let kind: WPErrorKind = "unknown";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 404) kind = "not_found";
  else if (status === 422 || status === 400) kind = "validation";
  else if (status === 429) kind = "rate_limited";
  else if (status >= 500) kind = "server";
  return new WPError(kind, code, msg, body);
}
