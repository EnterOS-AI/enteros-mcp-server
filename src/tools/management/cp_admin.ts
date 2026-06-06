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
import { error as logError } from "../../utils/logger.js";
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

  // Scope the redeploy to one runtime when we can. Explicit `runtime`
  // wins; otherwise, if a workspace_id is given, look its runtime up via
  // the tenant management API so we recreate only that runtime's
  // containers instead of the whole tenant's image set. Best-effort: if
  // the lookup can't resolve a runtime we fall back to a tenant-wide
  // refresh (runtime:"") and say so in the response, rather than failing.
  let runtime = p.runtime;
  let runtimeSource: "explicit" | "workspace_lookup" | "all_runtimes" =
    runtime ? "explicit" : "all_runtimes";
  let runtimeLookupNote: string | undefined;

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
      runtimeLookupNote =
        "could not resolve the workspace's runtime (org-key tenant lookup " +
        "unavailable or workspace not found); proceeding with a tenant-wide " +
        "all-runtimes refresh. Pass `runtime` to scope it.";
    }
  }

  const recreate = p.recreate ?? true;
  const body: Record<string, unknown> = {
    runtime: runtime ?? "",
    recreate,
    dry_run: p.dry_run ?? false,
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
      ...(runtimeLookupNote ? { note: runtimeLookupNote } : {}),
    });
  }

  return toMcpResult({
    ok: true,
    slug,
    workspace_id: p.workspace_id ?? null,
    requested_runtime: runtime ?? null,
    runtime_source: runtimeSource,
    recreate,
    dry_run: p.dry_run ?? false,
    result: res,
    ...(runtimeLookupNote ? { note: runtimeLookupNote } : {}),
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
    "Management (CP-TIER): recreate/redeploy a workspace onto the currently-promoted runtime-image pin — unlike restart_workspace, which reuses the old (possibly stale) image. Re-pulls the pinned digest from ECR and force-removes + recreates the running container so it comes up on the new image, preserving /workspace + /configs. Scoped to one runtime (resolved from workspace_id, or pass `runtime`) on the tenant. Requires CP_ADMIN_API_TOKEN — the Org API Key CANNOT reach the control plane.",
    {
      workspace_id: z
        .string()
        .optional()
        .describe("Workspace UUID to bring onto the current pin (used to resolve the runtime). Optional when `runtime` is given."),
      runtime: z
        .string()
        .optional()
        .describe("Restrict to one template image (e.g. 'claude-code'). Omit to refresh ALL runtimes; auto-derived from workspace_id when omitted."),
      slug: z.string().optional().describe("Tenant org slug. Defaults to MOLECULE_ORG_SLUG."),
      recreate: z
        .boolean()
        .optional()
        .describe("Force-recreate the container onto the new image. Default true. false = pre-pull only, no disruption."),
      dry_run: z.boolean().optional().describe("Resolve routing + the request that WOULD be sent, without calling the tenant."),
    },
    handleRecreateWorkspace,
  );
}
