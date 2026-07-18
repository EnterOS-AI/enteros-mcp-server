/**
 * CP-admin tools — the control-plane tier of the management surface.
 *
 * WHY THIS IS A SEPARATE MODULE (PLATFORM-MANAGEMENT-API.md §1 / §5):
 * The Org API Key is a TENANT credential. It authorizes the entire
 * tenant-admin surface of its own org but reaches NOTHING on the control
 * plane — CP `/api/v1/orgs/*` (org create/delete/export/members/billing)
 * 401/403 the org key. `list_orgs` / `get_org` are CP-tier reads that need
 * a WorkOS session cookie OR the CP admin bearer (`CP_ADMIN_API_TOKEN`). The
 * production promote tool is narrower still: it uses only the dedicated
 * `CP_PROMOTE_PROD_API_TOKEN`, never the generic CP admin bearer.
 *
 * Rather than register these against the tenant host (where they would
 * silently 404/401 with the org key), they live here and:
 *   - point at the control plane (`MOLECULE_CP_URL` / `api.moleculesai.app`),
 *   - authenticate with the least-capable bearer for the exact operation,
 *   - are GATED on that bearer being present: when it's absent the tool
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

interface CpCallOptions {
  /** Per-call capability token. Omit to use the generic CP admin bearer. */
  token?: string;
  /** A synchronous boundary may require one exact success status. */
  expectedStatus?: number;
  /** Per-environment endpoint override for callers such as promote. */
  baseUrl?: string;
}

/** Authenticated CP request. Never throws. */
async function cpCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: CpCallOptions = {},
): Promise<T | ApiError> {
  const tok = options.token ?? process.env.CP_ADMIN_API_TOKEN;
  if (!tok) return cpNotConfigured(path) as ApiError;
  const base = (options.baseUrl ?? cpUrl()).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "curl/8.4.0",
        Authorization: `Bearer ${tok}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const accepted = options.expectedStatus === undefined
      ? res.ok
      : res.status === options.expectedStatus;
    if (!accepted) {
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
    logError(err, `CP admin API error (${method} ${path})`, { url: base });
    return { error: `Control plane unreachable at ${base}`, detail: msg };
  }
}

const GetOrgSchema = z.object({
  slug: z.string().describe("Org slug (e.g. 'agents-team')"),
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

// ---------------------------------------------------------------------------
// Synchronous tenant-fleet production promote (contract v2)
//
// The cross-repository request SSOT is molecule-ai-sdk:
// contracts/promote-request/promote-request.contract.json. This reader keeps a
// verbatim mirror under contracts/ and CI byte-compares it to SDK main. The
// control plane owns only tenant-fleet rollout; runtime/template/canvas/app/CP
// artifacts remain repository-owned CI-on-merge boundaries.
// ---------------------------------------------------------------------------

export const PROMOTE_REQUEST_FIELDS = ["env", "components", "dry_run", "confirm"] as const;
const PROMOTE_COMPONENT = "tenant-fleet" as const;
const PROMOTE_COMPONENT_SELECTORS = ["all", PROMOTE_COMPONENT] as const;
const PROMOTE_ENVIRONMENTS = ["production", "staging"] as const;

const PromoteToProductionInput = {
  env: z
    .enum(PROMOTE_ENVIRONMENTS)
    .optional()
    .describe("Environment assertion: production (default) or staging."),
  components: z
    .array(z.enum(PROMOTE_COMPONENT_SELECTORS))
    .max(1)
    .optional()
    .describe('Empty, ["all"], or ["tenant-fleet"]; every form selects the sole tenant-fleet component.'),
  dry_run: z
    .boolean()
    .optional()
    .describe("Defaults true. Plans and validates the immutable full-fleet rollout without mutation."),
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true for every wet full-fleet rollout; defaults false."),
};

const PromoteToProductionSchema = z.object(PromoteToProductionInput).strict();

function promoteCpUrl(env: (typeof PROMOTE_ENVIRONMENTS)[number]): string {
  const explicit = process.env.MOLECULE_CP_URL || process.env.CP_API_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (env === "staging") {
    return (process.env.MOLECULE_CP_STAGING_URL || "https://staging-api.moleculesai.app")
      .replace(/\/+$/, "");
  }
  return "https://api.moleculesai.app";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isImmutableImage(value: unknown): value is string {
  return typeof value === "string" && /@sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Independently verify CP's synchronous evidence envelope. A 200 or an
 * `ok:true` bit alone is never completion: the sole result must carry exact
 * immutable fleet coverage and one identity-bearing row per enumerated tenant.
 */
function promoteCompletionError(
  payload: unknown,
  env: (typeof PROMOTE_ENVIRONMENTS)[number],
  dryRun: boolean,
): string | undefined {
  if (!isRecord(payload)) return "response is not a JSON object";
  if (payload.ok !== true) return "ok=true is required";
  if (payload.complete !== !dryRun) {
    return dryRun ? "dry-run must report complete=false" : "wet rollout must report complete=true";
  }
  if (payload.env !== env) return `response env must equal ${env}`;
  if (payload.dry_run !== dryRun) return `response dry_run must equal ${dryRun}`;
  if (!Array.isArray(payload.results) || payload.results.length !== 1) {
    return "exactly one tenant-fleet result is required";
  }

  const result = payload.results[0];
  if (!isRecord(result) || result.component !== PROMOTE_COMPONENT) {
    return "the sole result must be component=tenant-fleet";
  }
  const expectedStatus = dryRun ? "planned" : "ok";
  if (result.status !== expectedStatus) return `tenant-fleet status must be ${expectedStatus}`;
  if (!isImmutableImage(result.target_image)) {
    return "tenant-fleet target_image must be an immutable sha256 digest reference";
  }

  const coverage = result.coverage;
  if (!isRecord(coverage)) return "tenant-fleet coverage is required";
  if (coverage.target_image !== result.target_image || !isImmutableImage(coverage.target_image)) {
    return "coverage target_image must equal the immutable tenant-fleet target";
  }
  if (coverage.target_tag !== undefined && coverage.target_tag !== "") {
    return "moving target_tag coverage is forbidden";
  }
  if (!isNonNegativeInteger(coverage.enumerated) || coverage.enumerated === 0) {
    return "coverage enumerated must be a positive integer";
  }
  for (const field of ["planned", "refreshed", "verified_on_target", "failed"] as const) {
    if (!isNonNegativeInteger(coverage[field])) return `coverage ${field} must be a non-negative integer`;
  }
  if (!Array.isArray(coverage.stragglers) || coverage.stragglers.length !== 0) {
    return "coverage must contain zero stragglers";
  }

  const enumerated = coverage.enumerated;
  if (dryRun) {
    if (
      coverage.planned !== enumerated ||
      coverage.refreshed !== 0 ||
      coverage.verified_on_target !== 0 ||
      coverage.failed !== 0
    ) {
      return "dry-run coverage must plan every tenant with zero refresh, verification, or failure";
    }
  } else if (
    coverage.planned !== 0 ||
    coverage.refreshed !== enumerated ||
    coverage.verified_on_target !== enumerated ||
    coverage.failed !== 0
  ) {
    return "wet coverage must refresh and verify every enumerated tenant with zero failures";
  }

  if (!Array.isArray(result.tenant_results) || result.tenant_results.length !== enumerated) {
    return "tenant_results must contain exactly one row per enumerated tenant";
  }
  const slugs = new Set<string>();
  for (const row of result.tenant_results) {
    if (!isRecord(row)) return "every tenant result must be an object";
    for (const field of ["slug", "instance_id", "provider", "phase"] as const) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        return `every tenant result requires a non-empty ${field}`;
      }
    }
    if (slugs.has(row.slug as string)) return `duplicate tenant result for ${row.slug as string}`;
    slugs.add(row.slug as string);
    if (row.error !== undefined && row.error !== "") return `tenant ${row.slug as string} reported an error`;
    if (dryRun) {
      if (row.ssm_status !== "DryRun" || row.verified_on_target !== false) {
        return `dry-run tenant ${row.slug as string} is not a non-mutating planned row`;
      }
    } else if (
      row.healthz_ok !== true ||
      row.verified_on_target !== true ||
      row.running_image !== result.target_image
    ) {
      return `tenant ${row.slug as string} did not prove healthy exact-image completion`;
    }
  }
  return undefined;
}

export async function handlePromoteToProduction(args: unknown) {
  const p = validate(args, PromoteToProductionSchema);
  const env = p.env ?? "production";
  const dryRun = p.dry_run ?? true;
  const confirm = p.confirm ?? false;
  const components: [typeof PROMOTE_COMPONENT] = [PROMOTE_COMPONENT];

  if (!dryRun && !confirm) {
    return toMcpResult({
      error: "CONFIRMATION_REQUIRED",
      detail:
        "refusing a wet tenant-fleet rollout without explicit operator GO; pass confirm:true or use dry_run:true",
      env,
      components,
      dry_run: false,
    });
  }

  const token = env === "production"
    ? process.env.CP_PROMOTE_PROD_API_TOKEN
    : process.env.CP_ADMIN_API_TOKEN;
  if (!token) {
    const required = env === "production" ? "CP_PROMOTE_PROD_API_TOKEN" : "CP_ADMIN_API_TOKEN";
    return toMcpResult({
      error: "CP_PROMOTE_NOT_CONFIGURED",
      detail:
        `promote_to_production for ${env} requires ${required}. ` +
        (env === "production"
          ? "The generic CP_ADMIN_API_TOKEN is never a production promote substitute."
          : "The production capability token is never sent to staging."),
      env,
      dry_run: dryRun,
    });
  }

  const body = { env, components, dry_run: dryRun, confirm };
  if (!dryRun) {
    logWarn("promote_to_production: confirmed synchronous tenant-fleet rollout", {
      audit: true,
      operation: "promote_to_production",
      env,
      components,
      timestamp: new Date().toISOString(),
    });
  }

  const response = await cpCall<Record<string, unknown>>(
    "POST",
    "/cp/admin/promote",
    body,
    { token, expectedStatus: 200, baseUrl: promoteCpUrl(env) },
  );
  if (isApiError(response)) {
    return toMcpResult({
      error: "PROMOTE_FAILED",
      detail: response,
      env,
      dry_run: dryRun,
    });
  }

  const incomplete = promoteCompletionError(response, env, dryRun);
  if (incomplete) {
    return toMcpResult({
      error: "PROMOTE_INCOMPLETE",
      detail: incomplete,
      env,
      dry_run: dryRun,
      response,
    });
  }
  return toMcpResult(response);
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
    "promote_to_production",
    "Management (CP-TIER): run the CP-native synchronous immutable tenant-fleet rollout. Runtime, template, canvas, app, control-plane, and tenant-proxy releases remain repository-owned CI-on-merge. dry_run defaults true and must return exact non-mutating fleet evidence; every wet rollout requires confirm:true as explicit operator GO and succeeds only on HTTP 200 with exact full-fleet coverage. Production requires the dedicated CP_PROMOTE_PROD_API_TOKEN; the generic CP admin bearer is never substituted.",
    PromoteToProductionInput,
    handlePromoteToProduction,
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
