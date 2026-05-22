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
import {
  readWidgetTool, updateWidgetSettingsTool, deleteWidgetTool, duplicateWidgetTool,
  swapWidgetTypeTool, addWidgetTool, moveWidgetTool,
} from "./widgets.js";
import {
  bulkFindReplaceSiteTool, fleetFindReplaceTool, restoreFromFileTool,
} from "./bulk.js";

export const tools: ToolDefinition[] = [
  // Sites & health
  listSitesTool, pingSiteTool, siteHealthTool,
  // Pages
  listElementorPagesTool, readPageElementorTool, listWidgetsInPageTool,
  listGlobalWidgetsTool, preflightCheckTool, findReplaceTool,
  listElementorBackupsTool, restoreElementorBackupTool, duplicateElementorPageTool,
  // Widget-level CRUD (v1.1)
  readWidgetTool, updateWidgetSettingsTool, deleteWidgetTool, duplicateWidgetTool,
  swapWidgetTypeTool, addWidgetTool, moveWidgetTool,
  // Templates
  listTemplatesTool, exportTemplateTool, importTemplateTool, applyTemplateToPageTool,
  // Bulk + fleet (v1.1)
  bulkFindReplaceSiteTool, fleetFindReplaceTool, restoreFromFileTool,
  // WP-CLI escape
  wpCliRunTool, wpSearchReplaceTool, wpElementorFlushCssTool, wpPluginListTool, wpPluginUpdateTool,
  // Visual
  screenshotPageTool, compareScreenshotsTool,
  // Versions
  checkElementorVersionsTool,
] as unknown as ToolDefinition[];
