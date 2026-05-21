import type { z } from "zod";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
  handler: (input: TInput) => Promise<TOutput>;
}

/**
 * Helper that lets each tool infer its input/output types from the Zod schemas
 * without needing explicit generic parameters.
 */
export function defineTool<S extends z.ZodType, O extends z.ZodType>(
  def: Omit<ToolDefinition<z.infer<S>, z.infer<O>>, "inputSchema" | "outputSchema"> & {
    inputSchema: S;
    outputSchema?: O;
  },
): ToolDefinition<z.infer<S>, z.infer<O>> {
  return def as ToolDefinition<z.infer<S>, z.infer<O>>;
}
