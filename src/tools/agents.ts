import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, toMcpResult, toMcpText } from "../api.js";
import { validate } from "../utils/validation.js";
import { platformGet } from "../api.js";
import { buildMessageSendBody } from "../utils/a2a.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ChatWithAgentSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  message: z.string().describe("Message to send"),
});
export type ChatWithAgentParams = z.infer<typeof ChatWithAgentSchema>;

const AssignAgentSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  model: z.string().describe("Model string (e.g., openrouter:anthropic/claude-3.5-haiku)"),
});
export type AssignAgentParams = z.infer<typeof AssignAgentSchema>;

const ReplaceAgentSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  model: z.string().describe("Model string"),
});
export type ReplaceAgentParams = z.infer<typeof ReplaceAgentSchema>;

const RemoveAgentSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type RemoveAgentParams = z.infer<typeof RemoveAgentSchema>;

const MoveAgentSchema = z.object({
  workspace_id: z.string().describe("Source workspace ID"),
  target_workspace_id: z.string().describe("Target workspace ID"),
});
export type MoveAgentParams = z.infer<typeof MoveAgentSchema>;

const GetModelSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type GetModelParams = z.infer<typeof GetModelSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleChatWithAgent(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ChatWithAgentSchema);
  const data = await apiCall<
    { result?: { parts?: Array<{ kind?: string; text?: string }> } }
  >(
    "POST",
    `/workspaces/${params.workspace_id}/a2a`,
    buildMessageSendBody(params.message),
  );
  const parts =
    (data as { result?: { parts?: Array<{ kind?: string; text?: string }> } } | null)?.result?.parts || [];
  const text = parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text || "")
    .join("\n");
  return text ? toMcpText(text) : toMcpResult(data);
}

export async function handleAssignAgent(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, AssignAgentSchema);
  const data = await apiCall("POST", `/workspaces/${params.workspace_id}/agent`, { model: params.model });
  return toMcpResult(data);
}

export async function handleReplaceAgent(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, ReplaceAgentSchema);
  const data = await apiCall("PATCH", `/workspaces/${params.workspace_id}/agent`, { model: params.model });
  return toMcpResult(data);
}

export async function handleRemoveAgent(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, RemoveAgentSchema);
  const data = await apiCall("DELETE", `/workspaces/${params.workspace_id}/agent`);
  return toMcpResult(data);
}

export async function handleMoveAgent(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, MoveAgentSchema);
  const data = await apiCall("POST", `/workspaces/${params.workspace_id}/agent/move`, {
    target_workspace_id: params.target_workspace_id,
  });
  return toMcpResult(data);
}

export async function handleGetModel(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, GetModelSchema);
  const data = await platformGet(`/workspaces/${params.workspace_id}/model`);
  return toMcpResult(data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAgentTools(srv: McpServer) {
  srv.tool(
    "chat_with_agent",
    "Send a message to a workspace agent and get a response",
    {
      workspace_id: z.string().describe("Workspace ID"),
      message: z.string().describe("Message to send"),
    },
    handleChatWithAgent
  );

  srv.tool(
    "assign_agent",
    "Assign an AI model to a workspace",
    {
      workspace_id: z.string().describe("Workspace ID"),
      model: z.string().describe("Model string (e.g., openrouter:anthropic/claude-3.5-haiku)"),
    },
    handleAssignAgent
  );

  srv.tool(
    "replace_agent",
    "Replace the model on an existing workspace agent",
    { workspace_id: z.string().describe("Workspace ID"), model: z.string().describe("Model string") },
    handleReplaceAgent
  );

  srv.tool(
    "remove_agent",
    "Remove the agent from a workspace",
    { workspace_id: z.string().describe("Workspace ID") },
    handleRemoveAgent
  );

  srv.tool(
    "move_agent",
    "Move an agent from one workspace to another",
    {
      workspace_id: z.string().describe("Source workspace ID"),
      target_workspace_id: z.string().describe("Target workspace ID"),
    },
    handleMoveAgent
  );

  srv.tool(
    "get_model",
    "Get current model configuration for a workspace",
    { workspace_id: z.string().describe("Workspace ID") },
    handleGetModel
  );
}
