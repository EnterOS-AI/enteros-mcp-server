import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult } from "../api.js";
import { validate } from "../utils/validation.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ListPeersSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type ListPeersParams = z.infer<typeof ListPeersSchema>;

const DiscoverWorkspaceSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type DiscoverWorkspaceParams = z.infer<typeof DiscoverWorkspaceSchema>;

const CheckAccessSchema = z.object({
  caller_id: z.string().describe("Caller workspace ID"),
  target_id: z.string().describe("Target workspace ID"),
});
export type CheckAccessParams = z.infer<typeof CheckAccessSchema>;

const ListEventsSchema = z.object({
  workspace_id: z.string().optional().describe("Filter to workspace, or omit for all"),
});
export type ListEventsParams = z.infer<typeof ListEventsSchema>;

const ImportOrgSchema = z.object({
  dir: z.string().describe("Org template directory name (e.g., 'molecule-dev')"),
});
export type ImportOrgParams = z.infer<typeof ImportOrgSchema>;

const ImportTemplateSchema = z.object({
  name: z.string().describe("Template name"),
  files: z.record(z.string()).describe("Map of file path → content"),
});
export type ImportTemplateParams = z.infer<typeof ImportTemplateSchema>;

const ExportBundleSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type ExportBundleParams = z.infer<typeof ExportBundleSchema>;

const ImportBundleSchema = z.object({
  bundle: z.record(z.unknown()).describe("Bundle JSON object"),
});
export type ImportBundleParams = z.infer<typeof ImportBundleSchema>;

const SetViewportSchema = z.object({
  x: z.number().describe("Viewport X coordinate"),
  y: z.number().describe("Viewport Y coordinate"),
  zoom: z.number().describe("Zoom level"),
});
export type SetViewportParams = z.infer<typeof SetViewportSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleListPeers(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ListPeersSchema);
  const data = await platformGet(`/registry/${params.workspace_id}/peers`);
  return toMcpResult(data);
}

export async function handleDiscoverWorkspace(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, DiscoverWorkspaceSchema);
  const data = await platformGet(`/registry/discover/${params.workspace_id}`);
  return toMcpResult(data);
}

export async function handleCheckAccess(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, CheckAccessSchema);
  const data = await apiCall("POST", `/registry/check-access`, { caller_id: params.caller_id, target_id: params.target_id });
  return toMcpResult(data);
}

export async function handleListEvents(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ListEventsSchema);
  const path = params.workspace_id ? `/events/${params.workspace_id}` : "/events";
  const data = await platformGet(path);
  return toMcpResult(data);
}

export async function handleListTemplates(): Promise<ReturnType<typeof toMcpResult>> {
  const data = await platformGet("/templates");
  return toMcpResult(data);
}

export async function handleListOrgTemplates(): Promise<ReturnType<typeof toMcpResult>> {
  const data = await platformGet("/org/templates");
  return toMcpResult(data);
}

export async function handleImportOrg(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ImportOrgSchema);
  const data = await apiCall("POST", "/org/import", { dir: params.dir });
  return toMcpResult(data);
}

export async function handleImportTemplate(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ImportTemplateSchema);
  const data = await apiCall("POST", `/templates/import`, { name: params.name, files: params.files });
  return toMcpResult(data);
}

export async function handleExportBundle(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ExportBundleSchema);
  const data = await platformGet(`/bundles/export/${params.workspace_id}`);
  return toMcpResult(data);
}

export async function handleImportBundle(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ImportBundleSchema);
  const data = await apiCall("POST", `/bundles/import`, params.bundle);
  return toMcpResult(data);
}

export async function handleGetViewport(): Promise<ReturnType<typeof toMcpResult>> {
  const data = await platformGet("/canvas/viewport");
  return toMcpResult(data);
}

export async function handleSetViewport(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, SetViewportSchema);
  const data = await apiCall("PUT", "/canvas/viewport", params);
  return toMcpResult(data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDiscoveryTools(srv: McpServer) {
  srv.tool(
    "list_peers",
    "List reachable peer workspaces (siblings, children, parent)",
    { workspace_id: z.string().describe("Workspace ID") },
    handleListPeers
  );

  srv.tool(
    "discover_workspace",
    "Resolve a workspace URL by ID (for A2A communication)",
    { workspace_id: z.string().describe("Workspace ID") },
    handleDiscoverWorkspace
  );

  srv.tool(
    "check_access",
    "Check if two workspaces can communicate",
    {
      caller_id: z.string().describe("Caller workspace ID"),
      target_id: z.string().describe("Target workspace ID"),
    },
    handleCheckAccess
  );

  srv.tool(
    "list_events",
    "List structure events (global or per workspace)",
    { workspace_id: z.string().optional().describe("Filter to workspace, or omit for all") },
    handleListEvents
  );

  srv.tool("list_templates", "List available workspace templates", {}, handleListTemplates);

  srv.tool("list_org_templates", "List available org templates", {}, handleListOrgTemplates);

  srv.tool(
    "import_org",
    "Import an org template to create an entire workspace hierarchy",
    { dir: z.string().describe("Org template directory name (e.g., 'molecule-dev')") },
    handleImportOrg
  );

  srv.tool(
    "import_template",
    "Import agent files as a new workspace template",
    {
      name: z.string().describe("Template name"),
      files: z.record(z.string()).describe("Map of file path → content"),
    },
    handleImportTemplate
  );

  srv.tool(
    "export_bundle",
    "Export a workspace as a portable .bundle.json",
    { workspace_id: z.string().describe("Workspace ID") },
    handleExportBundle
  );

  srv.tool(
    "import_bundle",
    "Import a workspace from a bundle JSON object",
    { bundle: z.record(z.unknown()).describe("Bundle JSON object") },
    handleImportBundle
  );

  srv.tool(
    "get_canvas_viewport",
    "Get the current canvas viewport (x, y, zoom) persisted per-user.",
    {},
    handleGetViewport,
  );

  srv.tool(
    "set_canvas_viewport",
    "Persist the canvas viewport (x, y, zoom).",
    {
      x: z.number().describe("Viewport X coordinate"),
      y: z.number().describe("Viewport Y coordinate"),
      zoom: z.number().describe("Zoom level"),
    },
    handleSetViewport,
  );
}
