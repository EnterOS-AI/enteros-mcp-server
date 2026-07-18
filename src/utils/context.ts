/**
 * AsyncLocalStorage context for structured logging.
 *
 * Each MCP tool call runs in an isolated AsyncLocalStorage slot.  The slot is
 * populated at the start of the handler (before any business logic runs) with
 * whatever context fields are available from the MCP request:
 *
 *   - toolName   — the tool being called
 *   - requestId  — the JSON-RPC request id (if present)
 *   - workspaceId — X-Workspace-ID header value (if present)
 *
 * Any downstream code (apiCall, platformGet, tool helpers) that calls
 * `getContext()` automatically picks up the current call's fields without
 * needing them threaded through every function signature.
 *
 * Example:
 *   import { getContext, withContext } from "./context.js";
 *
 *   // In a tool handler:
 *   const ctx = getContext();
 *   ctx.toolName; // "list_workspaces"
 *
 *   // When launching an async operation:
 *   await withContext({ taskId: "abc123" }, async () => {
 *     await doSomething();
 *   });
 */

import { AsyncLocalStorage } from "async_hooks";

/** Fields that are available in every MCP tool-call context. */
export interface RequestContext {
  toolName?: string;
  requestId?: string;
  workspaceId?: string;
  /** Extra fields merged in via withContext(). */
  [key: string]: string | undefined;
}

/** The AsyncLocalStorage slot — package-private. */
const _als = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context, or an empty object if called outside any
 * AsyncLocalStorage scope (e.g. module-level init, health-check, etc.).
 */
export function getContext(): RequestContext {
  return _als.getStore() ?? {};
}

/**
 * Run `fn` inside a context that inherits the current AsyncLocalStorage slot
 * plus any additional fields passed in `extra`.  This is the primary way to
 * propagate context into background tasks, setTimeout callbacks, etc.
 *
 * @example
 *   await withContext({ taskId: "abc" }, () => sendHeartbeat());
 */
export function withContext<R>(
  extra: Partial<RequestContext>,
  fn: () => R,
): R {
  const parent = getContext();
  const merged = { ...parent, ...extra };
  return _als.run(merged, fn);
}

/**
 * Run `fn` inside a fresh context that starts from `initial` (no inherited
 * fields).  Use this at the top of a request/handler to establish a clean
 * slate.
 */
export function runWithContext<R>(
  initial: RequestContext,
  fn: () => R,
): R {
  return _als.run(initial, fn);
}

/**
 * The CALLER'S OWN workspace id — the "self" that a self-defaulting tool acts on
 * when the caller omits workspace_id. Shared SSOT for the self-workspace lookup,
 * imported by BOTH the management registry (tools/management/client.ts, which
 * re-exports it) and the self-mode schedule tools (tools/schedules.ts).
 *
 * Reads MOLECULE_WORKSPACE_ID first (the concierge-specific alias the
 * platform-MCP env injector sets — core#b59d243e), then falls back to
 * WORKSPACE_ID, the UNIVERSAL workspace-id env every workspace container carries
 * (workspace-server buildContainerEnv: `WORKSPACE_ID=<uuid>`). The fallback
 * makes zero-config self-defaulting work on EVERY tenant image regardless of
 * version skew: images predating the concierge env fix never set
 * MOLECULE_WORKSPACE_ID, so without this fallback the SELF default failed closed
 * with INVALID_ARGUMENTS on the live concierge (core#182 follow-up). WORKSPACE_ID
 * is always present, so this is robust and not tenant-image-version-coupled.
 */
export function selfWorkspaceId(): string | undefined {
  return process.env.MOLECULE_WORKSPACE_ID || process.env.WORKSPACE_ID;
}
