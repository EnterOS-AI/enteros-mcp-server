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
import { toMcpResult } from "../../api.js";
import { validate } from "../../utils/validation.js";
import { error as logError } from "../../utils/logger.js";
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
async function cpCall<T = unknown>(method: string, path: string): Promise<T | ApiError> {
  const tok = process.env.CP_ADMIN_API_TOKEN;
  if (!tok) return cpNotConfigured(path) as ApiError;
  try {
    const base = cpUrl();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
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
}
