import type { ToolDefinition } from "../types/tool.js";
import { listSitesTool, pingSiteTool, siteHealthTool } from "./sites.js";
import {
  listElementorPagesTool, readPageElementorTool, listWidgetsInPageTool,
  listGlobalWidgetsTool, preflightCheckTool, findReplaceTool,
  listElementorBackupsTool, restoreElementorBackupTool, duplicateElementorPageTool,
} from "./pages.js";
import {
  listTemplatesTool, exportTemplateTool, importTemplateTool, applyTemplateToPageTool,
} from "./templates.js";
import {
  wpCliRunTool, wpSearchReplaceTool, wpElementorFlushCssTool, wpPluginListTool, wpPluginUpdateTool,
} from "./wpcli.js";
import { screenshotPageTool, compareScreenshotsTool } from "./visual.js";
import { checkElementorVersionsTool } from "./updates.js";

export const tools: ToolDefinition[] = [
  // Sites & health
  listSitesTool, pingSiteTool, siteHealthTool,
  // Pages
  listElementorPagesTool, readPageElementorTool, listWidgetsInPageTool,
  listGlobalWidgetsTool, preflightCheckTool, findReplaceTool,
  listElementorBackupsTool, restoreElementorBackupTool, duplicateElementorPageTool,
  // Templates
  listTemplatesTool, exportTemplateTool, importTemplateTool, applyTemplateToPageTool,
  // WP-CLI escape
  wpCliRunTool, wpSearchReplaceTool, wpElementorFlushCssTool, wpPluginListTool, wpPluginUpdateTool,
  // Visual
  screenshotPageTool, compareScreenshotsTool,
  // Versions
  checkElementorVersionsTool,
] as unknown as ToolDefinition[];
