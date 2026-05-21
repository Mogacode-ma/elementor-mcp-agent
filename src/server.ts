/**
 * MCP server entry point — stdio transport.
 *
 * Run with: `npm run dev` (watch) or `npm start` (compiled).
 * Test interactively: `npm run inspector`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadConfig } from "./config.js";
import { tools } from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { listResources, readResource } from "./resources/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
  name: string;
  version: string;
};

function toMcpInputSchema(zod: z.ZodType<unknown>): Record<string, unknown> {
  // Draft 7 — accepted by both Anthropic API and the broader MCP ecosystem.
  return zodToJsonSchema(zod, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
}

async function main() {
  // Validate config early — fail fast with a clear message rather than letting tools blow up
  try {
    loadConfig();
  } catch (e) {
    logger.error((e as Error).message);
    process.stderr.write("\n" + (e as Error).message + "\n");
    process.exit(1);
  }

  const server = new Server(
    { name: pkg.name, version: pkg.version },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toMcpInputSchema(t.inputSchema),
      outputSchema: t.outputSchema ? toMcpInputSchema(t.outputSchema) : undefined,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as unknown;
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      return {
        content: [{ type: "text" as const, text: `Invalid arguments for ${tool.name}:\n${msg}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(parsed.data);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      logger.error({ tool: tool.name, err: (e as Error).message }, "tool error");
      return {
        content: [{ type: "text" as const, text: `${tool.name} failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  // Resources — Elementor docs corpus
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await listResources(),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(req.params.uri));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ tools: tools.length }, `${pkg.name} v${pkg.version} ready`);
}

main().catch((e) => {
  logger.error((e as Error).message);
  process.stderr.write("\n" + (e as Error).message + "\n");
  process.exit(1);
});
