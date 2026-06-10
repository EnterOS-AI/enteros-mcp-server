/**
 * Unified requests / inbox tools — RFC "unified-requests-inbox", Phase 2.
 *
 * These are the AGENT-FACING MCP tools for the requests subsystem: the one
 * primitive that generalizes "tasks" (agent → user/agent asks) and "approvals"
 * (the gate) into a single inbox keyed by `kind` ∈ {task, approval}, where both
 * the requester and the recipient may be a user OR another agent.
 *
 * Responding is ASYNCHRONOUS: a requester is never blocked. It raises a request
 * (`create_request`), keeps working, and later picks up the answer with
 * `check_requests`. A recipient sees incoming work via `list_inbox` and acts on
 * it with `respond_request` / `add_request_message`.
 *
 * Every tool acts AS a workspace (the agent), mirroring the approvals tools
 * which all take `workspace_id`. The Phase-1 workspace-server registers the
 * agent-side action verbs under the per-workspace, workspace-token-auth prefix
 * `/workspaces/:id/requests/...` (the bare `/requests/:requestId/...` paths are
 * AdminAuth-gated for the canvas user — NOT reachable with a workspace token),
 * so EVERY tool below — including get/respond/messages/cancel — routes through
 * `/workspaces/{workspace_id}/requests/...`. See
 * workspace-server/internal/router/router.go (the `wsAuth` group) and
 * handlers/requests.go for the contract.
 *
 * The pre-existing approval tools (create_approval, decide_approval, …) are
 * left untouched — they keep working against the old /approvals endpoints; the
 * formal shim/deprecation is a later phase (P5).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult } from "../api.js";
import { validate } from "../utils/validation.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateRequestSchema = z.object({
  workspace_id: z.string().describe("Acting workspace (the requesting agent)"),
  kind: z.enum(["task", "approval"]).describe("task = please do X; approval = please approve X"),
  recipient_type: z.enum(["user", "agent"]).describe("Whether the recipient is a user or another agent"),
  recipient_id: z
    .string()
    .describe("Recipient id — a workspace id for an agent recipient, or a user id for a user recipient"),
  title: z.string().describe("Short one-line summary of what is being asked"),
  detail: z.string().optional().describe("Full detail / context for the request"),
  priority: z.number().int().optional().describe("Optional integer priority (higher = more urgent)"),
});
export type CreateRequestParams = z.infer<typeof CreateRequestSchema>;

const ListInboxSchema = z.object({
  workspace_id: z.string().describe("Acting workspace (the recipient agent)"),
  status: z
    .string()
    .optional()
    .describe("Optional status filter, e.g. pending | info_requested | done | rejected | approved | cancelled"),
});
export type ListInboxParams = z.infer<typeof ListInboxSchema>;

const CheckRequestsSchema = z.object({
  workspace_id: z.string().describe("Acting workspace (the requesting agent)"),
  status: z.string().optional().describe("Optional status filter (see list_inbox)"),
});
export type CheckRequestsParams = z.infer<typeof CheckRequestsSchema>;

const GetRequestSchema = z.object({
  workspace_id: z.string().describe("Acting workspace (the agent making the call; used for auth scope)"),
  request_id: z.string().describe("Request id to fetch"),
});
export type GetRequestParams = z.infer<typeof GetRequestSchema>;

const RespondRequestSchema = z.object({
  workspace_id: z.string().describe("Acting workspace (the responding agent)"),
  request_id: z.string().describe("Request id to respond to"),
  action: z
    .enum(["done", "rejected", "approved"])
    .describe("Terminal action — must be valid for the request's kind (task → done/rejected; approval → approved/rejected)"),
  message: z
    .string()
    .optional()
    .describe("Optional note posted to the request's More-Info thread alongside the response"),
});
export type RespondRequestParams = z.infer<typeof RespondRequestSchema>;

const AddRequestMessageSchema = z.object({
  workspace_id: z.string().describe("Acting workspace (the agent authoring the message)"),
  request_id: z.string().describe("Request id whose thread to append to"),
  body: z.string().describe("Message text. If the author is the recipient, this flips the request to info_requested"),
});
export type AddRequestMessageParams = z.infer<typeof AddRequestMessageSchema>;

const CancelRequestSchema = z.object({
  workspace_id: z.string().describe("Acting workspace (the requester withdrawing the request)"),
  request_id: z.string().describe("Request id to cancel/withdraw"),
});
export type CancelRequestParams = z.infer<typeof CancelRequestSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleCreateRequest(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const p = validate(args, CreateRequestSchema);
  const data = await apiCall("POST", `/workspaces/${p.workspace_id}/requests`, {
    kind: p.kind,
    recipient_type: p.recipient_type,
    recipient_id: p.recipient_id,
    title: p.title,
    detail: p.detail,
    priority: p.priority,
  });
  return toMcpResult(data);
}

export async function handleListInbox(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const p = validate(args, ListInboxSchema);
  const qs = p.status ? `?status=${encodeURIComponent(p.status)}` : "";
  const data = await platformGet(`/workspaces/${p.workspace_id}/requests/inbox${qs}`);
  return toMcpResult(data);
}

export async function handleCheckRequests(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const p = validate(args, CheckRequestsSchema);
  const qs = p.status ? `?status=${encodeURIComponent(p.status)}` : "";
  const data = await platformGet(`/workspaces/${p.workspace_id}/requests${qs}`);
  return toMcpResult(data);
}

export async function handleGetRequest(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const p = validate(args, GetRequestSchema);
  const data = await platformGet(`/workspaces/${p.workspace_id}/requests/${p.request_id}`);
  return toMcpResult(data);
}

export async function handleRespondRequest(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const p = validate(args, RespondRequestSchema);
  const data = await apiCall(
    "POST",
    `/workspaces/${p.workspace_id}/requests/${p.request_id}/respond`,
    { action: p.action, responder_type: "agent", responder_id: p.workspace_id }
  );
  // If a note was supplied, post it to the More-Info thread too. The response
  // envelope returns both results so the caller sees each outcome (no silent
  // drop if the thread post fails).
  if (p.message && p.message.trim().length > 0) {
    const msg = await apiCall(
      "POST",
      `/workspaces/${p.workspace_id}/requests/${p.request_id}/messages`,
      { body: p.message, author_type: "agent", author_id: p.workspace_id }
    );
    return toMcpResult({ respond: data, message: msg });
  }
  return toMcpResult(data);
}

export async function handleAddRequestMessage(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const p = validate(args, AddRequestMessageSchema);
  const data = await apiCall(
    "POST",
    `/workspaces/${p.workspace_id}/requests/${p.request_id}/messages`,
    { body: p.body, author_type: "agent", author_id: p.workspace_id }
  );
  return toMcpResult(data);
}

export async function handleCancelRequest(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const p = validate(args, CancelRequestSchema);
  const data = await apiCall("POST", `/workspaces/${p.workspace_id}/requests/${p.request_id}/cancel`);
  return toMcpResult(data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRequestTools(srv: McpServer) {
  srv.tool(
    "create_request",
    "Raise a request (a task or an approval) addressed to a user or another agent. " +
      "kind='task' asks someone to DO something; kind='approval' asks someone to APPROVE something. " +
      "Asynchronous: you are not blocked — poll for the answer later with check_requests.",
    {
      workspace_id: z.string().describe("Acting workspace (the requesting agent)"),
      kind: z.enum(["task", "approval"]).describe("task = please do X; approval = please approve X"),
      recipient_type: z.enum(["user", "agent"]).describe("Whether the recipient is a user or another agent"),
      recipient_id: z
        .string()
        .describe("Recipient id — a workspace id for an agent recipient, or a user id for a user recipient"),
      title: z.string().describe("Short one-line summary of what is being asked"),
      detail: z.string().optional().describe("Full detail / context for the request"),
      priority: z.number().int().optional().describe("Optional integer priority (higher = more urgent)"),
    },
    handleCreateRequest
  );

  srv.tool(
    "list_inbox",
    "List requests addressed TO this agent (its inbox) — the incoming tasks/approvals it should act on. " +
      "Optionally filter by status (e.g. pending).",
    {
      workspace_id: z.string().describe("Acting workspace (the recipient agent)"),
      status: z
        .string()
        .optional()
        .describe("Optional status filter, e.g. pending | info_requested | done | rejected | approved | cancelled"),
    },
    handleListInbox
  );

  srv.tool(
    "check_requests",
    "Check the status of requests this agent RAISED (the async pickup of responses). " +
      "Use after create_request to see whether a recipient has responded.",
    {
      workspace_id: z.string().describe("Acting workspace (the requesting agent)"),
      status: z.string().optional().describe("Optional status filter (see list_inbox)"),
    },
    handleCheckRequests
  );

  srv.tool(
    "get_request",
    "Get a single request plus its full More-Info message thread.",
    {
      workspace_id: z.string().describe("Acting workspace (the agent making the call; used for auth scope)"),
      request_id: z.string().describe("Request id to fetch"),
    },
    handleGetRequest
  );

  srv.tool(
    "respond_request",
    "Respond to a request addressed to this agent with a terminal action " +
      "(done | rejected | approved — must be valid for the request's kind). " +
      "Optionally include a message, which is also posted to the request's thread.",
    {
      workspace_id: z.string().describe("Acting workspace (the responding agent)"),
      request_id: z.string().describe("Request id to respond to"),
      action: z
        .enum(["done", "rejected", "approved"])
        .describe("Terminal action — task → done/rejected; approval → approved/rejected"),
      message: z
        .string()
        .optional()
        .describe("Optional note posted to the request's More-Info thread alongside the response"),
    },
    handleRespondRequest
  );

  srv.tool(
    "add_request_message",
    "Add a message to a request's More-Info thread (e.g. to ask the requester for clarification). " +
      "When the author is the recipient, this flips the request to info_requested.",
    {
      workspace_id: z.string().describe("Acting workspace (the agent authoring the message)"),
      request_id: z.string().describe("Request id whose thread to append to"),
      body: z.string().describe("Message text"),
    },
    handleAddRequestMessage
  );

  srv.tool(
    "cancel_request",
    "Withdraw (cancel) a request this agent previously raised.",
    {
      workspace_id: z.string().describe("Acting workspace (the requester withdrawing the request)"),
      request_id: z.string().describe("Request id to cancel/withdraw"),
    },
    handleCancelRequest
  );
}
