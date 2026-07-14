import { error as logError } from "./utils/logger.js";

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
 */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = process.env.MOLECULE_API_KEY || process.env.MOLECULE_API_TOKEN;
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
