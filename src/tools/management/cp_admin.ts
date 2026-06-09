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
}
