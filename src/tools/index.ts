import type { ToolDefinition } from "../types/tool.js";
import { listSitesTool, pingSiteTool } from "./sites.js";
import { listElementorPagesTool, readPageElementorTool, findReplaceTool } from "./pages.js";
import { listTemplatesTool, exportTemplateTool, importTemplateTool } from "./templates.js";
import { checkElementorVersionsTool } from "./updates.js";

// We collect concrete typed tools into a heterogeneous array.
// Variance widens the input/output to unknown at the array level — that's fine
// because each tool re-validates its input via Zod at call time.
export const tools: ToolDefinition[] = [
  listSitesTool,
  pingSiteTool,
  listElementorPagesTool,
  readPageElementorTool,
  findReplaceTool,
  listTemplatesTool,
  exportTemplateTool,
  importTemplateTool,
  checkElementorVersionsTool,
] as unknown as ToolDefinition[];
