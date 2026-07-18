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
