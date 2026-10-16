// Entry point for the build step that writes mcp/generated/*.json, so the MCP
// server can list tools and serve skill guides before the extension connects.
// The snapshot is the MCP view of the contract: every tool plus the MCP-only ones
// (screenshot, list_tabs), with the tab routing arguments. It lists every tool;
// once the extension connects it registers only what the permission ceiling allows.
import { mcpToolList } from './toolSchemas.js';

export const TOOL_SCHEMAS = mcpToolList();
export { skillResources } from '../skills/index.js';
