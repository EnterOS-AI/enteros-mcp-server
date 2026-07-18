/**
 * Management tool registry — the cross-org / org-lifecycle management surface
 * the legacy single-tenant workspace-ops registry lacks.
 *
 * Auth: Org API Key (full tenant-admin) against the PER-ORG tenant host. See
 * ./client.ts for the auth model and the security caveat (org key = tenant
 * root, self-minting). The CP-tier tools (list_orgs / get_org /
 * promote_to_production / provider migration) live in ./cp_admin.ts because
 * the Org API Key CANNOT reach the control plane.
 *
 * Every endpoint + request body below is derived from the canonical tenant
 * router/handler source (molecule-core/workspace-server/internal/router/
 * router.go + internal/handlers/*), which is the same source the management
 * OpenAPI is being authored from. Tool names + param names align to that
 * contract.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpResult, isApiError } from "../../api.js";
import { validate } from "../../utils/validation.js";
import { mgmtCall, mgmtGet, defaultOrgId, selfWorkspaceId } from "./client.js";
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
  model: z
    .string()
    .optional()
    .describe("LLM model id. Omit unless the user named a model; omitted values use the platform default."),
});

const DeprovisionWorkspaceSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID"),
  confirm_name: z.string().optional().describe("Echo the workspace's exact name to confirm destructive action (maps to X-Confirm-Name header)"),
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

// Plugin install (self-reprovision §5.2) -------------------------------------

// install_plugin on the MANAGEMENT surface. The tenant endpoint
// (POST /workspaces/:id/plugins, WorkspaceAuth) is the sanctioned declare/
// install path: it resolve+stages the source FIRST (a bad repo/name/ref
// fails loud with a 4xx before anything is recorded), delivers the tree
// into the workspace container, records the (name, source) pair in
// workspace_plugins — which desiredPluginSources() unions into
// MOLECULE_DECLARED_PLUGINS on EVERY future (re)provision, so the install
// is durable — and by default schedules the existing restart flow
// (WorkspaceHandler.RestartByID) so boot-install picks the plugin up.
//
// workspace_id defaults to the CALLER'S OWN workspace (MOLECULE_WORKSPACE_ID),
// making agent self-install the zero-config case. Authorization is enforced
// server-side by the tenant WorkspaceAuth chain: an Org API Key (this
// management server's credential) may target any workspace in its org; a
// per-workspace bearer only validates against its own :id — so a normal
// agent can only ever install onto ITSELF.
const InstallPluginMgmtSchema = z.object({
  workspace_id: z
    .string()
    .optional()
    .describe("Target workspace UUID. Defaults to the caller's own workspace (MOLECULE_WORKSPACE_ID) — the self-install case."),
  source: z
    .string()
    .describe(
      "Plugin source: 'gitea://owner/repo[/subpath][#ref]' (private Gitea), " +
        "'local://<name>' (platform registry), 'github://owner/repo[#ref]', or any registered scheme.",
    ),
  restart: z
    .boolean()
    .optional()
    .describe(
      "Restart the workspace after install so boot-install activates the plugin (default true). " +
        "false = record + deliver only; the plugin activates on the next restart.",
    ),
});

export async function handleInstallPlugin(args: unknown) {
  const p = validate(args, InstallPluginMgmtSchema);
  // Default to SELF — same fail-closed pattern as get_conversation_history.
  const workspaceId = p.workspace_id || selfWorkspaceId();
  if (!workspaceId) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail:
        "workspace_id is required — pass the target workspace UUID, or set " +
        "MOLECULE_WORKSPACE_ID / WORKSPACE_ID so it defaults to the caller's own workspace.",
    });
  }
  const body: Record<string, unknown> = { source: p.source };
  if (p.restart !== undefined) body.restart = p.restart;
  return toMcpResult(
    await mgmtCall("POST", `/workspaces/${encodeURIComponent(workspaceId)}/plugins`, body),
  );
}

// Plugin discovery (self-reprovision §5.2 companion) -------------------------

// list_available_plugins on the MANAGEMENT surface. The catalog it reads is
// the tenant plugin registry, which is DERIVED from the marketplace registry
// SSOT (molecule-core manifest.json `plugins` — where plugin devs register;
// clone-manifest.sh materializes those entries into the tenant registry dir
// that GET /plugins and GET /workspaces/:id/plugins/available serve). Nothing
// here hardcodes a plugin list: entries, descriptions, kinds and runtimes all
// flow from each plugin's registered plugin.yaml.
//
// workspace_id defaults to the CALLER'S OWN workspace so the list arrives
// pre-filtered to plugins compatible with the caller's runtime. With no id at
// all (env unset), it degrades to the unfiltered org-wide registry rather
// than failing — a broader read is safe for discovery, unlike install.
const ListAvailablePluginsMgmtSchema = z.object({
  workspace_id: z
    .string()
    .optional()
    .describe(
      "Workspace UUID whose runtime the catalog is filtered for. Defaults to the caller's " +
        "own workspace (MOLECULE_WORKSPACE_ID); with neither set, returns the unfiltered registry.",
    ),
});

/**
 * Ensure every catalog entry carries an installable `source` handle. Registry
 * entries are served from the tenant's marketplace-derived registry dir, so
 * their canonical install handle is `local://<name>` — derived from the
 * entry's own registered name, never a hardcoded list. Entries that already
 * carry a source (future server versions) are passed through untouched.
 */
export function withInstallSources(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((e) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return e;
    const rec = e as Record<string, unknown>;
    if (typeof rec.source === "string" && rec.source !== "") return rec;
    if (typeof rec.name !== "string" || rec.name === "") return rec;
    return { ...rec, source: `local://${rec.name}` };
  });
}

export async function handleListAvailablePlugins(args: unknown) {
  const p = validate(args, ListAvailablePluginsMgmtSchema);
  const workspaceId = p.workspace_id || selfWorkspaceId();
  const res = workspaceId
    ? await mgmtGet(`/workspaces/${encodeURIComponent(workspaceId)}/plugins/available`)
    : await mgmtGet("/plugins");
  return toMcpResult(withInstallSources(res));
}

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

// Conversation history -----------------------------------------------------

// On-demand history page size. The agent-facing tool caps well below the
// tenant endpoint's 1000-row ceiling: this is a PULL surface the agent calls
// deliberately when it wants context, NOT a bulk export, so a small default +
// a modest max keeps a single call from dumping an entire chat log into the
// model's context window (the exact anti-pattern the direct-inject history
// removal — ws-runtime #222 / openclaw #139 / canvas #3416 — exists to kill).
// Callers walk further back with `before_cursor`, one page at a time.
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

const GetConversationHistorySchema = z.object({
  workspace_id: z
    .string()
    .optional()
    .describe(
      "Workspace UUID whose persisted conversation history to read. Defaults to " +
        "the caller's own workspace (MOLECULE_WORKSPACE_ID) when omitted. Must " +
        "belong to the caller's org — the tenant host authorizes it server-side.",
    ),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      `Page size (default ${HISTORY_DEFAULT_LIMIT}). Values above ${HISTORY_MAX_LIMIT} ` +
        `are clamped to ${HISTORY_MAX_LIMIT} and values below 1 to 1, so a single ` +
        "call can never dump the whole log. Messages are returned oldest-first.",
    ),
  before_cursor: z
    .string()
    .optional()
    .describe(
      "Pagination cursor: an RFC3339 timestamp; returns only messages strictly " +
        "OLDER than it. Pass the `next_before_cursor` from the previous page to " +
        "walk further back through history.",
    ),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const FALLBACK_PLATFORM_WORKSPACE_MODEL = "minimax/MiniMax-M2.7";

function defaultProvisionWorkspaceModel(): string {
  return (
    process.env.MOLECULE_LLM_DEFAULT_MODEL?.trim() ||
    process.env.MOLECULE_MODEL?.trim() ||
    process.env.MODEL?.trim() ||
    FALLBACK_PLATFORM_WORKSPACE_MODEL
  );
}

// Workspaces lifecycle -----------------------------------------------------

export async function handleListWorkspaces() {
  return toMcpResult(await mgmtGet("/workspaces"));
}

export async function handleGetWorkspace(args: unknown) {
  const p = validate(args, GetWorkspaceSchema);
  return toMcpResult(await mgmtGet(`/workspaces/${encodeURIComponent(p.workspace_id)}`));
}

export async function handleProvisionWorkspace(args: unknown) {
  const p = validate(args, ProvisionWorkspaceSchema);
  const model = p.model?.trim() || defaultProvisionWorkspaceModel();
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
      model,
    }),
  );
}

export async function handleDeprovisionWorkspace(args: unknown) {
  const p = validate(args, DeprovisionWorkspaceSchema);
  const headers = p.confirm_name ? { "X-Confirm-Name": p.confirm_name } : undefined;
  return toMcpResult(await mgmtCall("DELETE", `/workspaces/${encodeURIComponent(p.workspace_id)}`, undefined, headers));
}

export async function handleRestartWorkspace(args: unknown) {
  const p = validate(args, WorkspaceLifecycleSchema);
  return toMcpResult(await mgmtCall("POST", `/workspaces/${encodeURIComponent(p.workspace_id)}/restart`, {}));
}

export async function handlePauseWorkspace(args: unknown) {
  const p = validate(args, WorkspaceLifecycleSchema);
  return toMcpResult(await mgmtCall("POST", `/workspaces/${encodeURIComponent(p.workspace_id)}/pause?cascade=true`, {}));
}

export async function handleResumeWorkspace(args: unknown) {
  const p = validate(args, WorkspaceLifecycleSchema);
  return toMcpResult(await mgmtCall("POST", `/workspaces/${encodeURIComponent(p.workspace_id)}/resume?cascade=true`, {}));
}

// Secrets ------------------------------------------------------------------

export async function handleSetWorkspaceSecret(args: unknown) {
  const p = validate(args, SetWorkspaceSecretSchema);
  // POST /workspaces/:id/secrets upserts AES-256-GCM + auto-restarts the ws.
  return toMcpResult(
    await mgmtCall("POST", `/workspaces/${encodeURIComponent(p.workspace_id)}/secrets`, { key: p.key, value: p.value }),
  );
}

export async function handleListWorkspaceSecrets(args: unknown) {
  const p = validate(args, ListWorkspaceSecretsSchema);
  return toMcpResult(await mgmtGet(`/workspaces/${encodeURIComponent(p.workspace_id)}/secrets`));
}

export async function handleDeleteWorkspaceSecret(args: unknown) {
  const p = validate(args, DeleteWorkspaceSecretSchema);
  return toMcpResult(
    await mgmtCall("DELETE", `/workspaces/${encodeURIComponent(p.workspace_id)}/secrets/${encodeURIComponent(p.key)}`),
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
  return toMcpResult(await mgmtCall("PATCH", `/workspaces/${encodeURIComponent(p.workspace_id)}/budget`, body));
}

export async function handleSetLlmBillingMode(args: unknown) {
  const p = validate(args, SetLlmBillingModeSchema);
  // PUT /admin/workspaces/:id/llm-billing-mode. mode:null = clear override.
  return toMcpResult(
    await mgmtCall("PUT", `/admin/workspaces/${encodeURIComponent(p.workspace_id)}/llm-billing-mode`, { mode: p.mode }),
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
  return toMcpResult(await mgmtCall("POST", `/admin/workspaces/${encodeURIComponent(p.workspace_id)}/tokens`, {}));
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
  return toMcpResult(await mgmtGet(`/bundles/export/${encodeURIComponent(p.workspace_id)}`));
}

export async function handleImportBundle(args: unknown) {
  const p = validate(args, ImportBundleSchema);
  return toMcpResult(await mgmtCall("POST", "/bundles/import", p.bundle));
}

// Events / approvals -------------------------------------------------------

export async function handleListOrgEvents(args: unknown) {
  const p = validate(args, ListOrgEventsSchema);
  const path = p.workspace_id ? `/events/${encodeURIComponent(p.workspace_id)}` : "/events";
  return toMcpResult(await mgmtGet(path));
}

export async function handleListPendingApprovals() {
  return toMcpResult(await mgmtGet("/approvals/pending"));
}

// Conversation history -----------------------------------------------------

// get_conversation_history (RFC #2945 chat-history + the direct-inject-history
// removal, ws-runtime #222 / openclaw #139 / canvas #3416). The ONLY
// agent-facing path to older conversation context: instead of force-injecting
// history into the runtime prompt at ingest, the agent CHOOSES to pull a page
// on demand from the PERSISTED tenant store (activity_logs, where canvas chat
// lands via persistUserMessageAtIngest). Reads the tenant workspace-server
// endpoint `GET /workspaces/:id/chat-history?limit=&before_ts=` (server-side
// activity_logs → ChatMessage adapter; same wsAuth chain the Org API Key
// already satisfies). Org/workspace scoping is enforced by the tenant host
// (WorkspaceAuth + X-Molecule-Org-Id), so a caller can only read history for a
// workspace in its own org.
export async function handleGetConversationHistory(args: unknown) {
  const p = validate(args, GetConversationHistorySchema);

  // workspace_id defaults to the caller's own workspace. Fail closed (no
  // fetch) with a clean INVALID_ARGUMENTS when neither the param nor the
  // env is available, rather than firing a request that can't name a target.
  const workspaceId = p.workspace_id || selfWorkspaceId();
  if (!workspaceId) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail:
        "workspace_id is required — pass the workspace UUID whose conversation " +
        "history you want, or set MOLECULE_WORKSPACE_ID / WORKSPACE_ID so it " +
        "defaults to the caller's own workspace.",
    });
  }

  // Clamp to the agent-facing bounds (belt-and-suspenders with the zod max):
  // never let a single pull exceed HISTORY_MAX_LIMIT rows.
  let limit = p.limit ?? HISTORY_DEFAULT_LIMIT;
  if (limit > HISTORY_MAX_LIMIT) limit = HISTORY_MAX_LIMIT;
  if (limit < 1) limit = 1;

  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (p.before_cursor) qs.set("before_ts", p.before_cursor);

  const data = await mgmtGet(
    `/workspaces/${encodeURIComponent(workspaceId)}/chat-history?${qs.toString()}`,
  );
  if (isApiError(data)) {
    // Auth/HTTP/unreachable — surface the structured error unchanged.
    return toMcpResult(data);
  }

  // The store returns messages OLDEST-first within a page and
  // reached_end=true once it has hit the start of history. To walk further
  // back the next `before_ts` is the OLDEST message's timestamp in this page;
  // expose it as next_before_cursor so the agent paginates without having to
  // reason about the store's ordering. Omitted at end-of-history.
  const body = data as {
    messages?: Array<{ timestamp?: string }>;
    reached_end?: boolean;
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const reachedEnd = body.reached_end === true;
  const nextBeforeCursor =
    !reachedEnd && messages.length > 0 ? messages[0]?.timestamp : undefined;

  return toMcpResult({
    workspace_id: workspaceId,
    messages,
    count: messages.length,
    reached_end: reachedEnd,
    next_before_cursor: nextBeforeCursor,
  });
}

// create_approval (mcp-server#61) — raise an approval-kind request addressed
// to the USER via the unified requests system (same shape the workspace-mode
// tool uses; see ../approvals.ts handleCreateApproval). The GENERAL form is
// create_request from ../requests.ts, registered in BOTH modes by
// createServer — do NOT add a management duplicate of it: the MCP SDK throws
// on duplicate tool names and the whole management server dies at startup
// (caught by the platform-agent image smoke gate, 2026-06-11). Without this
// org concierge IMPROVISED approval demos by running gated/destructive ops
// (set_workspace_secret on itself → secret-change auto-restart → its own box
// terminated mid-turn, twice on 2026-06-11 — core#2573). Deliberately NO
// decide_approval here: deciding is the HUMAN side of the gate and an agent
// must never hold it.
const CreateApprovalMgmtSchema = z.object({
  workspace_id: z.string().describe("Workspace the approval is raised for/anchored to"),
  action: z.string().describe("What needs approval (becomes the request title)"),
  reason: z.string().optional().describe("Why it's needed (becomes the detail)"),
});

export async function handleCreateApproval(args: unknown) {
  const p = validate(args, CreateApprovalMgmtSchema);
  return toMcpResult(
    await mgmtCall("POST", `/workspaces/${encodeURIComponent(p.workspace_id)}/requests`, {
      kind: "approval",
      recipient_type: "user",
      recipient_id: "",
      title: p.action,
      detail: p.reason,
    }),
  );
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
      model: z.string().optional().describe("LLM model id. Omit unless the user named a model; omitted values use the platform default."),
    },
    handleProvisionWorkspace,
  );
  srv.tool(
    "deprovision_workspace",
    "Management: delete/deprovision a workspace (cascades to children).",
    {
      workspace_id: z.string().describe("Workspace UUID"),
      confirm_name: z.string().optional().describe("Echo the workspace's exact name to confirm destructive action"),
    },
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

  // --- Plugin install (self-reprovision §5.2) ---
  srv.tool(
    "install_plugin",
    "Management: install a plugin into a workspace — defaults to YOUR OWN workspace when " +
      "workspace_id is omitted (self-install). The tenant validates the source resolves " +
      "(fails loud on a bad repo/name/ref), records it in the workspace's durable plugin set " +
      "(it survives every future reprovision), and by default RESTARTS the workspace so " +
      "boot-install activates it. SELF-INSTALL WARNING: with restart on, YOUR OWN workspace " +
      "reprovisions moments after this returns — your current session ends; on wake you " +
      "receive a self-reprovision note listing the new plugin(s): proactively tell the user " +
      "what you can now do, then resume prior work.",
    {
      workspace_id: z
        .string()
        .optional()
        .describe("Target workspace UUID (defaults to the caller's own MOLECULE_WORKSPACE_ID)"),
      source: z
        .string()
        .describe(
          "Plugin source: 'gitea://owner/repo[/subpath][#ref]', 'local://<name>', 'github://owner/repo[#ref]', or any registered scheme",
        ),
      restart: z
        .boolean()
        .optional()
        .describe("Restart the workspace to activate the plugin (default true); false = record + deliver only"),
    },
    handleInstallPlugin,
  );

  // --- Plugin discovery (self-reprovision §5.2 companion) ---
  srv.tool(
    "list_available_plugins",
    "Management: list installable plugins from the marketplace catalog (name, description, " +
      "kind, source, supported runtimes). Defaults to YOUR OWN workspace's runtime filter " +
      "when workspace_id is omitted. Pass an entry's `source` to install_plugin to install " +
      "it. Channel plugins (kind=channel — e.g. the Lark/Feishu channel bridge) connect " +
      "external chat channels to a workspace; consult this catalog FIRST when a user asks " +
      "to connect a channel or add a capability, instead of asking them for setup details.",
    {
      workspace_id: z
        .string()
        .optional()
        .describe(
          "Workspace UUID whose runtime the catalog is filtered for (defaults to the caller's own MOLECULE_WORKSPACE_ID)",
        ),
    },
    handleListAvailablePlugins,
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

  // --- Conversation history (on-demand, paginated) ---
  srv.tool(
    "get_conversation_history",
    "Management: read a page of a workspace's PERSISTED conversation history " +
      "(activity_logs chat) on demand. This is the pull-based alternative to " +
      "force-injecting history into the prompt: call it when you need older " +
      "context. Returns messages oldest-first plus next_before_cursor for " +
      "paging further back. Scoped to the caller's org (tenant host authorizes).",
    {
      workspace_id: z
        .string()
        .optional()
        .describe("Workspace UUID (defaults to the caller's own MOLECULE_WORKSPACE_ID)"),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`Page size (default ${HISTORY_DEFAULT_LIMIT}, clamped to ${HISTORY_MAX_LIMIT} max)`),
      before_cursor: z
        .string()
        .optional()
        .describe("RFC3339 cursor (next_before_cursor from the prior page) to page backward"),
    },
    handleGetConversationHistory,
  );
  srv.tool(
    "create_approval",
    "Management: raise an approval request to the user for a workspace action. Use this (NEVER a destructive/gated operation) when you need a human decision or want to demonstrate the approval flow.",
    {
      workspace_id: z.string().describe("Workspace the approval is raised for/anchored to"),
      action: z.string().describe("What needs approval (becomes the request title)"),
      reason: z.string().optional().describe("Why it's needed (becomes the detail)"),
    },
    handleCreateApproval,
  );

  // --- CP-tier tools (separate module — Org API Key cannot reach CP) ---
  registerCpAdminTools(srv);
}
