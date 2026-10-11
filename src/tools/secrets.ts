import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, apiPathSegment, platformGet, toMcpResult } from "../api.js";
import { validate } from "../utils/validation.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SetSecretSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  key: z.string().describe("Secret key (e.g., ANTHROPIC_API_KEY)"),
  value: z.string().describe("Secret value"),
});
export type SetSecretParams = z.infer<typeof SetSecretSchema>;

const ListSecretsSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type ListSecretsParams = z.infer<typeof ListSecretsSchema>;

const DeleteSecretSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  key: z.string().describe("Secret key"),
});
export type DeleteSecretParams = z.infer<typeof DeleteSecretSchema>;

const SetGlobalSecretSchema = z.object({
  key: z.string().describe("Secret key (e.g., GITHUB_TOKEN)"),
  value: z.string().describe("Secret value"),
});
export type SetGlobalSecretParams = z.infer<typeof SetGlobalSecretSchema>;

const DeleteGlobalSecretSchema = z.object({
  key: z.string().describe("Secret key"),
});
export type DeleteGlobalSecretParams = z.infer<typeof DeleteGlobalSecretSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleSetSecret(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, SetSecretSchema);
  const data = await apiCall("POST", `/workspaces/${params.workspace_id}/secrets`, { key: params.key, value: params.value });
  return toMcpResult(data);
}

export async function handleListSecrets(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ListSecretsSchema);
  const data = await platformGet(`/workspaces/${params.workspace_id}/secrets`);
  return toMcpResult(data);
}

export async function handleDeleteSecret(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, DeleteSecretSchema);
  const data = await apiCall("DELETE", `/workspaces/${params.workspace_id}/secrets/${encodeURIComponent(params.key)}`);
  return toMcpResult(data);
}

export async function handleListGlobalSecrets(): Promise<ReturnType<typeof toMcpResult>> {
  const data = await platformGet("/settings/secrets");
  return toMcpResult(data);
}

export async function handleSetGlobalSecret(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, SetGlobalSecretSchema);
  const data = await apiCall("PUT", "/settings/secrets", { key: params.key, value: params.value });
  return toMcpResult(data);
}

export async function handleDeleteGlobalSecret(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, DeleteGlobalSecretSchema);
  const data = await apiCall("DELETE", `/settings/secrets/${apiPathSegment(params.key)}`);
  return toMcpResult(data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSecretTools(srv: McpServer) {
  srv.tool(
    "set_secret",
    "Set an API key or environment variable for a workspace",
    { workspace_id: z.string().describe("Workspace ID"), key: z.string().describe("Secret key (e.g., ANTHROPIC_API_KEY)"), value: z.string().describe("Secret value") },
    handleSetSecret
  );

  srv.tool(
    "list_secrets",
    "List secret keys for a workspace (values never exposed)",
    { workspace_id: z.string().describe("Workspace ID") },
    handleListSecrets
  );

  srv.tool(
    "delete_secret",
    "Delete a secret from a workspace",
    { workspace_id: z.string().describe("Workspace ID"), key: z.string().describe("Secret key") },
    handleDeleteSecret
  );

  srv.tool("list_global_secrets", "List global secret keys (values never exposed)", {}, handleListGlobalSecrets);

  srv.tool(
    "set_global_secret",
    "Set a global secret (available to all workspaces)",
    { key: z.string().describe("Secret key (e.g., GITHUB_TOKEN)"), value: z.string().describe("Secret value") },
    handleSetGlobalSecret
  );

  srv.tool(
    "delete_global_secret",
    "Delete a global secret",
    { key: z.string().describe("Secret key") },
    handleDeleteGlobalSecret
  );
}
