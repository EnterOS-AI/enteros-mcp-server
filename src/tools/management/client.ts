/**
 * Management-registry HTTP client.
 *
 * Both registries target one per-tenant workspace host. The workspace surface
 * sends `MOLECULE_API_KEY` when configured; omission is supported only by a
 * no-auth localhost stack. The management registry requires
 * `MOLECULE_ORG_API_KEY` (the full-tenant-admin Org API Key) on every call.
 *
 * Auth model (see PLATFORM-MANAGEMENT-API.md §1 / §5 and the tenant router
 * `internal/router/router.go`):
 *   - `Authorization: Bearer ${MOLECULE_ORG_API_KEY}` — the dashboard
 *     "Org API Keys" credential. It is `org_api_tokens` (sha256-hashed,
 *     prefixed, revocable) and is FULL TENANT-ADMIN for its own org. It
 *     satisfies the tenant `AdminAuth` and `WorkspaceAuth` gates.
 *   - `X-Molecule-Org-Id: ${MOLECULE_ORG_ID}` — the tenant `TenantGuard`
 *     rejects a request whose org id does not match the routed tenant.
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
 * The CALLER'S OWN workspace id — the "self" a self-defaulting management tool
 * (install_plugin / list_available_plugins / get_conversation_history) acts on
 * when the caller omits workspace_id.
 *
 * SSOT for the self-workspace lookup. Reads MOLECULE_WORKSPACE_ID first (the
 * concierge-specific alias the platform-MCP env injector sets — core#b59d243e),
 * then falls back to WORKSPACE_ID, the UNIVERSAL workspace-id env every
 * workspace container carries (workspace-server buildContainerEnv:
 * `WORKSPACE_ID=<uuid>`). The fallback makes zero-config self-install work on
 * EVERY tenant image regardless of version skew: images predating the concierge
 * env fix (e.g. molecule-tenant:staging-40779bd / f5071e5) never set
 * MOLECULE_WORKSPACE_ID, so without this fallback the SELF default failed closed
 * with INVALID_ARGUMENTS on the live concierge (core#182 follow-up). WORKSPACE_ID
 * is always present, so this is robust and not tenant-image-version-coupled.
 */
export function selfWorkspaceId(): string | undefined {
  return process.env.MOLECULE_WORKSPACE_ID || process.env.WORKSPACE_ID;
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
  // The X-Molecule-Org-* routing header disambiguates WHICH tenant a request is
  // for at the domain edge (`<slug>.moleculesai.app` → that tenant's
  // TenantGuard). On a SELF-HOST / local stack there is no edge and no
  // multi-tenancy: MOLECULE_URL points DIRECTLY at the single-tenant
  // workspace-server, the org has no CP-assigned id/slug (`/org/identity` is
  // empty, the workspace row's org_id is null by design — core#3496), and the
  // Org API Key alone identifies the org. SaaS ALWAYS sets MOLECULE_ORG_ID (the
  // CP provisioner injects it), so `both-empty ⟺ self-host`. In that case we
  // proceed BEARER-ONLY (no routing header) instead of failing closed — the
  // single-tenant host resolves the org from the credential. Hard-failing here
  // was the self-host management-tool fail-close (concierge could not
  // provision/list on a directly-addressed tenant host).
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
