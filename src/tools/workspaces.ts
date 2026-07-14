import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiCall, platformGet, toMcpResult, isApiError } from "../api.js";

// Supported runtimes the platform provisioner will honor. Mirrors the
// workspace-server allowlist (`internal/handlers/runtime_registry.go`
// fallbackRuntimes + the template-derived set). This is the *client-side*
// fail-closed guard for the provision_workspace tool: the orchestrator
// gets a clear INVALID_ARGUMENTS instead of the platform silently
// coercing an unknown/empty runtime to langgraph (the #184 / control-
// plane #188 footgun). It is intentionally NOT the authoritative list —
// the platform must still hard-gate (controlplane#188) — but it stops
// the most common caller mistake (typo / omitted runtime) at the door.
export const SUPPORTED_RUNTIMES = [
  "claude-code",
  "codex",
  "hermes",
  "openclaw",
  "langgraph",
  "autogen",
  "crewai",
  "deepagents",
  "kimi",
  "kimi-cli",
  "external",
] as const;

// Canonical default template per runtime. The product "New Workspace"
// dialog sends a `template` (e.g. "claude-code-default"); the workspace-
// server derives the runtime from the template's config.yaml. Sending
// BOTH (template + runtime) is the most robust call: template drives the
// correct config/image, runtime is the assertion target for the
// request==delivered echo-back check below.
function defaultTemplateFor(runtime: string): string {
  // BYO-compute meta-runtimes have no template repo.
  if (runtime === "external" || runtime === "kimi" || runtime === "kimi-cli") {
    return "";
  }
  return `${runtime}-default`;
}

export async function handleListWorkspaces() {
  const data = await platformGet("/workspaces");
  return toMcpResult(data);
}

// Random canvas seeding so MCP-created workspaces don't all stack at (0,0).
// The platform stores these; canvas drag-drop overrides them immediately.
function initialCanvasPosition() {
  return { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 };
}

export async function handleCreateWorkspace(params: {
  name: string;
  role?: string;
  template?: string;
  tier?: number;
  parent_id?: string;
  runtime?: string;
  workspace_dir?: string;
  workspace_access?: "none" | "read_only" | "read_write";
}) {
  const { name, role, template, tier, parent_id, runtime, workspace_dir, workspace_access } = params;
  const data = await apiCall("POST", "/workspaces", {
    name, role, template, tier, parent_id, runtime,
    workspace_dir, workspace_access,
    canvas: initialCanvasPosition(),
  });
  return toMcpResult(data);
}

/**
 * provision_workspace — agent-facing, fail-closed workspace provisioning.
 *
 * Why this exists (separate from create_workspace): the orchestrator needs
 * to bring up the production agent team with a SPECIFIC runtime
 * (claude-code / codex / hermes / openclaw / ...). Both the CP-direct
 * path AND the raw create path can return success while silently
 * delivering a langgraph workspace when the runtime can't be resolved
 * (#184 / molecule-controlplane#188). A "201 but wrong runtime" is a
 * contract violation, not a degraded success.
 *
 * This tool enforces the same fail-closed contract on the client side:
 *   1. Validate `runtime` against SUPPORTED_RUNTIMES — reject unknown
 *      BEFORE any platform call (the SDK schema enum also enforces this;
 *      this is defense-in-depth + a clearer error).
 *   2. Call the correct PRODUCT create path (POST /workspaces with both
 *      `template` and `runtime`), NOT the CP-direct
 *      /cp/workspaces/provision path the orchestrator had been forced to
 *      use. Template drives the correct config/image; runtime is the
 *      assertion target.
 *   3. Read the created workspace back and assert resolved runtime ==
 *      requested runtime. On mismatch (or no runtime echoed) return a
 *      structured FAILED-CLOSED error with the resolved value so the
 *      caller can NOT mistake a langgraph fallback for success.
 *
 * The platform-side hard-gate is still required (controlplane#188 +
 * its workspace-server sibling) — this tool does not substitute for it,
 * it makes the agent-facing surface honest in the meantime.
 */
export async function handleProvisionWorkspace(params: {
  name: string;
  runtime: string;
  template?: string;
  tier?: number;
  role?: string;
  parent_id?: string;
  workspace_dir?: string;
  workspace_access?: "none" | "read_only" | "read_write";
  role_config?: {
    model?: string;
    config_yaml?: string;
  };
}) {
  const { name, runtime, tier, role, parent_id, workspace_dir, workspace_access } = params;

  // (1) Fail-closed runtime validation BEFORE any side effect.
  if (!(SUPPORTED_RUNTIMES as readonly string[]).includes(runtime)) {
    return toMcpResult({
      error: "UNSUPPORTED_RUNTIME",
      detail: `runtime "${runtime}" is not supported; supported: ${SUPPORTED_RUNTIMES.join(", ")}`,
      requested_runtime: runtime,
      provisioned: false,
    });
  }

  // (2) Resolve template. Caller may override; default is the canonical
  // "<runtime>-default" template the product UI uses. Sending both
  // template + runtime is the most robust call (template → correct
  // config/image, runtime → assertion target).
  const template = params.template ?? defaultTemplateFor(runtime);

  const created = await apiCall("POST", "/workspaces", {
    name,
    role,
    template: template || undefined,
    tier,
    parent_id,
    runtime,
    workspace_dir,
    workspace_access,
    canvas: initialCanvasPosition(),
  });

  if (isApiError(created)) {
    return toMcpResult({
      error: "PROVISION_FAILED",
      detail: created,
      requested_runtime: runtime,
      provisioned: false,
    });
  }

  const createdObj = (created ?? {}) as Record<string, unknown>;
  const workspaceId =
    typeof createdObj.id === "string" ? createdObj.id : undefined;

  if (!workspaceId) {
    return toMcpResult({
      error: "PROVISION_FAILED",
      detail: "create succeeded but no workspace id returned; cannot verify resolved runtime",
      requested_runtime: runtime,
      create_response: created,
      provisioned: false,
    });
  }

  // (3) Read back and assert request == delivered. The create response
  // does not always echo the persisted runtime, so re-fetch the row.
  const fetched = await platformGet(`/workspaces/${workspaceId}`);
  let resolvedRuntime: string | undefined;
  if (!isApiError(fetched) && fetched && typeof fetched === "object") {
    const f = fetched as Record<string, unknown>;
    if (typeof f.runtime === "string") resolvedRuntime = f.runtime;
  }

  // BYO-compute runtimes may be normalized (e.g. "" -> "external");
  // treat the requested value as authoritative for those.
  const requestedIsByo =
    runtime === "external" || runtime === "kimi" || runtime === "kimi-cli";

  if (resolvedRuntime === undefined) {
    return toMcpResult({
      error: "PROVISION_UNVERIFIED",
      detail:
        "workspace was created but its resolved runtime could not be read back; " +
        "treat as NOT verified — do not assume the requested runtime was honored",
      workspace_id: workspaceId,
      requested_runtime: runtime,
      provisioned: false,
    });
  }

  if (!requestedIsByo && resolvedRuntime !== runtime) {
    return toMcpResult({
      error: "RUNTIME_MISMATCH",
      detail:
        `requested runtime "${runtime}" but the platform provisioned ` +
        `"${resolvedRuntime}" (silent fallback — this is the #184 / ` +
        `controlplane#188 contract violation). The workspace exists but ` +
        `is the WRONG runtime; delete it and escalate (platform hard-gate ` +
        `not yet shipped).`,
      workspace_id: workspaceId,
      requested_runtime: runtime,
      resolved_runtime: resolvedRuntime,
      provisioned: false,
    });
  }

  // (4) Optional role-config application + read-back-assert. Runtime is
  // verified above; now fold in the per-role config so "create" and
  // "apply-role-config" are ONE fail-closed operation instead of two
  // (the #218 prod-team defect: workspaces provisioned with the right
  // runtime but template-default role config — generic name, Sonnet
  // instead of the role's model, empty charter — because per-role
  // config was never applied as part of provisioning).
  //
  // Mechanism (canonical, source-verified against molecule-core
  // workspace-server):
  //   - model  → PUT /workspaces/:id/model  (writes the MODEL_PROVIDER
  //     workspace_secret; AUTHORITATIVE over config.yaml's
  //     runtime_config.model per the claude-code adapter resolution
  //     order; auto-restarts). Read back via GET /workspaces/:id/model
  //     and ASSERT effective == requested — never trust the write-ack.
  //   - config.yaml (name/description/charter/required_env) → PUT
  //     /workspaces/:id/files/config.yaml through the tenant Files API (the
  //     platform applies the update and restart). NOTE: the GET-back of
  //     config.yaml resolves a DIFFERENT storage path than the PUT
  //     (documented asymmetry — molecule-core
  //     tests/e2e/test_staging_full_saas.sh), so config.yaml content is
  //     NOT read-back-asserted here; the model read-back is the
  //     authoritative effective-config gate.
  if (params.role_config) {
    const rc = params.role_config;
    const applied: Record<string, unknown> = {};

    if (typeof rc.config_yaml === "string" && rc.config_yaml.length > 0) {
      const w = await apiCall(
        "PUT",
        `/workspaces/${workspaceId}/files/config.yaml`,
        { content: rc.config_yaml }
      );
      if (isApiError(w)) {
        return toMcpResult({
          error: "ROLE_CONFIG_FAILED",
          detail: w,
          phase: "config.yaml",
          workspace_id: workspaceId,
          requested_runtime: runtime,
          resolved_runtime: resolvedRuntime,
          provisioned: true,
          role_config_applied: false,
        });
      }
      applied.config_yaml = "written";
    }

    if (typeof rc.model === "string" && rc.model.length > 0) {
      const m = await apiCall("PUT", `/workspaces/${workspaceId}/model`, {
        model: rc.model,
      });
      if (isApiError(m)) {
        return toMcpResult({
          error: "ROLE_CONFIG_FAILED",
          detail: m,
          phase: "model",
          workspace_id: workspaceId,
          requested_runtime: runtime,
          resolved_runtime: resolvedRuntime,
          provisioned: true,
          role_config_applied: false,
        });
      }

      // Read-back-assert the EFFECTIVE model — not the write-ack.
      const mb = await platformGet(`/workspaces/${workspaceId}/model`);
      let effectiveModel: string | undefined;
      if (!isApiError(mb) && mb && typeof mb === "object") {
        const v = (mb as Record<string, unknown>).model;
        if (typeof v === "string") effectiveModel = v;
      }
      if (effectiveModel !== rc.model) {
        return toMcpResult({
          error: "ROLE_CONFIG_MODEL_MISMATCH",
          detail:
            `requested model "${rc.model}" but read-back returned ` +
            `"${effectiveModel ?? "<unreadable>"}" — the role's model was ` +
            `NOT applied; treat as NOT configured (do not assume the ` +
            `requested model is in effect).`,
          workspace_id: workspaceId,
          requested_model: rc.model,
          effective_model: effectiveModel ?? null,
          requested_runtime: runtime,
          resolved_runtime: resolvedRuntime,
          provisioned: true,
          role_config_applied: false,
        });
      }
      applied.model = effectiveModel;
    }

    return toMcpResult({
      ok: true,
      provisioned: true,
      role_config_applied: true,
      workspace_id: workspaceId,
      requested_runtime: runtime,
      resolved_runtime: resolvedRuntime,
      template: template || null,
      applied,
      status: createdObj.status ?? "provisioning",
    });
  }

  return toMcpResult({
    ok: true,
    provisioned: true,
    role_config_applied: false,
    workspace_id: workspaceId,
    requested_runtime: runtime,
    resolved_runtime: resolvedRuntime,
    template: template || null,
    status: createdObj.status ?? "provisioning",
  });
}

export async function handleGetWorkspace(params: { workspace_id: string }) {
  const data = await platformGet(`/workspaces/${params.workspace_id}`);
  return toMcpResult(data);
}

export async function handleDeleteWorkspace(params: { workspace_id: string; confirm_name?: string }) {
  const headers = params.confirm_name ? { "X-Confirm-Name": params.confirm_name } : undefined;
  const data = await apiCall("DELETE", `/workspaces/${params.workspace_id}?confirm=true`, undefined, headers);
  return toMcpResult(data);
}

export async function handleRestartWorkspace(params: { workspace_id: string }) {
  const data = await apiCall("POST", `/workspaces/${params.workspace_id}/restart`, {});
  return toMcpResult(data);
}

export async function handleUpdateWorkspace(params: {
  workspace_id: string;
  name?: string;
  role?: string;
  tier?: number;
  parent_id?: string | null;
  workspace_dir?: string;
  workspace_access?: "none" | "read_only" | "read_write";
}) {
  const { workspace_id, ...fields } = params;
  const data = await apiCall("PATCH", `/workspaces/${workspace_id}`, fields);
  return toMcpResult(data);
}

export async function handlePauseWorkspace(params: { workspace_id: string }) {
  const data = await apiCall("POST", `/workspaces/${params.workspace_id}/pause?cascade=true`, {});
  return toMcpResult(data);
}

export async function handleResumeWorkspace(params: { workspace_id: string }) {
  const data = await apiCall("POST", `/workspaces/${params.workspace_id}/resume?cascade=true`, {});
  return toMcpResult(data);
}

export function registerWorkspaceTools(srv: McpServer) {
  srv.tool("list_workspaces", "List all workspaces with their status, skills, and hierarchy", {}, handleListWorkspaces);

  srv.tool(
    "create_workspace",
    "Create a new workspace node on the canvas",
    {
      name: z.string().describe("Workspace name"),
      role: z.string().optional().describe("Role description"),
      template: z.string().optional().describe("Template name from workspace-configs-templates/"),
      tier: z.number().min(1).max(4).default(1).describe("Tier (1=basic, 2=browser, 3=desktop, 4=VM)"),
      parent_id: z.string().optional().describe("Parent workspace ID for nesting"),
      runtime: z.string().optional().describe("Runtime: claude-code, langgraph, openclaw, deepagents, autogen, crewai, hermes, external"),
      workspace_dir: z.string().optional().describe("Host path to bind-mount at /workspace (PM only by convention)"),
      workspace_access: z.enum(["none", "read_only", "read_write"]).optional().describe("Filesystem access mode for /workspace"),
    },
    handleCreateWorkspace
  );

  srv.tool(
    "provision_workspace",
    "Provision a workspace with a SPECIFIC runtime (claude-code, codex, hermes, openclaw, langgraph, autogen, crewai, deepagents) via the correct product create path. Fail-closed: validates the runtime, then reads the created workspace back and returns an error (not a success) if the platform silently fell back to a different runtime. Use this — not create_workspace — when the runtime must be guaranteed.",
    {
      name: z.string().describe("Workspace name"),
      runtime: z
        .enum(SUPPORTED_RUNTIMES)
        .describe("Required runtime — provisioning fails closed if it cannot be honored"),
      template: z
        .string()
        .optional()
        .describe("Template name (defaults to '<runtime>-default'); overrides runtime-derived template"),
      tier: z.number().min(1).max(4).optional().describe("Tier (1=basic, 2=browser, 3=desktop, 4=VM). SaaS forces T4."),
      role: z.string().optional().describe("Role description"),
      parent_id: z.string().optional().describe("Parent workspace ID for nesting"),
      workspace_dir: z.string().optional().describe("Host path to bind-mount at /workspace"),
      workspace_access: z
        .enum(["none", "read_only", "read_write"])
        .optional()
        .describe("Filesystem access mode for /workspace"),
      role_config: z
        .object({
          model: z
            .string()
            .optional()
            .describe(
              "Effective model slug for this role (e.g. 'opus', 'kimi-for-coding', 'MiniMax-M2.7', 'gpt-5.5'). Applied via PUT /model (authoritative over config.yaml) and read-back-asserted — provisioning fails closed if the effective model does not match."
            ),
          config_yaml: z
            .string()
            .optional()
            .describe(
              "Full config.yaml content for the role (name, description/charter, runtime_config.model, required_env). Written via the Files API; preserve the template's providers registry. NOT read-back-asserted (PUT/GET path asymmetry) — the model read-back is the effective-config gate."
            ),
        })
        .optional()
        .describe(
          "Optional per-role config applied + verified as part of the SAME fail-closed provision op. Without this, a workspace can be the right runtime but carry template-default role config (the #218 defect)."
        ),
    },
    handleProvisionWorkspace
  );

  srv.tool(
    "get_workspace",
    "Get detailed information about a specific workspace",
    { workspace_id: z.string().describe("Workspace ID") },
    handleGetWorkspace
  );

  srv.tool(
    "delete_workspace",
    "Delete a workspace (cascades to children).",
    {
      workspace_id: z.string().describe("Workspace ID"),
      confirm_name: z.string().optional().describe("Echo the workspace's exact name to confirm destructive action"),
    },
    handleDeleteWorkspace
  );

  srv.tool(
    "restart_workspace",
    "Restart an offline or failed workspace",
    { workspace_id: z.string().describe("Workspace ID") },
    handleRestartWorkspace
  );

  srv.tool(
    "update_workspace",
    "Update workspace fields (name, role, tier, parent_id, position)",
    {
      workspace_id: z.string(),
      name: z.string().optional(),
      role: z.string().optional(),
      tier: z.number().optional(),
      parent_id: z.string().optional().nullable().describe("Set parent for nesting, null to un-nest"),
    },
    handleUpdateWorkspace
  );

  srv.tool(
    "pause_workspace",
    "Pause a workspace (stops container, preserves config)",
    { workspace_id: z.string().describe("Workspace ID") },
    handlePauseWorkspace
  );

  srv.tool(
    "resume_workspace",
    "Resume a paused workspace",
    { workspace_id: z.string().describe("Workspace ID") },
    handleResumeWorkspace
  );
}
