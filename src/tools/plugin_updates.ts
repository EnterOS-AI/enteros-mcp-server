import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult } from "../api.js";

// Plugin auto-update MANAGEMENT verbs (mcp-server#mcp-verbs).
//
// These back the concierge's plugin-auto-update schedule: a cron-fired
// management-mode agent lists the plugins that have drifted (upstream moved
// past the tracked ref) and applies each pending update. They are registered
// ONLY in the management branch of createServer() (alongside the cross-workspace
// schedule tools) because the underlying core routes are AdminAuth-gated and the
// bearer is the org API key — api.ts::authHeaders() emits MOLECULE_ORG_API_KEY
// EXCLUSIVELY in management mode (the #114 code-gate). Core's AdminAuth admits an
// org-scoped API token at Tier-2a (wsauth_middleware.go), so the org key that the
// management surface already carries is sufficient; no ADMIN_TOKEN is needed.
//
// Core contract (molecule-core workspace-server, admin_plugin_drift.go):
//   GET  /admin/plugin-updates-pending  — list all pending drift entries
//                                         (PluginUpdateQueueRow[]: id, workspace_id,
//                                          plugin_name, tracked_ref, current_sha,
//                                          latest_sha, status, created_at)
//   POST /admin/plugin-updates/:id/apply — apply the queued drift update keyed by
//                                          its queue :id (re-install at the tracked
//                                          ref, record the new SHA, restart). No body.

/**
 * check_plugin_updates — READ-ONLY. GET the pending plugin-update (drift) queue.
 * Returns the list of plugins that have a newer version available at their
 * tracked ref (id / workspace_id / plugin_name / current_sha / latest_sha).
 * No side effects.
 */
export async function handleCheckPluginUpdates() {
  const data = await platformGet("/admin/plugin-updates-pending");
  return toMcpResult(data);
}

/**
 * apply_plugin_update — POST the hardened apply route for a single pending-update
 * queue id. This is the auto-apply path (no approval gate — product decision):
 * core re-installs the plugin at its tracked ref, records the new SHA, dedups
 * against an already-applied entry, and restarts the target workspace. Returns
 * the core apply result ({ status, workspace_id, plugin_name, installed_sha,
 * restarting }).
 *
 * `id` is the plugin_update_queue entry id from check_plugin_updates — the apply
 * route is keyed by that queue id, not by workspace_id + plugin. Fail closed
 * (INVALID_ARGUMENTS, no request) on an empty id: this is a side-effecting POST,
 * so we never fire it without an explicit target.
 */
export async function handleApplyPluginUpdate(params: { id: string }) {
  const id = (params.id ?? "").trim();
  if (!id) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail:
        "id is required — pass the pending-update queue id from check_plugin_updates.",
    });
  }
  const data = await apiCall("POST", `/admin/plugin-updates/${id}/apply`);
  return toMcpResult(data);
}

export function registerPluginUpdateTools(srv: McpServer) {
  srv.tool(
    "check_plugin_updates",
    "List pending plugin updates — plugins whose tracked upstream ref has moved " +
      "past the installed version. Read-only; no side effects.",
    {},
    handleCheckPluginUpdates,
  );

  srv.tool(
    "apply_plugin_update",
    "Apply a single pending plugin update by its queue id (from " +
      "check_plugin_updates): re-install at the tracked ref, record the new SHA, " +
      "and restart the workspace. Auto-apply path — no approval gate.",
    {
      id: z
        .string()
        .describe("Pending-update queue id (from check_plugin_updates)."),
    },
    handleApplyPluginUpdate,
  );
}
