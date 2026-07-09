import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, apiPathSegment, platformGet, toMcpResult, toMcpText } from "../api.js";
import { validate } from "../utils/validation.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ListFilesSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type ListFilesParams = z.infer<typeof ListFilesSchema>;

const ReadFileSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  path: z.string().describe("File path (e.g., system-prompt.md, skills/seo/SKILL.md)"),
});
export type ReadFileParams = z.infer<typeof ReadFileSchema>;

const WriteFileSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  path: z.string().describe("File path"),
  content: z.string().describe("File content"),
});
export type WriteFileParams = z.infer<typeof WriteFileSchema>;

const DeleteFileSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  path: z.string().describe("File or folder path"),
});
export type DeleteFileParams = z.infer<typeof DeleteFileSchema>;

const ReplaceAllFilesSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  files: z.record(z.string()).describe("Map of file path → content"),
});
export type ReplaceAllFilesParams = z.infer<typeof ReplaceAllFilesSchema>;

const GetConfigSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type GetConfigParams = z.infer<typeof GetConfigSchema>;

const UpdateConfigSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  config: z.record(z.unknown()).describe("Config fields to update"),
});
export type UpdateConfigParams = z.infer<typeof UpdateConfigSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function encodedFilePath(path: string): string {
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error("File path must be relative and contain no dot segments");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("File path must be relative and contain no dot segments");
  }
  return segments.map(apiPathSegment).join("/");
}

export async function handleListFiles(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ListFilesSchema);
  const data = await platformGet(`/workspaces/${apiPathSegment(params.workspace_id)}/files`);
  return toMcpResult(data);
}

export async function handleReadFile(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ReadFileSchema);
  const data = await platformGet<{ content?: string }>(
    `/workspaces/${apiPathSegment(params.workspace_id)}/files/${encodedFilePath(params.path)}`
  );
  const fileText = (data as { content?: string } | null)?.content;
  return fileText ? toMcpText(fileText) : toMcpResult(data);
}

export async function handleWriteFile(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, WriteFileSchema);
  const data = await apiCall(
    "PUT",
    `/workspaces/${apiPathSegment(params.workspace_id)}/files/${encodedFilePath(params.path)}`,
    { content: params.content }
  );
  return toMcpResult(data);
}

export async function handleDeleteFile(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, DeleteFileSchema);
  const data = await apiCall(
    "DELETE",
    `/workspaces/${apiPathSegment(params.workspace_id)}/files/${encodedFilePath(params.path)}`
  );
  return toMcpResult(data);
}

export async function handleReplaceAllFiles(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ReplaceAllFilesSchema);
  const data = await apiCall("PUT", `/workspaces/${apiPathSegment(params.workspace_id)}/files`, { files: params.files });
  return toMcpResult(data);
}

export async function handleGetConfig(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, GetConfigSchema);
  const data = await platformGet(`/workspaces/${apiPathSegment(params.workspace_id)}/config`);
  return toMcpResult(data);
}

export async function handleUpdateConfig(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, UpdateConfigSchema);
  const data = await apiCall("PATCH", `/workspaces/${apiPathSegment(params.workspace_id)}/config`, params.config);
  return toMcpResult(data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFileTools(srv: McpServer) {
  srv.tool(
    "list_files",
    "List workspace config files (skills, prompts, config.yaml)",
    { workspace_id: z.string().describe("Workspace ID") },
    handleListFiles
  );

  srv.tool(
    "read_file",
    "Read a workspace config file",
    {
      workspace_id: z.string().describe("Workspace ID"),
      path: z.string().describe("File path (e.g., system-prompt.md, skills/seo/SKILL.md)"),
    },
    handleReadFile
  );

  srv.tool(
    "write_file",
    "Write or create a workspace config file",
    {
      workspace_id: z.string().describe("Workspace ID"),
      path: z.string().describe("File path"),
      content: z.string().describe("File content"),
    },
    handleWriteFile
  );

  srv.tool(
    "delete_file",
    "Delete a workspace file or folder",
    {
      workspace_id: z.string().describe("Workspace ID"),
      path: z.string().describe("File or folder path"),
    },
    handleDeleteFile
  );

  srv.tool(
    "replace_all_files",
    "Replace all workspace config files at once",
    {
      workspace_id: z.string().describe("Workspace ID"),
      files: z.record(z.string()).describe("Map of file path → content"),
    },
    handleReplaceAllFiles
  );

  srv.tool(
    "get_config",
    "Get workspace runtime config as JSON",
    { workspace_id: z.string().describe("Workspace ID") },
    handleGetConfig
  );

  srv.tool(
    "update_config",
    "Update workspace runtime config",
    { workspace_id: z.string().describe("Workspace ID"), config: z.record(z.unknown()).describe("Config fields to update") },
    handleUpdateConfig
  );
}
