/**
 * Management-registry HTTP client.
 *
 * The legacy workspace-ops surface (src/api.ts) talks to ONE tenant whose
 * workspace-server is fail-open / co-located, so it sends no Authorization
 * header. The management registry is different: it targets a HARDENED remote
 * tenant host and must present the Org API Key on every call.
 *
 * Auth model (see PLATFORM-MANAGEMENT-API.md §1 / §5 and the tenant router
 * `internal/router/router.go`):
 *   - `Authorization: Bearer ${MOLECULE_ORG_API_KEY}` — the dashboard
 *     "Org API Keys" credential. It is `org_api_tokens` (sha256-hashed,
 *     prefixed, revocable) and is FULL TENANT-ADMIN for its own org. It
 *     satisfies the tenant `AdminAuth` and `WorkspaceAuth` gates.
 *   - `X-Molecule-Org-Id: ${MOLECULE_ORG_ID}` — the tenant `TenantGuard`
 *     rejects any request whose org id doesn't match the EC2 it lands on.
 *
 * SECURITY: the Org API Key is full-tenant-admin AND self-minting (it can
 * mint/revoke more org tokens via /org/tokens). A management MCP holding one
 * holds tenant root. There is no scope-down below full-admin today.
 *
 * This client deliberately reuses the ApiError shape + toMcpResult/toMcpText
 * envelopes from ../../api.js so the management tools return the exact same
 * structured output as every other tool (SSOT for the response envelope).
 */

import { error as logError } from "../../utils/logger.js";
import type { ApiError } from "../../api.js";

/**
 * The tenant host the management tools talk to. Same env precedence as the
 * legacy surface so a single server config drives both, but documented here
 * because the management tools point at the PER-ORG tenant host
 * (`<slug>.moleculesai.app`), not the control plane.
 *
 * Resolved at CALL time (not module-load) so the host can be configured /
 * overridden after import — and so the value is correct regardless of import
 * ordering.
 */
export function managementUrl(): string {
  return (
    process.env.MOLECULE_API_URL ||
    process.env.MOLECULE_URL ||
    process.env.PLATFORM_URL ||
    "http://localhost:8080"
  );
}

/** The org id management writes route to (X-Molecule-Org-Id). */
export function defaultOrgId(): string | undefined {
  return process.env.MOLECULE_ORG_ID;
}

/**
 * Build the auth headers for a tenant-host request. Returns an ApiError
 * (never throws) when the Org API Key is absent so the tool surfaces a clean
 * AUTH_ERROR instead of a confusing upstream 401.
 */
function managementHeaders(): Record<string, string> | ApiError {
  const tok = process.env.MOLECULE_ORG_API_KEY;
  if (!tok) {
    return {
      error: "AUTH_ERROR",
      detail:
        "MOLECULE_ORG_API_KEY is not set. The management tools require an Org " +
        "API Key (dashboard → Org API Keys) presented as a tenant credential.",
    };
  }
  const orgId = process.env.MOLECULE_ORG_ID;
  const slug = process.env.MOLECULE_ORG_SLUG;
  if (!orgId && !slug) {
    return {
      error: "AUTH_ERROR",
      detail:
        "MOLECULE_ORG_ID or MOLECULE_ORG_SLUG is required. The tenant host " +
        "needs a routing header so the edge / TenantGuard can route and " +
        "authorize against the correct org.",
    };
  }
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${tok}`,
  };
  if (orgId) h["X-Molecule-Org-Id"] = orgId;
  if (slug) h["X-Molecule-Org-Slug"] = slug;
  return h;
}

function isHeaders(v: Record<string, string> | ApiError): v is Record<string, string> {
  return !("error" in v);
}

/**
 * Authenticated request against the tenant host. Never throws — returns the
 * decoded JSON body on success or a structured ApiError on failure, exactly
 * like ../../api.js::apiCall.
 */
export async function mgmtCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T | ApiError> {
  const headers = managementHeaders();
  if (!isHeaders(headers)) return headers;
  try {
    const base = managementUrl();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(extraHeaders ?? {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { error: "AUTH_ERROR", detail: text, status: res.status };
      }
      if (res.status === 429) {
        return { error: "RATE_LIMITED", detail: text, status: res.status };
      }
      return { error: `HTTP ${res.status}`, detail: text, status: res.status };
    }
    const text = await res.text();
    if (text.length === 0) return { raw: "", status: res.status } as ApiError;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { raw: text, status: res.status } as ApiError;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(err, `Management API error (${method} ${path})`, { url: managementUrl() });
    return { error: `Tenant host unreachable at ${managementUrl()}`, detail: msg };
  }
}

/** Convenience GET wrapper. */
export async function mgmtGet<T = unknown>(path: string): Promise<T | ApiError> {
  return mgmtCall<T>("GET", path);
}
