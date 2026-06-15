/**
 * CP-admin tools — the control-plane tier of the management surface.
 *
 * WHY THIS IS A SEPARATE MODULE (PLATFORM-MANAGEMENT-API.md §1 / §5):
 * The Org API Key is a TENANT credential. It authorizes the entire
 * tenant-admin surface of its own org but reaches NOTHING on the control
 * plane — CP `/api/v1/orgs/*` (org create/delete/export/members/billing)
 * 401/403 the org key. `list_orgs` / `get_org` are CP-tier reads that need
 * a WorkOS session cookie OR the CP admin bearer (`CP_ADMIN_API_TOKEN`).
 *
 * Rather than register these against the tenant host (where they would
 * silently 404/401 with the org key), they live here and:
 *   - point at the control plane (`MOLECULE_CP_URL` / `api.moleculesai.app`),
 *   - authenticate with `CP_ADMIN_API_TOKEN` (admin bearer),
 *   - are GATED on that token being present: when it's absent the tool
 *     returns a clear, structured "not configured / CP-tier" message
 *     instead of a confusing upstream auth error.
 *
 * This keeps the CP-admin surface clearly separated and never silently
 * broken — per §5's instruction.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpResult, isApiError } from "../../api.js";
import { validate } from "../../utils/validation.js";
import { error as logError, warn as logWarn } from "../../utils/logger.js";
import { mgmtGet } from "./client.js";
import type { ApiError } from "../../api.js";

/**
 * Control-plane base URL. Distinct from the per-org tenant host. Resolved at
 * call time so it can be configured after import (and is order-independent).
 */
export function cpUrl(): string {
  return (
    process.env.MOLECULE_CP_URL ||
    process.env.CP_API_URL ||
    "https://api.moleculesai.app"
  );
}

/** True when a CP admin bearer is configured. */
export function cpConfigured(): boolean {
  return !!process.env.CP_ADMIN_API_TOKEN;
}

function cpNotConfigured(tool: string): ApiError {
  return {
    error: "CP_TIER_NOT_CONFIGURED",
    detail:
      `'${tool}' is a control-plane tier tool. The Org API Key cannot reach the CP. ` +
      "Set CP_ADMIN_API_TOKEN (CP admin bearer) to enable it. This is gated, not broken.",
  };
}

/** Authenticated CP request. Never throws. */
async function cpCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | ApiError> {
  const tok = process.env.CP_ADMIN_API_TOKEN;
  if (!tok) return cpNotConfigured(path) as ApiError;
  try {
    const base = cpUrl();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { error: "AUTH_ERROR", detail: text, status: res.status };
      }
      return { error: `HTTP ${res.status}`, detail: text, status: res.status };
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return { raw: text, status: res.status } as ApiError;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(err, `CP admin API error (${method} ${path})`, { url: cpUrl() });
    return { error: `Control plane unreachable at ${cpUrl()}`, detail: msg };
  }
}

const GetOrgSchema = z.object({
  slug: z.string().describe("Org slug (e.g. 'agents-team')"),
});

/**
 * recreate_workspace — the HARD redeploy that restart_workspace cannot do.
 *
 * WHY THIS EXISTS (controlplane#579): the soft `restart_workspace` lever
 * (tenant POST /workspaces/:id/restart) bounces the container but REUSES
 * the workspace's already-pulled template image. When the runtime-image
 * pin has been promoted to a newer digest (the #cp245 "stale digest"
 * class of incident), a soft restart keeps running the OLD image — there
 * is no org-key-reachable lever to force the container onto the
 * currently-promoted pin. The CP-admin endpoint
 *   POST /cp/admin/tenants/:slug/workspaces/redeploy
 *   {"runtime": <runtime|"">, "recreate": true}
 * (controlplane router.go:527 → AdminHandler.RedeployTenantWorkspaces →
 * provisioner.WorkspaceRedeployer) re-pulls the pinned digest from ECR
 * and FORCE-REMOVES + recreates the running ws-* container(s) so they
 * come up on the new image — preserving the /workspace + /configs binds
 * (only the container is swapped, not the data volumes).
 *
 * SCOPE NOTE: the CP endpoint is TENANT+RUNTIME scoped, not single-
 * container. It refreshes the workspace template image for `runtime`
 * (or ALL runtimes when omitted) on the tenant and recreates every
 * running ws-* container of that runtime. `workspace_id` here is the
 * caller's reference for "the workspace I want onto the new pin"; we use
 * its `runtime` (looked up via the tenant API when not supplied) to scope
 * the redeploy as narrowly as the endpoint allows. To target a single
 * runtime, pass `runtime` explicitly.
 *
 * FAIL-CLOSED SCOPE GUARD: a tenant-wide ALL-runtimes recreate is a large
 * destructive blast radius, so we never DEFAULT into it on a failure. It
 * is only entered when the caller asks for it *explicitly* — by passing
 * `all_runtimes: true` (with no `runtime` and no `workspace_id`). If a
 * `workspace_id` is supplied but its runtime cannot be resolved, and no
 * explicit `runtime` was given, the tool ABORTS (recreates nothing)
 * rather than silently widening to every runtime on the tenant.
 *
 * AUDIT: this is a destructive CP-admin op, so it must be attributable.
 * The caller passes `actor` (who) and `reason` (why); these are forwarded
 * in the redeploy request body (so the CP endpoint can record them if it
 * supports an audit field) AND emitted as a structured audit log line
 * before the recreate is issued. `actor` falls back to MOLECULE_AUDIT_ACTOR
 * / the configured tenant identity so the op is never anonymous.
 *
 * AUTH: this is a CP-tier tool (CP_ADMIN_API_TOKEN) — the Org API Key
 * cannot reach the control plane. The tenant `slug` is resolved from the
 * `slug` arg, falling back to MOLECULE_ORG_SLUG (the tenant identity the
 * management surface is already configured with).
 */
const RecreateWorkspaceSchema = z.object({
  workspace_id: z
    .string()
    .optional()
    .describe(
      "Workspace UUID to bring onto the current pin. Used to resolve the runtime to scope the redeploy (the CP endpoint is tenant+runtime scoped, not single-container). Optional when `runtime` is given.",
    ),
  runtime: z
    .string()
    .optional()
    .describe(
      "Restrict the redeploy to ONE template image (e.g. 'claude-code', 'codex'). Omit to refresh ALL runtimes on the tenant. If omitted and workspace_id is given, the workspace's runtime is looked up and used.",
    ),
  slug: z
    .string()
    .optional()
    .describe("Tenant org slug (e.g. 'agents-team'). Defaults to MOLECULE_ORG_SLUG."),
  all_runtimes: z
    .boolean()
    .optional()
    .describe(
      "Opt INTO a tenant-wide recreate of EVERY runtime's containers (large blast radius). Only honored when neither `runtime` nor `workspace_id` is given. Must be set explicitly — the tool never defaults into a tenant-wide recreate, including on a workspace-runtime lookup failure.",
    ),
  actor: z
    .string()
    .optional()
    .describe(
      "AUDIT (who): identity of the operator/agent invoking this destructive redeploy. Forwarded to the CP audit field and logged. Falls back to MOLECULE_AUDIT_ACTOR / the configured tenant identity if omitted.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "AUDIT (why): justification for the destructive recreate (e.g. 'onto promoted pin sha256:… per cp#245'). Forwarded to the CP audit field and logged.",
    ),
  recreate: z
    .boolean()
    .optional()
    .describe(
      "Force-remove + recreate the running container(s) onto the freshly-pulled image. Default true (the whole point). Set false to pre-pull the new image WITHOUT disrupting in-flight sessions.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe("Resolve the tenant URL + the request that WOULD be sent, without calling the tenant."),
});

export async function handleListOrgs() {
  if (!cpConfigured()) return toMcpResult(cpNotConfigured("list_orgs"));
  // GET /api/v1/admin/orgs — admin-tier list of all orgs.
  return toMcpResult(await cpCall("GET", "/api/v1/admin/orgs"));
}

export async function handleGetOrg(args: unknown) {
  const p = validate(args, GetOrgSchema);
  if (!cpConfigured()) return toMcpResult(cpNotConfigured("get_org"));
  // GET /api/v1/orgs/:slug — org detail (session+ownership or admin bearer).
  return toMcpResult(await cpCall("GET", `/api/v1/orgs/${encodeURIComponent(p.slug)}`));
}

export async function handleRecreateWorkspace(args: unknown) {
  const p = validate(args, RecreateWorkspaceSchema);

  if (!cpConfigured()) return toMcpResult(cpNotConfigured("recreate_workspace"));

  // Resolve the tenant slug: explicit arg wins, else the configured
  // tenant identity (MOLECULE_ORG_SLUG — same env the management surface
  // routes with). The CP redeploy endpoint is slug-keyed.
  const slug = p.slug ?? process.env.MOLECULE_ORG_SLUG;
  if (!slug) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail:
        "tenant slug is required: pass `slug`, or set MOLECULE_ORG_SLUG. " +
        "The CP redeploy endpoint (/cp/admin/tenants/:slug/workspaces/redeploy) is slug-keyed.",
    });
  }

  // Scope the redeploy to one runtime when we can, and FAIL CLOSED when we
  // cannot. Explicit `runtime` wins. Otherwise, if a workspace_id is given,
  // look its runtime up via the tenant management API so we recreate only
  // that runtime's containers. A tenant-wide ALL-runtimes recreate is a
  // large destructive blast radius, so it is NEVER a fallback — it is only
  // entered when the caller asks for it explicitly via `all_runtimes:true`
  // (with no runtime/workspace_id to scope).
  let runtime = p.runtime;
  let runtimeSource: "explicit" | "workspace_lookup" | "all_runtimes" =
    runtime ? "explicit" : "all_runtimes";

  if (!runtime && p.workspace_id) {
    const ws = await mgmtGet(`/workspaces/${encodeURIComponent(p.workspace_id)}`);
    if (!isApiError(ws) && ws && typeof ws === "object") {
      const r = (ws as Record<string, unknown>).runtime;
      if (typeof r === "string" && r.length > 0) {
        runtime = r;
        runtimeSource = "workspace_lookup";
      }
    }
    if (!runtime) {
      // FAIL CLOSED: workspace_id was given but its runtime is unresolvable
      // (org-key tenant lookup unavailable or workspace not found) and no
      // explicit runtime was supplied. Defaulting to a tenant-wide recreate
      // here would destructively recreate EVERY runtime's containers on a
      // mere lookup miss. Abort and recreate nothing.
      return toMcpResult({
        error: "RUNTIME_UNRESOLVED",
        detail:
          `could not resolve the runtime for workspace '${p.workspace_id}' ` +
          "(tenant lookup unavailable or workspace not found), and no explicit " +
          "`runtime` was provided. Refusing to fall back to a tenant-wide " +
          "all-runtimes recreate (too broad / not fail-closed). Pass `runtime` " +
          "explicitly to scope the redeploy, or `all_runtimes:true` to opt into " +
          "a tenant-wide recreate deliberately.",
        slug,
        workspace_id: p.workspace_id,
      });
    }
  }

  // A tenant-wide ALL-runtimes recreate (no runtime, no workspace_id) must be
  // an explicit opt-in, never an implicit default.
  if (!runtime && !p.workspace_id && !p.all_runtimes) {
    return toMcpResult({
      error: "SCOPE_REQUIRED",
      detail:
        "recreate_workspace needs an explicit scope: pass `runtime`, or " +
        "`workspace_id` (its runtime is resolved), or — to deliberately " +
        "recreate EVERY runtime's containers tenant-wide — `all_runtimes:true`. " +
        "Refusing an unscoped tenant-wide recreate (fail-closed).",
      slug,
    });
  }

  const recreate = p.recreate ?? true;

  // AUDIT (defect 2): this is a destructive CP-admin op — record who/why.
  // `actor` is never anonymous: explicit arg → MOLECULE_AUDIT_ACTOR → the
  // configured tenant identity. `reason` is forwarded verbatim (may be
  // undefined). Both go in the request body (so the CP redeploy endpoint can
  // persist them if it supports an audit field) AND a structured audit log
  // line is emitted BEFORE the recreate is issued, so the op is attributable
  // even if the endpoint ignores the fields.
  //
  // FAIL-CLOSED: if no actor can be resolved, abort rather than emit an
  // anonymous/"unknown" audit trail for a destructive admin operation.
  // Also rejects the literal string "unknown" — the caller must provide
  // an attributable identity (mcp-server#48).
  const actor =
    p.actor ??
    process.env.MOLECULE_AUDIT_ACTOR ??
    process.env.MOLECULE_ORG_SLUG ??
    "";
  if (!actor || actor === "unknown") {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail:
        "audit actor is required for this destructive CP-admin operation. " +
        "Pass `actor`, or set MOLECULE_AUDIT_ACTOR / MOLECULE_ORG_SLUG.",
      slug,
    });
  }
  const reason = p.reason;
  const dryRun = p.dry_run ?? false;

  logWarn("recreate_workspace: CP-admin hard redeploy (destructive)", {
    audit: true,
    operation: "recreate_workspace",
    actor,
    reason: reason ?? null,
    slug,
    workspace_id: p.workspace_id ?? null,
    runtime: runtime ?? null,
    runtime_source: runtimeSource,
    recreate,
    dry_run: dryRun,
    timestamp: new Date().toISOString(),
  });

  const body: Record<string, unknown> = {
    runtime: runtime ?? "",
    recreate,
    dry_run: dryRun,
    actor,
    ...(reason !== undefined ? { reason } : {}),
  };

  // POST /cp/admin/tenants/:slug/workspaces/redeploy — re-pulls the
  // currently-promoted runtime-image pin from ECR and (recreate=true)
  // force-removes + recreates the running ws-* container(s) onto it.
  const res = await cpCall(
    "POST",
    `/api/v1/admin/tenants/${encodeURIComponent(slug)}/workspaces/redeploy`,
    body,
  );

  if (isApiError(res)) {
    return toMcpResult({
      error: "REDEPLOY_FAILED",
      detail: res,
      slug,
      requested_runtime: runtime ?? null,
      recreate,
      runtime_source: runtimeSource,
      actor,
      reason: reason ?? null,
    });
  }

  return toMcpResult({
    ok: true,
    slug,
    workspace_id: p.workspace_id ?? null,
    requested_runtime: runtime ?? null,
    runtime_source: runtimeSource,
    recreate,
    dry_run: dryRun,
    actor,
    reason: reason ?? null,
    result: res,
  });
}

// ---------------------------------------------------------------------------
// Cross-cloud compute-provider migration (mcp-server#64)
//
// The canvas can move a workspace's compute box across clouds (AWS ↔ Hetzner ↔
// GCP) but the management MCP/CLI could not — a real capability gap. These two
// tools wrap the CP-admin endpoint:
//
//   POST /api/v1/admin/workspaces/:id/migrate-provider
//        {from, to, confirm:true, [from_instance_id], [org_id], [runtime], …}
//     → 202 {status:"migration_started", workspace_id, from, to}
//   GET  /api/v1/admin/workspaces/:id/migrate-provider (alias …/migration-status)
//     → 200 {migration:{state, from_provider, to_provider, detail, …}, terminal}
//
// (controlplane internal/handlers/admin_workspace_migrate_provider.go). The
// migration is DATA-SAFE + ASYNC (~15-20 min): CP snapshots the source's
// /workspace to R2, provisions the target which restores on boot, verifies it's
// healthy, then retires the source. Verify-before-destroy + rollback live in CP.
//
// This is a CP-tier op (CP_ADMIN_API_TOKEN) — the Org API Key cannot reach the
// control plane, so it lives here alongside the other cp_admin tools.
//
// Client-side guards mirror the CP handler so a bad call fails fast with a clear
// message instead of round-tripping a 400/503:
//   - `to` is required and must be aws|hetzner|gcp.
//   - `from` is required by CP and must differ from `to`.
//   - `confirm:true` is mandatory (a real migration mutates two clouds). We
//     DEFAULT confirm to false and refuse without it — never auto-confirm a
//     destructive cross-cloud op.
//   - `from_instance_id` is required by CP for NON-AWS sources (Hetzner/GCP have
//     no workspace→instance resolver). For AWS it's optional (CP resolves the
//     real instance from EC2 tags, cp#711). We enforce the same so a non-AWS
//     migration doesn't fail downstream with a confusing CP 400.
// ---------------------------------------------------------------------------

const PROVIDERS = ["aws", "hetzner", "gcp"] as const;

const MigrateWorkspaceProviderSchema = z
  .object({
    workspace_id: z.string().describe("Workspace UUID whose compute box to migrate across clouds."),
    to: z.enum(PROVIDERS).describe("Target compute provider (aws|hetzner|gcp). REQUIRED."),
    from: z
      .enum(PROVIDERS)
      .optional()
      .describe(
        "Current compute provider (aws|hetzner|gcp). Required by the control plane; must differ from `to`. If omitted, the tool resolves it from the workspace's current provider via the tenant API.",
      ),
    from_instance_id: z
      .string()
      .optional()
      .describe(
        "Current box id to snapshot + retire. REQUIRED for non-AWS (Hetzner/GCP) sources — they have no workspace→instance resolver. Optional for AWS (CP resolves the real instance from EC2 tags).",
      ),
    org_id: z
      .string()
      .optional()
      .describe("Hint for non-AWS sources; CP resolves org from EC2 tags for AWS. Usually unnecessary — CP fills it from tenant_resources."),
    runtime: z
      .string()
      .optional()
      .describe("Runtime hint for non-AWS sources (e.g. 'claude-code'). Usually unnecessary — CP fills it from tenant_resources."),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "MUST be true to actually migrate — a real migration mutates two clouds. Defaults to false; the tool refuses without explicit confirmation.",
      ),
  })
  .refine((v) => v.from === undefined || v.from !== v.to, {
    message: "`from` and `to` are the same provider — nothing to migrate",
  });

const GetWorkspaceMigrationStatusSchema = z.object({
  workspace_id: z.string().describe("Workspace UUID to read the latest provider-migration status for."),
});

/**
 * migrate_workspace_provider — start a data-safe cross-cloud provider switch.
 *
 * Resolves `from` (when omitted) from the workspace's current provider via the
 * tenant API, enforces the CP contract's guards client-side, then POSTs to the
 * CP-admin endpoint. Returns the 202 {status:"migration_started", …} body. The
 * migration runs asynchronously (~15-20 min) — poll get_workspace_migration_status.
 */
export async function handleMigrateWorkspaceProvider(args: unknown) {
  const p = validate(args, MigrateWorkspaceProviderSchema);

  if (!cpConfigured()) return toMcpResult(cpNotConfigured("migrate_workspace_provider"));

  // Resolve `from` when omitted — the CP handler REQUIRES it. The workspace's
  // current provider is on its tenant row (org-key host); fall back to a clear
  // error rather than letting CP 400 with "from and to must each be one of …".
  let from = p.from as string | undefined;
  let fromSource: "explicit" | "workspace_lookup" = from ? "explicit" : "workspace_lookup";
  if (!from) {
    const ws = await mgmtGet(`/workspaces/${encodeURIComponent(p.workspace_id)}`);
    if (!isApiError(ws) && ws && typeof ws === "object") {
      const rec = ws as Record<string, unknown>;
      const prov = rec.provider ?? rec.compute_provider;
      if (typeof prov === "string" && PROVIDERS.includes(prov as (typeof PROVIDERS)[number])) {
        from = prov;
        fromSource = "workspace_lookup";
      }
    }
    if (!from) {
      return toMcpResult({
        error: "FROM_UNRESOLVED",
        detail:
          `could not resolve the current provider for workspace '${p.workspace_id}' ` +
          "(tenant lookup unavailable, workspace not found, or it reports no provider). " +
          "Pass `from` explicitly (one of aws|hetzner|gcp).",
        workspace_id: p.workspace_id,
        to: p.to,
      });
    }
  }

  if (from === p.to) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail: `from and to are the same provider (${from}) — nothing to migrate`,
      workspace_id: p.workspace_id,
    });
  }

  // from_instance_id is REQUIRED for non-AWS sources (no workspace→instance
  // resolver). Enforce it here so the call fails fast with a clear message
  // instead of a confusing CP 400.
  if (from !== "aws" && !p.from_instance_id) {
    return toMcpResult({
      error: "INVALID_ARGUMENTS",
      detail:
        `from_instance_id is required for a non-AWS (${from}) source — it has no ` +
        "workspace→instance resolver, so the current box id is needed to snapshot + retire it.",
      workspace_id: p.workspace_id,
      from,
      to: p.to,
    });
  }

  // confirm defaults to FALSE — never auto-confirm a destructive two-cloud op.
  const confirm = p.confirm ?? false;
  if (!confirm) {
    return toMcpResult({
      error: "CONFIRMATION_REQUIRED",
      detail:
        "refusing to migrate without confirmation — a real migration mutates two clouds " +
        "(snapshot source → provision target → retire source). Pass confirm:true to proceed.",
      workspace_id: p.workspace_id,
      from,
      to: p.to,
    });
  }

  logWarn("migrate_workspace_provider: CP-admin cross-cloud provider switch", {
    audit: true,
    operation: "migrate_workspace_provider",
    workspace_id: p.workspace_id,
    from,
    to: p.to,
    from_source: fromSource,
    from_instance_id: p.from_instance_id ?? null,
    timestamp: new Date().toISOString(),
  });

  const body: Record<string, unknown> = { from, to: p.to, confirm: true };
  if (p.from_instance_id !== undefined) body.from_instance_id = p.from_instance_id;
  if (p.org_id !== undefined) body.org_id = p.org_id;
  if (p.runtime !== undefined) body.runtime = p.runtime;

  const res = await cpCall(
    "POST",
    `/api/v1/admin/workspaces/${encodeURIComponent(p.workspace_id)}/migrate-provider`,
    body,
  );

  if (isApiError(res)) {
    return toMcpResult({
      error: "MIGRATION_START_FAILED",
      detail: res,
      workspace_id: p.workspace_id,
      from,
      to: p.to,
      from_source: fromSource,
    });
  }

  return toMcpResult({
    ok: true,
    workspace_id: p.workspace_id,
    from,
    to: p.to,
    from_source: fromSource,
    result: res,
  });
}

/**
 * get_workspace_migration_status — read the latest provider-migration record.
 *
 * Read-only. Returns {migration:{state, from_provider, to_provider, detail, …},
 * terminal}. 404 (surfaced as a structured NOT_FOUND) when the workspace has
 * never been migrated.
 */
export async function handleGetWorkspaceMigrationStatus(args: unknown) {
  const p = validate(args, GetWorkspaceMigrationStatusSchema);

  if (!cpConfigured()) return toMcpResult(cpNotConfigured("get_workspace_migration_status"));

  const res = await cpCall(
    "GET",
    `/api/v1/admin/workspaces/${encodeURIComponent(p.workspace_id)}/migrate-provider`,
  );

  if (isApiError(res)) {
    // A 404 here is the meaningful "never migrated" signal — surface it cleanly.
    if (typeof res === "object" && res !== null && (res as ApiError).status === 404) {
      return toMcpResult({
        error: "NOT_FOUND",
        detail: "no provider-migration record for this workspace (it has never been migrated)",
        workspace_id: p.workspace_id,
      });
    }
    return toMcpResult({
      error: "MIGRATION_STATUS_FAILED",
      detail: res,
      workspace_id: p.workspace_id,
    });
  }

  return toMcpResult({ ok: true, workspace_id: p.workspace_id, ...(res as Record<string, unknown>) });
}

export function registerCpAdminTools(srv: McpServer) {
  srv.tool(
    "list_orgs",
    "Management (CP-TIER): list all orgs. Requires CP_ADMIN_API_TOKEN — the Org API Key CANNOT reach the control plane.",
    {},
    handleListOrgs,
  );
  srv.tool(
    "get_org",
    "Management (CP-TIER): get an org by slug. Requires CP session/admin — the Org API Key CANNOT reach the control plane.",
    { slug: z.string().describe("Org slug") },
    handleGetOrg,
  );
  srv.tool(
    "recreate_workspace",
    "Management (CP-TIER): recreate/redeploy a workspace onto the currently-promoted runtime-image pin — unlike restart_workspace, which reuses the old (possibly stale) image. Re-pulls the pinned digest from ECR and force-removes + recreates the running container so it comes up on the new image, preserving /workspace + /configs. Scoped to one runtime (resolved from workspace_id, or pass `runtime`). DESTRUCTIVE + fail-closed: never defaults to a tenant-wide recreate — a workspace-runtime lookup miss aborts, and a tenant-wide all-runtimes recreate requires explicit `all_runtimes:true`. Pass `actor`+`reason` for the audit trail. Requires CP_ADMIN_API_TOKEN — the Org API Key CANNOT reach the control plane.",
    {
      workspace_id: z
        .string()
        .optional()
        .describe("Workspace UUID to bring onto the current pin (used to resolve the runtime). Optional when `runtime` is given. If its runtime cannot be resolved and no `runtime` is given, the op ABORTS (does not widen to tenant-wide)."),
      runtime: z
        .string()
        .optional()
        .describe("Restrict to one template image (e.g. 'claude-code'). Auto-derived from workspace_id when omitted. To refresh ALL runtimes, use all_runtimes:true."),
      slug: z.string().optional().describe("Tenant org slug. Defaults to MOLECULE_ORG_SLUG."),
      all_runtimes: z
        .boolean()
        .optional()
        .describe("Opt into a tenant-wide recreate of EVERY runtime (large blast radius). Required to run unscoped; never a default/fallback."),
      actor: z
        .string()
        .optional()
        .describe("AUDIT (who) for this destructive op. Falls back to MOLECULE_AUDIT_ACTOR / tenant identity."),
      reason: z
        .string()
        .optional()
        .describe("AUDIT (why) for this destructive op (e.g. 'onto promoted pin per cp#245')."),
      recreate: z
        .boolean()
        .optional()
        .describe("Force-recreate the container onto the new image. Default true. false = pre-pull only, no disruption."),
      dry_run: z.boolean().optional().describe("Resolve routing + the request that WOULD be sent, without calling the tenant."),
    },
    handleRecreateWorkspace,
  );
  srv.tool(
    "migrate_workspace_provider",
    "Management (CP-TIER): migrate a workspace's compute box across clouds (AWS ↔ Hetzner ↔ GCP). Data-safe + ASYNC (~15-20 min): CP snapshots the source's /workspace to R2, provisions the target (which restores on boot), verifies it's healthy, then retires the source (verify-before-destroy + rollback live in CP). `to` is required; `from` is auto-resolved from the workspace when omitted. confirm:true is REQUIRED — a real migration mutates two clouds; the tool refuses without it. `from_instance_id` is required for non-AWS sources. Poll get_workspace_migration_status for progress. Requires CP_ADMIN_API_TOKEN — the Org API Key CANNOT reach the control plane.",
    {
      workspace_id: z.string().describe("Workspace UUID to migrate."),
      to: z.enum(PROVIDERS).describe("Target provider (aws|hetzner|gcp). REQUIRED."),
      from: z
        .enum(PROVIDERS)
        .optional()
        .describe("Current provider (aws|hetzner|gcp); must differ from `to`. Auto-resolved from the workspace when omitted."),
      from_instance_id: z
        .string()
        .optional()
        .describe("Current box id to snapshot + retire. REQUIRED for non-AWS (Hetzner/GCP) sources; optional for AWS (resolved from EC2 tags)."),
      org_id: z.string().optional().describe("Org hint for non-AWS sources (usually unnecessary — CP fills it from tenant_resources)."),
      runtime: z.string().optional().describe("Runtime hint for non-AWS sources (usually unnecessary — CP fills it from tenant_resources)."),
      confirm: z
        .boolean()
        .optional()
        .describe("MUST be true to actually migrate (mutates two clouds). Defaults to false; the tool refuses without it."),
    },
    handleMigrateWorkspaceProvider,
  );
  srv.tool(
    "get_workspace_migration_status",
    "Management (CP-TIER): read the latest cross-cloud provider-migration status for a workspace. Read-only. Returns {migration:{state, from_provider, to_provider, detail, …}, terminal}. States: snapshotting → provisioning_target → target_healthy → retiring_source → completed (terminal also: failed, rolled_back). NOT_FOUND when the workspace has never been migrated. Requires CP_ADMIN_API_TOKEN — the Org API Key CANNOT reach the control plane.",
    { workspace_id: z.string().describe("Workspace UUID to read provider-migration status for.") },
    handleGetWorkspaceMigrationStatus,
  );
}
