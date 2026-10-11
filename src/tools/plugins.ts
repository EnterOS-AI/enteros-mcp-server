import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult } from "../api.js";
import { validate } from "../utils/validation.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ListInstalledPluginsSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type ListInstalledPluginsParams = z.infer<typeof ListInstalledPluginsSchema>;

const InstallPluginSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  source: z.string().describe(
    "Source URL: 'local://<name>' for platform registry, 'github://<owner>/<repo>[#<ref>]' for GitHub, or any registered scheme."
  ),
});
export type InstallPluginParams = z.infer<typeof InstallPluginSchema>;

const UninstallPluginSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  name: z.string().describe("Plugin name to remove"),
});
export type UninstallPluginParams = z.infer<typeof UninstallPluginSchema>;

const ListAvailablePluginsSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type ListAvailablePluginsParams = z.infer<typeof ListAvailablePluginsSchema>;

const CheckPluginCompatibilitySchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  runtime: z.string().describe("Target runtime (claude-code, deepagents, langgraph, ...)"),
});
export type CheckPluginCompatibilityParams = z.infer<typeof CheckPluginCompatibilitySchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleListPluginRegistry(): Promise<ReturnType<typeof toMcpResult>> {
  const data = await platformGet("/plugins");
  return toMcpResult(data);
}

export async function handleListInstalledPlugins(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ListInstalledPluginsSchema);
  const data = await platformGet(`/workspaces/${params.workspace_id}/plugins`);
  return toMcpResult(data);
}

export async function handleInstallPlugin(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, InstallPluginSchema);
  const data = await apiCall("POST", `/workspaces/${params.workspace_id}/plugins`, { source: params.source });
  return toMcpResult(data);
}

export async function handleUninstallPlugin(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, UninstallPluginSchema);
  const data = await apiCall("DELETE", `/workspaces/${params.workspace_id}/plugins/${params.name}`);
  return toMcpResult(data);
}

export async function handleListPluginSources(): Promise<ReturnType<typeof toMcpResult>> {
  const data = await platformGet("/plugins/sources");
  return toMcpResult(data);
}

export async function handleListAvailablePlugins(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ListAvailablePluginsSchema);
  const data = await platformGet(`/workspaces/${params.workspace_id}/plugins/available`);
  return toMcpResult(data);
}

export async function handleCheckPluginCompatibility(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, CheckPluginCompatibilitySchema);
  const data = await platformGet(
    `/workspaces/${params.workspace_id}/plugins/compatibility`,
    3,
    undefined,
    { runtime: params.runtime },
  );
  return toMcpResult(data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPluginTools(srv: McpServer) {
  srv.tool("list_plugin_registry", "List all available plugins from the registry", {}, handleListPluginRegistry);

  srv.tool(
    "list_installed_plugins",
    "List plugins installed in a workspace",
    { workspace_id: z.string().describe("Workspace ID") },
    handleListInstalledPlugins
  );

  srv.tool(
    "install_plugin",
    "Install a plugin into a workspace from any registered source (auto-restarts). Use GET /plugins/sources to list schemes.",
    {
      workspace_id: z.string().describe("Workspace ID"),
      source: z.string().describe(
        "Source URL: 'local://<name>' for platform registry, 'github://<owner>/<repo>[#<ref>]' for GitHub, or any registered scheme."
      ),
    },
    handleInstallPlugin
  );

  srv.tool(
    "uninstall_plugin",
    "Remove a plugin from a workspace (auto-restarts)",
    {
      workspace_id: z.string().describe("Workspace ID"),
      name: z.string().describe("Plugin name to remove"),
    },
    handleUninstallPlugin
  );

  srv.tool(
    "list_plugin_sources",
    "List registered plugin install-source schemes (e.g. local, github).",
    {},
    handleListPluginSources,
  );

  srv.tool(
    "list_available_plugins",
    "List plugins from the registry filtered to ones supported by this workspace's runtime.",
    { workspace_id: z.string().describe("Workspace ID") },
    handleListAvailablePlugins,
  );

  srv.tool(
    "check_plugin_compatibility",
    "Preflight check: which installed plugins would break if this workspace switched runtime to <runtime>?",
    {
      workspace_id: z.string().describe("Workspace ID"),
      runtime: z.string().describe("Target runtime (claude-code, deepagents, langgraph, ...)"),
    },
    handleCheckPluginCompatibility,
  );
}
