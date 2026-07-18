import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult } from "../api.js";
import { selfWorkspaceId } from "../utils/context.js";

// workspace_id is OPTIONAL on every schedule tool. When omitted it resolves to
// the CALLER'S OWN workspace (selfWorkspaceId — MOLECULE_WORKSPACE_ID /
// WORKSPACE_ID), which is the self-schedule (audience=self) flow: a workspace
// authoring its own schedules under its own workspace token. When neither a
// param nor an env id is present we FAIL CLOSED with INVALID_ARGUMENTS rather
// than emitting a request to `/workspaces/undefined/...`.
//
// Security note: passing an explicit FOREIGN workspace_id is NOT a bypass — in
// self mode the bearer is the per-workspace token (see api.ts::authHeaders),
// which core's WorkspaceAuth binds to its own :id, so a foreign :id 401s. This
// resolver only supplies the default; it never escalates the credential.
const WORKSPACE_ID_SCHEMA = z
  .string()
  .optional()
  .describe(
    "Target workspace UUID. Optional — defaults to the caller's own workspace " +
      "(self-schedule). A workspace token can only act on its own id.",
  );

/**
 * Resolve the effective workspace id (explicit param first, else self), or a
 * fail-closed INVALID_ARGUMENTS MCP result when neither is available. Returns a
 * discriminated result so callers `return r.error` before any network call.
 */
function resolveWorkspaceId(
  workspaceId: string | undefined,
): { id: string } | { error: ReturnType<typeof toMcpResult> } {
  const id = workspaceId || selfWorkspaceId();
  if (!id) {
    return {
      error: toMcpResult({
        error: "INVALID_ARGUMENTS",
        detail:
          "workspace_id is required — pass the target workspace UUID, or run " +
          "in self mode (MOLECULE_MCP_MODE=self) so it defaults to the caller's " +
          "own workspace (WORKSPACE_ID / MOLECULE_WORKSPACE_ID).",
      }),
    };
  }
  return { id };
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
  srv.tool(
    "list_schedules",
    "List cron schedules for a workspace.",
    { workspace_id: WORKSPACE_ID_SCHEMA },
    handleListSchedules,
  );

  srv.tool(
    "create_schedule",
    "Create a cron schedule that fires a prompt on a recurring timer.",
    {
      workspace_id: WORKSPACE_ID_SCHEMA,
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
      workspace_id: WORKSPACE_ID_SCHEMA,
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
    { workspace_id: WORKSPACE_ID_SCHEMA, schedule_id: z.string() },
    handleDeleteSchedule,
  );

  srv.tool(
    "run_schedule",
    "Fire a schedule manually, bypassing its cron expression.",
    { workspace_id: WORKSPACE_ID_SCHEMA, schedule_id: z.string() },
    handleRunSchedule,
  );

  srv.tool(
    "get_schedule_history",
    "Get past runs of a schedule — status, start/end, output preview.",
    { workspace_id: WORKSPACE_ID_SCHEMA, schedule_id: z.string() },
    handleGetScheduleHistory,
  );
}
