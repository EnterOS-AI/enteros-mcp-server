import { error as logError } from "./utils/logger.js";

// Read the platform API base URL from environment.
// Priority: MOLECULE_API_URL (canonical CLI/SDK env var, per platform docs)
//
//   > Required environment variables:
//   >   MOLECULE_API_URL  — Control plane API base URL
//   >   MOLECULE_RUNTIME_URL — Workspace runtime URL
//   >   (per docs/development/constraints-and-rules.md)
//
// Fallbacks exist for legacy callers (MOLECULE_URL, PLATFORM_URL) and
// localhost dev default. Injecting MOLECULE_API_URL at container provision
// is handled by platform/internal/provisioner/provisioner.go.
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
 * When MOLECULE_API_KEY is set and non-empty we send
 * `Authorization: Bearer <key>`. This is the admin-Bearer credential the
 * control plane expects for the majority of admin endpoints
 * (`/cp/admin/orgs`, `/cp/admin/orgs/:slug/*`, and the workspace/agent/
 * memory/etc. tool families that route through it).
 *
 * When the key is unset/empty we send NO auth header — this is deliberate
 * back-compat so a no-auth localhost dev platform keeps working. Auth is NOT
 * hard-required at the request layer; misconfiguration is surfaced loudly at
 * startup (see the preflight in src/index.ts) rather than by failing closed
 * on every call.
 *
 * NOTE (follow-up, tracked in issue #36): a handful of endpoints need
 * different/extra credentials that this single Bearer does not cover —
 *   • POST /cp/workspaces/provision and DELETE /cp/workspaces/:id need a
 *     two-factor pair: `Authorization: Bearer <PROVISION_SHARED_SECRET>`
 *     plus `X-Molecule-Admin-Token: <tenant admin_token>`.
 *   • /cp/internal/llm/* need a tenant-scoped `Authorization: Bearer
 *     <tenant admin_token>` rather than the admin key.
 * The `extraHeaders` parameter on apiCall() is the hook that lets those tools
 * override/augment auth per call; wiring the provision-secret env and the
 * tenant-token fetch into those specific tools is a focused follow-up.
 */
export function authHeaders(): Record<string, string> {
  const key = process.env.MOLECULE_API_KEY;
  if (key && key.length > 0) {
    return { Authorization: `Bearer ${key}` };
  }
  return {};
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
  // Optional per-call header overrides. Merged LAST so a caller can override
  // or augment the Bearer auth — e.g. the two-factor provision endpoints that
  // need an additional `X-Molecule-Admin-Token`, or the tenant-scoped
  // `/cp/internal/llm/*` endpoints that need a different Bearer (see #36).
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
