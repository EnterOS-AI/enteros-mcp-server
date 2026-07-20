import { readFileSync } from "node:fs";
import { error as logError } from "./utils/logger.js";
import { isSelfMode } from "./mode.js";

// Default on-disk location of the per-workspace token inside a workspace
// container. This is the restart-ROTATED file written by the runtime
// (platform_auth.py) — the in-container SSOT for the workspace token. It is
// NOT an env var (an env-injected token can't be re-read after rotation). The
// self-mode auth path reads it fresh on every call. Overridable via
// MOLECULE_WORKSPACE_TOKEN_FILE for tests / non-default layouts.
const DEFAULT_WORKSPACE_TOKEN_FILE = "/configs/.auth_token";

/**
 * Read the per-workspace token for SELF mode from the on-disk auth-token file,
 * FRESH on every call (never cached at module load) so a restart-driven token
 * rotation is picked up without restarting this Node child.
 *
 * Returns the trimmed token, or "" when the file is missing / empty / unreadable
 * — the caller then omits the Authorization header entirely (fail-closed): the
 * request 401s rather than silently falling back to any other credential.
 */
function readWorkspaceToken(): string {
  const path =
    process.env.MOLECULE_WORKSPACE_TOKEN_FILE || DEFAULT_WORKSPACE_TOKEN_FILE;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    // Missing/unreadable file → fail closed. Intentionally swallowed: a self
    // request with no token must 401 at core, never escalate to the org key.
    return "";
  }
}

// Read the per-tenant workspace API base URL from environment.
// Priority: MOLECULE_API_URL (canonical CLI/SDK env var, per platform docs).
//
//   > Primary environment variable:
//   >   MOLECULE_API_URL  — per-tenant workspace API base URL
//
// SaaS callers use https://<slug>.moleculesai.app. The control-plane host
// https://api.moleculesai.app is a separate tier used only by the gated CP-admin
// module; do not send a tenant API token there.
//
// Fallbacks exist for legacy callers (MOLECULE_URL, PLATFORM_URL) and
// the no-auth localhost development default.
export const PLATFORM_URL =
  process.env.MOLECULE_API_URL ||
  process.env.MOLECULE_URL ||
  process.env.PLATFORM_URL ||
  "http://localhost:8080";

/**
 * Shape returned by apiCall when the request fails (network error, non-2xx,
 * or non-JSON body with no error). Returned-by-value — apiCall never throws.
 */
export type ApiError = { error: string; detail?: string; raw?: string; status?: number };

export function isApiError(v: unknown): v is ApiError {
  return !!v && typeof v === "object" && "error" in (v as object);
}

/**
 * Build the Authorization header for platform requests.
 *
 * When an auth token env var is set and non-empty we send
 * `Authorization: Bearer <token>`. Token resolution (first non-empty wins):
 *   MOLECULE_API_KEY → MOLECULE_API_TOKEN
 * This is the bearer credential expected by the configured tenant's
 * workspace/agent/memory/etc. routes.
 *
 * When the key is unset/empty we send no auth header only to preserve the
 * no-auth localhost development path. A real tenant host requires a key;
 * startup preflight reports that misconfiguration.
 *
 * SaaS tenant routing: when MOLECULE_ORG_ID (canonical) or its legacy aliases
 * are set, we also attach `X-Molecule-Org-Id` so the multi-tenant gateway can
 * route the request. Omitted when unset to preserve single-tenant behaviour.
 *
 * The `extraHeaders` parameter on apiCall() remains the seam for tenant routes
 * that require an additional endpoint-specific header.
 *
 * SELF mode (MOLECULE_MCP_MODE=self, audience=self) is a SEPARATE, fail-closed
 * bearer path handled first: the bearer is the per-workspace token read from
 * disk per call, and it is used EXCLUSIVELY. In self mode we NEVER read
 * MOLECULE_API_KEY / MOLECULE_API_TOKEN (on a concierge box that is the
 * org-admin key — sending it here would let a self-scoped tool act org-wide)
 * and we set X-Molecule-Org-Id ONLY as the tenant ROUTING header (never the org
 * key): the bearer stays the per-workspace token, so core's WorkspaceAuth binds
 * the call to its own :id (a foreign :id 401s intrinsically) — the org id merely
 * selects the tenant, which the SaaS tenant API REQUIRES on every request
 * (TENANT_ORG_HEADER_REQUIRED otherwise). A missing or empty token file yields
 * NO Authorization header so the call 401s.
 */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // Self mode: workspace-token-ONLY AUTH, fail-closed. Handled before — and with
  // an early return that bypasses — the org/operator-key path below.
  if (isSelfMode()) {
    const wsToken = readWorkspaceToken();
    if (wsToken.length > 0) {
      headers.Authorization = `Bearer ${wsToken}`;
    }
    // Empty/missing token → no Authorization header → 401 (fail closed).
    // CRITICAL: never fall through to MOLECULE_API_KEY / MOLECULE_API_TOKEN.
    //
    // Attach the tenant ROUTING header. This is NOT a privilege: the bearer stays
    // the per-workspace token (core WorkspaceAuth still binds to the OWN :id — a
    // foreign :id 401s), the org id only selects the tenant. The SaaS tenant API
    // requires X-Molecule-Org-Id on EVERY request (400 TENANT_ORG_HEADER_REQUIRED
    // otherwise), so omitting it makes every self-mode tenant call fail.
    const selfOrgId =
      process.env.MOLECULE_ORG_ID ||
      process.env.MOLECULE_ORGANIZATION_ID ||
      process.env.MOLECULE_ORG;
    if (selfOrgId && selfOrgId.length > 0) {
      headers["X-Molecule-Org-Id"] = selfOrgId;
    }
    return headers;
  }

  // MOLECULE_ORG_API_KEY is the management/concierge org-admin bearer (audience=org
  // injector credential_env; the management tools read it strictly in
  // tools/management/client.ts). Adding it here lets the api.ts-based tools —
  // notably the cross-workspace SCHEDULE tools now registered in management mode —
  // authenticate on the management surface, where MOLECULE_API_KEY/_TOKEN are not
  // set. It is a FALLBACK (the existing vars win) and is safe: self mode early-
  // returns above and never reaches this line, and MOLECULE_ORG_API_KEY is only
  // ever injected into the management MCP process, never an ordinary workspace.
  const key =
    process.env.MOLECULE_API_KEY ||
    process.env.MOLECULE_API_TOKEN ||
    process.env.MOLECULE_ORG_API_KEY;
  if (key && key.length > 0) {
    headers.Authorization = `Bearer ${key}`;
  }
  const orgId =
    process.env.MOLECULE_ORG_ID ||
    process.env.MOLECULE_ORGANIZATION_ID ||
    process.env.MOLECULE_ORG;
  if (orgId && orgId.length > 0) {
    headers["X-Molecule-Org-Id"] = orgId;
  }
  return headers;
}

/**
 * Wrap arbitrary JSON-serialisable data in the MCP content envelope that
 * tool handlers must return. Centralised so every handler uses the exact
 * same shape (and a future switch to e.g. structured content happens once).
 */
export function toMcpResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Wrap a plain string (file contents, assistant reply text, error message)
 * in the MCP content envelope without JSON-stringifying it. For the handful
 * of handlers that return raw text rather than a JSON blob.
 */
export function toMcpText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export async function apiCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  // Optional per-call header overrides. Merged LAST so a tenant endpoint can
  // override or augment the default Bearer when its contract requires it.
  extraHeaders?: Record<string, string>,
): Promise<T | ApiError> {
  try {
    // Precedence: base (Content-Type) < authHeaders() < extraHeaders.
    const res = await fetch(`${PLATFORM_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(extraHeaders ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: `HTTP ${res.status}`, detail: text };
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return { raw: text, status: res.status } as ApiError;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(err, `Molecule AI API error (${method} ${path})`, { platformUrl: PLATFORM_URL });
    return { error: `Platform unreachable at ${PLATFORM_URL}`, detail: msg };
  }
}

/**
 * GET helper with automatic retry on 429 (Too Many Requests).
 *
 * Retries up to `maxRetries` times, honouring the `Retry-After` header when
 * present (seconds, rounded up to ms). When absent uses exponential backoff
 * with ±25% jitter, starting at 1 s and doubling each attempt.
 *
 * After exhausting retries returns `{ error: "RATE_LIMITED", detail: … }`
 * so callers can surface a structured `RATE_LIMITED` MCP error code.
 *
 * Only use for idempotent GET calls. For POST/DELETE, stick with `apiCall`.
 */
export async function platformGet<T = unknown>(
  path: string,
  maxRetries = 3,
  // Optional per-call header overrides, merged LAST (same precedence as
  // apiCall): base < authHeaders() < extraHeaders.
  extraHeaders?: Record<string, string>,
): Promise<T | ApiError> {
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(`${PLATFORM_URL}${path}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
          ...(extraHeaders ?? {}),
        },
      });

      if (res.status === 429 && attempt < maxRetries) {
        attempt++;
        const retryAfter = res.headers.get("Retry-After");
        let delayMs: number;

        if (retryAfter !== null) {
          // Retry-After is in seconds (integer or float).
          delayMs = Math.ceil(parseFloat(retryAfter) * 1000);
        } else {
          // Exponential back-off with ±25% jitter.
          const base = 1_000 * 2 ** (attempt - 1); // 1 s, 2 s, 4 s …
          const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25%
          delayMs = Math.round(base + jitter);
        }

        // Cap at 30 s to avoid very long waits consuming a handler slot.
        delayMs = Math.min(delayMs, 30_000);
        await sleep(delayMs);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        // After exhausting 429 retries the loop exits here; all other
        // non-ok statuses also return early rather than falling through.
        if (res.status === 429) {
          return { error: "RATE_LIMITED", detail: text };
        }
        return { error: `HTTP ${res.status}`, detail: text };
      }

      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        return { raw: text, status: res.status } as ApiError;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(err, `Molecule AI API error (GET ${path})`, { platformUrl: PLATFORM_URL });
      return { error: `Platform unreachable at ${PLATFORM_URL}`, detail: msg };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

