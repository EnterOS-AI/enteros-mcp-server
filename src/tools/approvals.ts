import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult } from "../api.js";
import { validate } from "../utils/validation.js";

// ---------------------------------------------------------------------------
// Approval tools — DEPRECATED SHIMS over the unified requests subsystem
// (RFC "unified-requests-inbox", Phase 5).
//
// These four tools keep their original NAMES and PARAMETER SIGNATURES for
// backward compatibility, but their handlers now route to the unified
// `/requests` endpoints with kind='approval' instead of the legacy
// `/approvals` endpoints. New approvals therefore land in the unified
// `requests` table and surface in the unified inbox/Approvals tab alongside
// requests created via create_request.
//
// Prefer the new tools (create_request / respond_request / list_inbox /
// check_requests) for new work — these shims exist only so existing callers
// do not break.
//
// Endpoint contract (molecule-core workspace-server, RFC P1):
//   POST /workspaces/:id/requests                       (Create)
//   POST /workspaces/:id/requests/:requestId/respond    (Respond)
//   GET  /requests/pending?kind=approval                (ListPending — cross-org)
//   GET  /workspaces/:id/requests                       (ListOutgoing)
// NOTE: the per-workspace reads (ListOutgoing / ListInbox) take only a
// `status` filter — P1 has NO `kind` query param on those reads, so
// get_workspace_approvals cannot filter to approvals server-side; it returns
// this workspace's outgoing requests (tasks + approvals). The cross-org
// /requests/pending endpoint DOES support ?kind=approval.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DecideApprovalSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  approval_id: z.string().describe("Approval ID"),
  decision: z.enum(["approved", "denied"]).describe("Decision"),
});
export type DecideApprovalParams = z.infer<typeof DecideApprovalSchema>;

const CreateApprovalSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
  action: z.string().describe("What needs approval"),
  reason: z.string().optional().describe("Why it's needed"),
});
export type CreateApprovalParams = z.infer<typeof CreateApprovalSchema>;

const GetWorkspaceApprovalsSchema = z.object({
  workspace_id: z.string().describe("Workspace ID"),
});
export type GetWorkspaceApprovalsParams = z.infer<typeof GetWorkspaceApprovalsSchema>;

// ---------------------------------------------------------------------------
// Handlers (shims → unified /requests, kind='approval')
// ---------------------------------------------------------------------------

export async function handleListPendingApprovals(): Promise<ReturnType<typeof toMcpResult>> {
  // Cross-org pending view, filtered to the approval slice. P1's
  // /requests/pending supports ?kind=task|approval (validated server-side).
  const data = await platformGet("/requests/pending?kind=approval");
  return toMcpResult(data);
}

export async function handleDecideApproval(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, DecideApprovalSchema);
  // Map the legacy decision enum to the unified respond action. For an
  // approval-kind request the valid terminal actions are approved | rejected;
  // legacy "denied" maps to "rejected". responder identity = user/admin (the
  // canvas/admin path default).
  const action = params.decision === "approved" ? "approved" : "rejected";
  const data = await apiCall(
    "POST",
    `/workspaces/${params.workspace_id}/requests/${params.approval_id}/respond`,
    { action, responder_type: "user", responder_id: "admin" }
  );
  return toMcpResult(data);
}

export async function handleCreateApproval(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, CreateApprovalSchema);
  // Raise an approval-kind request addressed to a user. The action becomes the
  // title and the reason becomes the detail. recipient_id is left empty (P1
  // does not require it for a user recipient).
  const data = await apiCall(
    "POST",
    `/workspaces/${params.workspace_id}/requests`,
    {
      kind: "approval",
      recipient_type: "user",
      recipient_id: "",
      title: params.action,
      detail: params.reason,
    }
  );
  return toMcpResult(data);
}

export async function handleGetWorkspaceApprovals(args: unknown): Promise<ReturnType<typeof toMcpResult>> {
  const params = validate(args, GetWorkspaceApprovalsSchema);
  // The unified equivalent of "approvals raised by this workspace" is its
  // outgoing requests. P1 has NO kind filter on this read, so the result
  // includes any tasks the workspace also raised; clients that need only
  // approvals can filter client-side on kind, or use list_inbox / check_requests.
  const data = await platformGet(`/workspaces/${params.workspace_id}/requests`);
  return toMcpResult(data);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const DEPRECATION_NOTE =
  " (deprecated — routes to the unified requests system; prefer create_request / respond_request).";

export function registerApprovalTools(srv: McpServer) {
  srv.tool(
    "list_pending_approvals",
    "List all pending approval requests across workspaces" + DEPRECATION_NOTE,
    {},
    handleListPendingApprovals
  );

  srv.tool(
    "decide_approval",
    "Approve or deny a pending approval request" + DEPRECATION_NOTE,
    {
      workspace_id: z.string().describe("Workspace ID"),
      approval_id: z.string().describe("Approval ID"),
      decision: z.enum(["approved", "denied"]).describe("Decision"),
    },
    handleDecideApproval
  );

  srv.tool(
    "create_approval",
    "Create an approval request for a workspace" + DEPRECATION_NOTE,
    {
      workspace_id: z.string().describe("Workspace ID"),
      action: z.string().describe("What needs approval"),
      reason: z.string().optional().describe("Why it's needed"),
    },
    handleCreateApproval
  );

  srv.tool(
    "get_workspace_approvals",
    "List approval requests for a specific workspace" + DEPRECATION_NOTE,
    { workspace_id: z.string().describe("Workspace ID") },
    handleGetWorkspaceApprovals
  );
}
