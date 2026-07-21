/**
 * Runtime MODE detection — the single source of truth for the
 * `MOLECULE_MCP_MODE` server-mode selector.
 *
 * This is a LEAF module on purpose: it imports NOTHING from the rest of the
 * codebase (only reads process.env), so it can be imported by both the entry
 * point (index.ts) and low-level helpers (api.ts) without creating an import
 * cycle. Previously the `MOLECULE_MCP_MODE === "self"` predicate lived in
 * index.ts as isSelfMode() AND was duplicated in api.ts as a private
 * isSelfModeLocal() precisely because api.ts could not import from index.ts
 * (index.ts imports api.ts → a cycle). Lifting the predicate here removes that
 * duplication: both readers now agree by construction, not by copy.
 */

/**
 * True when the server runs as the SELF server (audience=self): the workspace
 * acting on ITSELF, authenticated with its OWN per-workspace token. Driven by
 * MOLECULE_MCP_MODE=self (case-insensitive).
 *
 * Security-sensitive — this predicate gates (a) the fail-closed workspace-token
 * bearer path in api.ts::authHeaders() and (b) the self-only workspace_id
 * default in tools/schedules.ts. In NON-self mode neither of those self-scoped
 * behaviours may apply.
 */
export function isSelfMode(): boolean {
  return (process.env.MOLECULE_MCP_MODE || "").toLowerCase() === "self";
}

/**
 * True when the server runs as the MANAGEMENT server (the cross-org /
 * org-lifecycle surface) rather than the legacy single-tenant workspace-ops
 * surface. Driven by MOLECULE_MCP_MODE=management (case-insensitive).
 *
 * Security-sensitive — this predicate gates the MOLECULE_ORG_API_KEY
 * (org-admin) fallback bearer in api.ts::authHeaders(): that org key may be
 * emitted ONLY in management mode, never in the default a2a/workspace-ops mode.
 * Lives here (the leaf module) so api.ts can read it without an index.ts ⇄
 * api.ts import cycle; index.ts re-exports it for existing importers.
 */
export function isManagementMode(): boolean {
  return (process.env.MOLECULE_MCP_MODE || "").toLowerCase() === "management";
}
