import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult } from "../api.js";
import { selfWorkspaceId } from "../utils/context.js";
import { isSelfMode } from "../mode.js";

// workspace_id resolution is MODE-DEPENDENT — this is the security crux:
//
//   • SELF mode (audience=self, per-workspace token): workspace_id is OPTIONAL.
//     When omitted it self-defaults to the CALLER'S OWN workspace
//     (selfWorkspaceId — MOLECULE_WORKSPACE_ID / WORKSPACE_ID). The bearer is
//     the per-workspace token (api.ts::authHeaders), which core's WorkspaceAuth
//     binds to its own :id, so even an explicit foreign :id 401s — the default
//     never escalates the credential.
//
//   • DEFAULT a2a / workspace-ops mode (org/operator key that CAN target ANY
//     workspace): workspace_id is REQUIRED. These same 6 tools register in this
//     mode too, so a self-default here would silently retarget an omitted
//     workspace_id to the OPERATOR'S OWN workspace — a wrong-workspace
//     list/run/delete. We therefore FAIL CLOSED with INVALID_ARGUMENTS when it
//     is omitted, restoring the pre-self-mode required guard.
//
// The runtime guard below is authoritative (it is what the handlers enforce and
// the tests exercise directly); the Zod schema is made mode-aware in
// registerScheduleTools() so the declared tool contract matches.
function workspaceIdSchema(selfMode: boolean) {
  return selfMode
    ? z
        .string()
        .optional()
        .describe(
          "Target workspace UUID. Optional in self mode — defaults to the " +
            "caller's own workspace (self-schedule). A workspace token can only " +
            "act on its own id.",
        )
    : z
        .string()
        .describe(
          "Target workspace UUID (required). The org/operator key can target " +
            "any workspace, so the id must be explicit — it is NOT inferred.",
        );
}

/**
 * Resolve the effective workspace id, or a fail-closed INVALID_ARGUMENTS MCP
 * result. Returns a discriminated result so callers `return r.error` before any
 * network call.
 *
 * Precedence: an explicit `workspaceId` always wins (both modes). When omitted,
 * it self-defaults to the caller's own workspace ONLY in self mode; in NON-self
 * mode an omitted id is a hard INVALID_ARGUMENTS (never a silent self-default).
 */
function resolveWorkspaceId(
  workspaceId: string | undefined,
): { id: string } | { error: ReturnType<typeof toMcpResult> } {
  // Explicit target always wins. In DEFAULT mode this is the normal path (the
  // org/operator key legitimately acts on any workspace); in SELF mode a foreign
  // id still only carries the self-bound workspace token, so core 401s it.
  if (workspaceId) return { id: workspaceId };

  // Omitted: self-default ONLY in self mode. NON-self mode must NOT infer an id.
  if (isSelfMode()) {
    const selfId = selfWorkspaceId();
    if (selfId) return { id: selfId };
    return {
      error: toMcpResult({
        error: "INVALID_ARGUMENTS",
        detail:
          "workspace_id could not be resolved — self mode is on but neither " +
          "WORKSPACE_ID nor MOLECULE_WORKSPACE_ID is set in the environment.",
      }),
    };
  }

  return {
    error: toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail:
        "workspace_id is required — pass the target workspace UUID. It only " +
        "self-defaults to the caller's own workspace in self mode " +
        "(MOLECULE_MCP_MODE=self); this server is not in self mode.",
    }),
  };
}

export async function handleListSchedules(params: { workspace_id?: string }) {
  const r = resolveWorkspaceId(params.workspace_id);
  if ("error" in r) return r.error;
  const data = await platformGet(`/workspaces/${r.id}/schedules`);
  return toMcpResult(data);
}

export async function handleCreateSchedule(params: {
  workspace_id?: string;
  name: string;
  cron_expr: string;
  prompt: string;
  timezone?: string;
  enabled?: boolean;
}) {
  const r = resolveWorkspaceId(params.workspace_id);
  if ("error" in r) return r.error;
  const { workspace_id, ...body } = params;
  const data = await apiCall("POST", `/workspaces/${r.id}/schedules`, body);
  return toMcpResult(data);
}

export async function handleUpdateSchedule(params: {
  workspace_id?: string;
  schedule_id: string;
  name?: string;
  cron_expr?: string;
  prompt?: string;
  timezone?: string;
  enabled?: boolean;
}) {
  const r = resolveWorkspaceId(params.workspace_id);
  if ("error" in r) return r.error;
  const { workspace_id, schedule_id, ...body } = params;
  const data = await apiCall(
    "PATCH",
    `/workspaces/${r.id}/schedules/${schedule_id}`,
    body,
  );
  return toMcpResult(data);
}

export async function handleDeleteSchedule(params: {
  workspace_id?: string;
  schedule_id: string;
}) {
  const r = resolveWorkspaceId(params.workspace_id);
  if ("error" in r) return r.error;
  const data = await apiCall(
    "DELETE",
    `/workspaces/${r.id}/schedules/${params.schedule_id}`,
  );
  return toMcpResult(data);
}

export async function handleRunSchedule(params: {
  workspace_id?: string;
  schedule_id: string;
}) {
  const r = resolveWorkspaceId(params.workspace_id);
  if ("error" in r) return r.error;
  const data = await apiCall(
    "POST",
    `/workspaces/${r.id}/schedules/${params.schedule_id}/run`,
  );
  return toMcpResult(data);
}

export async function handleGetScheduleHistory(params: {
  workspace_id?: string;
  schedule_id: string;
}) {
  const r = resolveWorkspaceId(params.workspace_id);
  if ("error" in r) return r.error;
  const data = await apiCall(
    "GET",
    `/workspaces/${r.id}/schedules/${params.schedule_id}/history`,
  );
  return toMcpResult(data);
}

export function registerScheduleTools(srv: McpServer) {
  // Declared workspace_id contract follows the mode: optional (self-defaulting)
  // in self mode, REQUIRED in the default a2a/workspace-ops mode. The runtime
  // resolveWorkspaceId() enforces the same rule authoritatively.
  const workspaceId = workspaceIdSchema(isSelfMode());

  srv.tool(
    "list_schedules",
    "List cron schedules for a workspace.",
    { workspace_id: workspaceId },
    handleListSchedules,
  );

  srv.tool(
    "create_schedule",
    "Create a cron schedule that fires a prompt on a recurring timer.",
    {
      workspace_id: workspaceId,
      name: z.string(),
      cron_expr: z.string().describe("5-field cron (e.g. '0 9 * * 1-5')"),
      prompt: z.string(),
      timezone: z.string().optional(),
      enabled: z.boolean().optional(),
    },
    handleCreateSchedule,
  );

  srv.tool(
    "update_schedule",
    "Update fields on an existing schedule.",
    {
      workspace_id: workspaceId,
      schedule_id: z.string(),
      name: z.string().optional(),
      cron_expr: z.string().optional(),
      prompt: z.string().optional(),
      timezone: z.string().optional(),
      enabled: z.boolean().optional(),
    },
    handleUpdateSchedule,
  );

  srv.tool(
    "delete_schedule",
    "Delete a schedule.",
    { workspace_id: workspaceId, schedule_id: z.string() },
    handleDeleteSchedule,
  );

  srv.tool(
    "run_schedule",
    "Fire a schedule manually, bypassing its cron expression.",
    { workspace_id: workspaceId, schedule_id: z.string() },
    handleRunSchedule,
  );

  srv.tool(
    "get_schedule_history",
    "Get past runs of a schedule — status, start/end, output preview.",
    { workspace_id: workspaceId, schedule_id: z.string() },
    handleGetScheduleHistory,
  );
}
