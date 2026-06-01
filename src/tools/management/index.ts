/**
 * Management tool registry — the cross-org / org-lifecycle management surface
 * the legacy single-tenant workspace-ops registry lacks.
 *
 * Auth: Org API Key (full tenant-admin) against the PER-ORG tenant host. See
 * ./client.ts for the auth model and the security caveat (org key = tenant
 * root, self-minting). The few CP-tier tools (list_orgs / get_org) live in
 * ./cp_admin.ts because the Org API Key CANNOT reach the control plane.
 *
 * Every endpoint + request body below is derived from the canonical tenant
 * router/handler source (molecule-core/workspace-server/internal/router/
 * router.go + internal/handlers/*), which is the same source the management
 * OpenAPI is being authored from. Tool names + param names align to that
 * contract.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpResult } from "../../api.js";
import { validate } from "../../utils/validation.js";
import { mgmtCall, mgmtGet, defaultOrgId } from "./client.js";
import { registerCpAdminTools } from "./cp_admin.js";

// ---------------------------------------------------------------------------
// Schemas (aligned to the tenant handler request shapes)
// ---------------------------------------------------------------------------

const GetWorkspaceSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
});

const ProvisionWorkspaceSchema = z.object({
  name: z.string().describe("Workspace name"),
  role: z.string().optional().describe("Role description"),
  template: z.string().optional().describe("Template name from the org's config templates"),
  runtime: z
    .string()
    .optional()
    .describe("Runtime: claude-code, langgraph, deepagents, autogen, crewai, hermes, codex, google-adk, external"),
  tier: z.number().int().min(1).max(4).optional().describe("Tier (1=basic, 2=browser, 3=desktop, 4=VM)"),
  parent_id: z.string().optional().describe("Parent workspace UUID for nesting"),
  model: z.string().optional().describe("LLM model id"),
});

const DeprovisionWorkspaceSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
});

const WorkspaceLifecycleSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
});

// Secrets ------------------------------------------------------------------

const SetWorkspaceSecretSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
  key: z.string().describe("Secret key (e.g. ANTHROPIC_API_KEY). Workspace env vars ARE secrets."),
  value: z.string().describe("Secret value"),
});
const ListWorkspaceSecretsSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
});
const DeleteWorkspaceSecretSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
  key: z.string().describe("Secret key"),
});
const SetOrgSecretSchema = z.object({
  key: z.string().describe("Secret key (e.g. GITHUB_TOKEN). Org-wide, available to all workspaces."),
  value: z.string().describe("Secret value"),
});
const DeleteOrgSecretSchema = z.object({
  key: z.string().describe("Secret key"),
});

// Budget / billing ---------------------------------------------------------

const BUDGET_PERIODS = ["hourly", "daily", "weekly", "monthly"] as const;
const SetWorkspaceBudgetSchema = z
  .object({
    workspace_id: z.string().describe("Workspace UUID"),
    budget_limits: z
      .record(z.enum(BUDGET_PERIODS), z.number().int().min(0).nullable())
      .optional()
      .describe("Map of period→USD-cents limit. null clears a period. e.g. {\"monthly\":50000}"),
    budget_limit: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("Legacy single monthly limit (USD cents). Prefer budget_limits."),
  })
  .refine((v) => v.budget_limits !== undefined || v.budget_limit !== undefined, {
    message: "budget_limits or budget_limit is required",
  });

const SetLlmBillingModeSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
  mode: z
    .enum(["platform_managed", "byok", "disabled"])
    .nullable()
    .describe("Billing mode override. null clears the override (inherit org default)."),
});

// Templates / org import ---------------------------------------------------

const CreateOrgFromTemplateSchema = z
  .object({
    dir: z.string().optional().describe("Org template directory name (e.g. 'molecule-dev')"),
    template: z.record(z.unknown()).optional().describe("Inline org template object (alternative to dir)"),
    mode: z
      .enum(["merge", "reconcile"])
      .optional()
      .describe("merge (default, additive) or reconcile (additive + cascade-delete zombies)"),
  })
  .refine((v) => v.dir !== undefined || v.template !== undefined, {
    message: "dir or template is required",
  });

const ImportTemplateSchema = z.object({
  name: z.string().describe("Template name"),
  files: z.record(z.string()).describe("Map of file path → content"),
});

// Tokens -------------------------------------------------------------------

const MintOrgTokenSchema = z.object({
  name: z.string().max(100).optional().describe("Human label for the token (max 100 chars)"),
});
const RevokeOrgTokenSchema = z.object({
  id: z.string().describe("Org token id to revoke"),
});
const MintWorkspaceTokenSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID to mint a bearer token for"),
});

// Plugin allowlist ---------------------------------------------------------

const GetOrgPluginAllowlistSchema = z.object({
  org_id: z.string().optional().describe("Org id (defaults to MOLECULE_ORG_ID)"),
});
const SetOrgPluginAllowlistSchema = z.object({
  org_id: z.string().optional().describe("Org id (defaults to MOLECULE_ORG_ID)"),
  plugins: z.array(z.string()).describe("Full allowlist of approved plugin names (replaces existing)"),
  // REQUIRED: the tenant PutAllowlist handler 400s ("enabled_by is required")
  // when this is empty, so reject it client-side rather than round-trip a 400.
  enabled_by: z.string().min(1).describe("Workspace id of the admin making the change (audit)"),
});

// Bundles ------------------------------------------------------------------

const ExportBundleSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID to export as a portable bundle"),
});
const ImportBundleSchema = z.object({
  bundle: z.record(z.unknown()).describe("Bundle JSON object"),
});

// Events -------------------------------------------------------------------

const ListOrgEventsSchema = z.object({
  workspace_id: z.string().optional().describe("Filter to one workspace, or omit for the whole org"),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// Workspaces lifecycle -----------------------------------------------------

export async function handleListWorkspaces() {
  return toMcpResult(await mgmtGet("/workspaces"));
}

export async function handleGetWorkspace(args: unknown) {
  const p = validate(args, GetWorkspaceSchema);
  return toMcpResult(await mgmtGet(`/workspaces/${p.workspace_id}`));
}

export async function handleProvisionWorkspace(args: unknown) {
  const p = validate(args, ProvisionWorkspaceSchema);
  // Tenant POST /workspaces (AdminAuth — the Org API Key satisfies it).
  // This is the org-key-reachable provision lever; the CP /cp/workspaces/
  // provision path needs the provision-secret tier (see cp_admin.ts note).
  return toMcpResult(
    await mgmtCall("POST", "/workspaces", {
      name: p.name,
      role: p.role,
      template: p.template,
      runtime: p.runtime,
      tier: p.tier,
      parent_id: p.parent_id,
      model: p.model,
    }),
  );
}

export async function handleDeprovisionWorkspace(args: unknown) {
  const p = validate(args, DeprovisionWorkspaceSchema);
  return toMcpResult(await mgmtCall("DELETE", `/workspaces/${p.workspace_id}`));
}

export async function handleRestartWorkspace(args: unknown) {
  const p = validate(args, WorkspaceLifecycleSchema);
  return toMcpResult(await mgmtCall("POST", `/workspaces/${p.workspace_id}/restart`, {}));
}

export async function handlePauseWorkspace(args: unknown) {
  const p = validate(args, WorkspaceLifecycleSchema);
  return toMcpResult(await mgmtCall("POST", `/workspaces/${p.workspace_id}/pause`, {}));
}

export async function handleResumeWorkspace(args: unknown) {
  const p = validate(args, WorkspaceLifecycleSchema);
  return toMcpResult(await mgmtCall("POST", `/workspaces/${p.workspace_id}/resume`, {}));
}

// Secrets ------------------------------------------------------------------

export async function handleSetWorkspaceSecret(args: unknown) {
  const p = validate(args, SetWorkspaceSecretSchema);
  // POST /workspaces/:id/secrets upserts AES-256-GCM + auto-restarts the ws.
  return toMcpResult(
    await mgmtCall("POST", `/workspaces/${p.workspace_id}/secrets`, { key: p.key, value: p.value }),
  );
}

export async function handleListWorkspaceSecrets(args: unknown) {
  const p = validate(args, ListWorkspaceSecretsSchema);
  return toMcpResult(await mgmtGet(`/workspaces/${p.workspace_id}/secrets`));
}

export async function handleDeleteWorkspaceSecret(args: unknown) {
  const p = validate(args, DeleteWorkspaceSecretSchema);
  return toMcpResult(
    await mgmtCall("DELETE", `/workspaces/${p.workspace_id}/secrets/${encodeURIComponent(p.key)}`),
  );
}

export async function handleSetOrgSecret(args: unknown) {
  const p = validate(args, SetOrgSecretSchema);
  // POST /settings/secrets (AdminAuth) — canonical org-wide secret path.
  return toMcpResult(await mgmtCall("POST", "/settings/secrets", { key: p.key, value: p.value }));
}

export async function handleListOrgSecrets() {
  return toMcpResult(await mgmtGet("/settings/secrets"));
}

export async function handleDeleteOrgSecret(args: unknown) {
  const p = validate(args, DeleteOrgSecretSchema);
  return toMcpResult(await mgmtCall("DELETE", `/settings/secrets/${encodeURIComponent(p.key)}`));
}

// Budget / billing ---------------------------------------------------------

export async function handleSetWorkspaceBudget(args: unknown) {
  const p = validate(args, SetWorkspaceBudgetSchema);
  const body: Record<string, unknown> = {};
  if (p.budget_limits !== undefined) body.budget_limits = p.budget_limits;
  if (p.budget_limit !== undefined) body.budget_limit = p.budget_limit;
  // PATCH /workspaces/:id/budget (AdminAuth — agents cannot self-clear).
  return toMcpResult(await mgmtCall("PATCH", `/workspaces/${p.workspace_id}/budget`, body));
}

export async function handleSetLlmBillingMode(args: unknown) {
  const p = validate(args, SetLlmBillingModeSchema);
  // PUT /admin/workspaces/:id/llm-billing-mode. mode:null = clear override.
  return toMcpResult(
    await mgmtCall("PUT", `/admin/workspaces/${p.workspace_id}/llm-billing-mode`, { mode: p.mode }),
  );
}

// Templates / org import ---------------------------------------------------

export async function handleListOrgTemplates() {
  return toMcpResult(await mgmtGet("/org/templates"));
}

export async function handleCreateOrgFromTemplate(args: unknown) {
  const p = validate(args, CreateOrgFromTemplateSchema);
  const body: Record<string, unknown> = {};
  if (p.dir !== undefined) body.dir = p.dir;
  if (p.template !== undefined) body.template = p.template;
  if (p.mode !== undefined) body.mode = p.mode;
  // POST /org/import — creates an entire workspace hierarchy from a template.
  return toMcpResult(await mgmtCall("POST", "/org/import", body));
}

export async function handleListTemplates() {
  return toMcpResult(await mgmtGet("/templates"));
}

export async function handleImportTemplate(args: unknown) {
  const p = validate(args, ImportTemplateSchema);
  return toMcpResult(await mgmtCall("POST", "/templates/import", { name: p.name, files: p.files }));
}

// Tokens -------------------------------------------------------------------

export async function handleMintOrgToken(args: unknown) {
  const p = validate(args, MintOrgTokenSchema);
  // POST /org/tokens — mints a full-tenant-admin org key. Plaintext shown ONCE.
  return toMcpResult(await mgmtCall("POST", "/org/tokens", { name: p.name }));
}

export async function handleListOrgTokens() {
  return toMcpResult(await mgmtGet("/org/tokens"));
}

export async function handleRevokeOrgToken(args: unknown) {
  const p = validate(args, RevokeOrgTokenSchema);
  return toMcpResult(await mgmtCall("DELETE", `/org/tokens/${encodeURIComponent(p.id)}`));
}

export async function handleMintWorkspaceToken(args: unknown) {
  const p = validate(args, MintWorkspaceTokenSchema);
  // POST /admin/workspaces/:id/tokens — mints a workspace-scoped bearer token.
  return toMcpResult(await mgmtCall("POST", `/admin/workspaces/${p.workspace_id}/tokens`, {}));
}

// Plugin allowlist ---------------------------------------------------------

function resolveOrgId(explicit?: string): string | undefined {
  return explicit ?? defaultOrgId();
}

export async function handleGetOrgPluginAllowlist(args: unknown) {
  const p = validate(args, GetOrgPluginAllowlistSchema);
  const orgId = resolveOrgId(p.org_id);
  if (!orgId) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail: "org_id is required (or set MOLECULE_ORG_ID)",
    });
  }
  return toMcpResult(await mgmtGet(`/orgs/${encodeURIComponent(orgId)}/plugins/allowlist`));
}

export async function handleSetOrgPluginAllowlist(args: unknown) {
  const p = validate(args, SetOrgPluginAllowlistSchema);
  const orgId = resolveOrgId(p.org_id);
  if (!orgId) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail: "org_id is required (or set MOLECULE_ORG_ID)",
    });
  }
  // enabled_by is required (validated by the schema) — always send it; the
  // tenant handler hard-requires it (400 "enabled_by is required" otherwise).
  const body: Record<string, unknown> = { plugins: p.plugins, enabled_by: p.enabled_by };
  return toMcpResult(
    await mgmtCall("PUT", `/orgs/${encodeURIComponent(orgId)}/plugins/allowlist`, body),
  );
}

// Bundles ------------------------------------------------------------------

export async function handleExportBundle(args: unknown) {
  const p = validate(args, ExportBundleSchema);
  return toMcpResult(await mgmtGet(`/bundles/export/${p.workspace_id}`));
}

export async function handleImportBundle(args: unknown) {
  const p = validate(args, ImportBundleSchema);
  return toMcpResult(await mgmtCall("POST", "/bundles/import", p.bundle));
}

// Events / approvals -------------------------------------------------------

export async function handleListOrgEvents(args: unknown) {
  const p = validate(args, ListOrgEventsSchema);
  const path = p.workspace_id ? `/events/${p.workspace_id}` : "/events";
  return toMcpResult(await mgmtGet(path));
}

export async function handleListPendingApprovals() {
  return toMcpResult(await mgmtGet("/approvals/pending"));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerManagementTools(srv: McpServer) {
  // --- Workspaces lifecycle ---
  srv.tool(
    "list_workspaces",
    "Management: list every workspace in the org with status + hierarchy (Org API Key, tenant host).",
    {},
    handleListWorkspaces,
  );
  srv.tool(
    "get_workspace",
    "Management: get one workspace's detail by UUID.",
    { workspace_id: z.string().describe("Workspace UUID") },
    handleGetWorkspace,
  );
  srv.tool(
    "provision_workspace",
    "Management: provision a new workspace in the org (tenant POST /workspaces, AdminAuth).",
    {
      name: z.string().describe("Workspace name"),
      role: z.string().optional().describe("Role description"),
      template: z.string().optional().describe("Template name"),
      runtime: z.string().optional().describe("Runtime (claude-code, langgraph, codex, …)"),
      tier: z.number().int().min(1).max(4).optional().describe("Tier 1-4"),
      parent_id: z.string().optional().describe("Parent workspace UUID"),
      model: z.string().optional().describe("LLM model id"),
    },
    handleProvisionWorkspace,
  );
  srv.tool(
    "deprovision_workspace",
    "Management: delete/deprovision a workspace (cascades to children).",
    { workspace_id: z.string().describe("Workspace UUID") },
    handleDeprovisionWorkspace,
  );
  srv.tool(
    "restart_workspace",
    "Management: restart a workspace.",
    { workspace_id: z.string().describe("Workspace UUID") },
    handleRestartWorkspace,
  );
  srv.tool(
    "pause_workspace",
    "Management: pause a workspace (stops container, preserves config).",
    { workspace_id: z.string().describe("Workspace UUID") },
    handlePauseWorkspace,
  );
  srv.tool(
    "resume_workspace",
    "Management: resume a paused workspace.",
    { workspace_id: z.string().describe("Workspace UUID") },
    handleResumeWorkspace,
  );

  // --- Secrets ---
  srv.tool(
    "set_workspace_secret",
    "Management: set a workspace secret/env var (auto-restarts the workspace).",
    {
      workspace_id: z.string().describe("Workspace UUID"),
      key: z.string().describe("Secret key (e.g. ANTHROPIC_API_KEY)"),
      value: z.string().describe("Secret value"),
    },
    handleSetWorkspaceSecret,
  );
  srv.tool(
    "list_workspace_secrets",
    "Management: list a workspace's secret keys (values never exposed).",
    { workspace_id: z.string().describe("Workspace UUID") },
    handleListWorkspaceSecrets,
  );
  srv.tool(
    "delete_workspace_secret",
    "Management: delete a workspace secret.",
    { workspace_id: z.string().describe("Workspace UUID"), key: z.string().describe("Secret key") },
    handleDeleteWorkspaceSecret,
  );
  srv.tool(
    "set_org_secret",
    "Management: set an org-wide secret (available to all workspaces).",
    { key: z.string().describe("Secret key (e.g. GITHUB_TOKEN)"), value: z.string().describe("Secret value") },
    handleSetOrgSecret,
  );
  srv.tool(
    "list_org_secrets",
    "Management: list org-wide secret keys (values never exposed).",
    {},
    handleListOrgSecrets,
  );
  srv.tool(
    "delete_org_secret",
    "Management: delete an org-wide secret.",
    { key: z.string().describe("Secret key") },
    handleDeleteOrgSecret,
  );

  // --- Budget / billing ---
  srv.tool(
    "set_workspace_budget",
    "Management: set per-workspace spend ceilings (USD cents) per period.",
    {
      workspace_id: z.string().describe("Workspace UUID"),
      budget_limits: z
        .record(z.enum(BUDGET_PERIODS), z.number().int().min(0).nullable())
        .optional()
        .describe("Map period→USD-cents (null clears). Periods: hourly, daily, weekly, monthly"),
      budget_limit: z
        .number()
        .int()
        .min(0)
        .nullable()
        .optional()
        .describe("Legacy single monthly limit (USD cents)"),
    },
    handleSetWorkspaceBudget,
  );
  srv.tool(
    "set_llm_billing_mode",
    "Management: set a workspace's LLM billing-mode override (platform_managed|byok|disabled, or null to clear).",
    {
      workspace_id: z.string().describe("Workspace UUID"),
      mode: z
        .enum(["platform_managed", "byok", "disabled"])
        .nullable()
        .describe("Mode override; null clears (inherit org default)"),
    },
    handleSetLlmBillingMode,
  );

  // --- Templates / org import ---
  srv.tool(
    "list_org_templates",
    "Management: list the org template catalogue.",
    {},
    handleListOrgTemplates,
  );
  srv.tool(
    "create_org_from_template",
    "Management: create a workspace hierarchy from an org template (POST /org/import).",
    {
      dir: z.string().optional().describe("Org template directory name"),
      template: z.record(z.unknown()).optional().describe("Inline org template object"),
      mode: z.enum(["merge", "reconcile"]).optional().describe("merge (default) or reconcile"),
    },
    handleCreateOrgFromTemplate,
  );
  srv.tool(
    "list_templates",
    "Management: list available workspace templates.",
    {},
    handleListTemplates,
  );
  srv.tool(
    "import_template",
    "Management: import agent files as a new workspace template.",
    {
      name: z.string().describe("Template name"),
      files: z.record(z.string()).describe("Map of file path → content"),
    },
    handleImportTemplate,
  );

  // --- Tokens ---
  srv.tool(
    "mint_org_token",
    "Management: mint a new Org API Key (FULL TENANT-ADMIN — plaintext shown once).",
    { name: z.string().max(100).optional().describe("Human label (max 100 chars)") },
    handleMintOrgToken,
  );
  srv.tool(
    "list_org_tokens",
    "Management: list the org's API tokens (prefixes + metadata, never plaintext).",
    {},
    handleListOrgTokens,
  );
  srv.tool(
    "revoke_org_token",
    "Management: revoke an Org API Key by id.",
    { id: z.string().describe("Org token id") },
    handleRevokeOrgToken,
  );
  srv.tool(
    "mint_workspace_token",
    "Management: mint a workspace-scoped bearer token (e.g. for a remote/external agent).",
    { workspace_id: z.string().describe("Workspace UUID") },
    handleMintWorkspaceToken,
  );

  // --- Plugin allowlist ---
  srv.tool(
    "get_org_plugin_allowlist",
    "Management: get the org's plugin allowlist (tool governance).",
    { org_id: z.string().optional().describe("Org id (defaults to MOLECULE_ORG_ID)") },
    handleGetOrgPluginAllowlist,
  );
  srv.tool(
    "set_org_plugin_allowlist",
    "Management: replace the org's plugin allowlist.",
    {
      org_id: z.string().optional().describe("Org id (defaults to MOLECULE_ORG_ID)"),
      plugins: z.array(z.string()).describe("Full allowlist of approved plugin names"),
      enabled_by: z.string().min(1).describe("Admin workspace id (audit) — REQUIRED by the tenant handler"),
    },
    handleSetOrgPluginAllowlist,
  );

  // --- Bundles ---
  srv.tool(
    "export_bundle",
    "Management: export a workspace as a portable bundle.",
    { workspace_id: z.string().describe("Workspace UUID") },
    handleExportBundle,
  );
  srv.tool(
    "import_bundle",
    "Management: import a workspace from a bundle JSON object.",
    { bundle: z.record(z.unknown()).describe("Bundle JSON object") },
    handleImportBundle,
  );

  // --- Events / approvals ---
  srv.tool(
    "list_org_events",
    "Management: list org structure events (optionally filtered to a workspace).",
    { workspace_id: z.string().optional().describe("Filter to a workspace, or omit for all") },
    handleListOrgEvents,
  );
  srv.tool(
    "list_pending_approvals",
    "Management: list pending approval requests across the org's workspaces.",
    {},
    handleListPendingApprovals,
  );

  // --- CP-tier tools (separate module — Org API Key cannot reach CP) ---
  registerCpAdminTools(srv);
}
