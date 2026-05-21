import pino from "pino";

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { name: "elementor-mcp-agent" },
  },
  // Critical: stdout is reserved for MCP JSON-RPC. All logs MUST go to stderr.
  pino.destination(2),
);
