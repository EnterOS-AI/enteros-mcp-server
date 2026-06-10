/**
 * Issue-filing tool — `create_issue`.
 *
 * Lets a platform operator or agent file a STRUCTURED bug report into Gitea so
 * the maintenance / dev team has an actionable, uniformly-shaped ticket instead
 * of a free-text Slack/chat message that gets lost. The whole point is that the
 * caller supplies the context it already holds — which org, which workspace /
 * agent, whether the tenant is EXTERNAL (customer-facing) or internal, severity,
 * component, environment, related ids — and this tool renders it into a
 * consistent issue body + Gitea labels the triage team can filter on.
 *
 * Gitea, NOT the control plane: bugs are tracked in Gitea (the canonical SCM,
 * `git.moleculesai.app`), so this is the one tool family that talks to a
 * different host with a different credential. The client below is modelled
 * exactly on tools/management/client.ts::mgmtCall — never throws, returns the
 * decoded body on success or a structured ApiError on failure — so the response
 * envelope stays SSOT with every other tool.
 *
 * Auth: a dedicated issue-bot token in GITEA_ISSUE_TOKEN, scoped to
 * `issue:write` on the triage repo. We deliberately do NOT reuse a
 * tenant/admin credential here — filing issues is a narrow capability and
 * should hold a narrow token.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpResult, isApiError, type ApiError } from "../api.js";
import { error as logError } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Config (resolved at CALL time, not module-load, so it can be configured /
// overridden after import — same convention as management/client.ts).
// ---------------------------------------------------------------------------

/** Gitea REST base, e.g. https://git.moleculesai.app/api/v1 (no trailing slash). */
export function giteaApiUrl(): string {
  const raw =
    process.env.GITEA_API_URL ||
    process.env.GITEA_URL ||
    "https://git.moleculesai.app/api/v1";
  return raw.replace(/\/+$/, "");
}

/**
 * The default `owner/name` repo new issues land in when the caller doesn't
 * pass `repo`. A single triage repo keeps reports in one queue the
 * maintenance team owns; callers can still target a specific product repo.
 */
export function defaultIssueRepo(): string | undefined {
  return process.env.GITEA_ISSUE_REPO;
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const ENVIRONMENTS = ["prod", "staging", "dev"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface CreateIssueParams {
  title: string;
  description: string;
  repo?: string;
  severity?: Severity;
  external?: boolean;
  org_id?: string;
  org_slug?: string;
  workspace_id?: string;
  agent_role?: string;
  component?: string;
  environment?: Environment;
  related_ids?: string[];
  reproduction?: string;
  logs_excerpt?: string;
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Pure rendering — kept side-effect-free so it is unit-testable without a
// network. buildIssueBody + deriveLabelNames are exported for the tests.
// ---------------------------------------------------------------------------

function row(k: string, v: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  return `| ${k} | ${v} |`;
}

/**
 * Render the structured fields into a Markdown issue body: a context table the
 * triage team can scan at a glance, then the free-text sections. Stable shape
 * so issues are uniform regardless of which agent filed them.
 */
export function buildIssueBody(p: CreateIssueParams): string {
  const tenancy =
    p.external === undefined ? undefined : p.external ? "external (customer-facing)" : "internal";
  const tableRows = [
    row("Severity", p.severity),
    row("Tenancy", tenancy),
    row("Component", p.component),
    row("Environment", p.environment),
    row("Org", p.org_slug ? `${p.org_slug}${p.org_id ? ` (${p.org_id})` : ""}` : p.org_id),
    row("Workspace", p.workspace_id),
    row("Agent role", p.agent_role),
  ].filter((r): r is string => r !== undefined);

  const parts: string[] = [];
  if (tableRows.length > 0) {
    parts.push(["| Field | Value |", "| --- | --- |", ...tableRows].join("\n"));
  }
  parts.push(`## Description\n\n${p.description.trim()}`);
  if (p.reproduction && p.reproduction.trim()) {
    parts.push(`## Reproduction\n\n${p.reproduction.trim()}`);
  }
  if (p.related_ids && p.related_ids.length > 0) {
    parts.push(`## Related\n\n${p.related_ids.map((id) => `- ${id}`).join("\n")}`);
  }
  if (p.logs_excerpt && p.logs_excerpt.trim()) {
    parts.push(
      `## Logs (excerpt)\n\n> Redact secrets before filing — this body is stored in Gitea.\n\n\`\`\`\n${p.logs_excerpt.trim()}\n\`\`\``,
    );
  }
  const actor = process.env.MOLECULE_AUDIT_ACTOR || "molecule-mcp";
  parts.push(`---\n_Filed via \`create_issue\` (molecule-mcp-server) by ${actor}._`);
  return parts.join("\n\n");
}

/**
 * Derive Gitea label NAMES from the structured fields, plus any caller-supplied
 * labels. These are best-effort resolved to existing label ids at file time
 * (missing labels are reported, not auto-created — label taxonomy is the dev
 * team's to own).
 */
export function deriveLabelNames(p: CreateIssueParams): string[] {
  const out = new Set<string>(["source/mcp-filed"]);
  if (p.severity) out.add(`severity/${p.severity}`);
  if (p.external !== undefined) out.add(p.external ? "tenancy/external" : "tenancy/internal");
  if (p.component) out.add(`component/${p.component}`);
  if (p.environment) out.add(`env/${p.environment}`);
  for (const l of p.labels ?? []) {
    const t = l.trim();
    if (t) out.add(t);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Gitea client — never throws, returns ApiError on failure (mgmtCall shape).
// ---------------------------------------------------------------------------

function giteaHeaders(): Record<string, string> | ApiError {
  const tok = process.env.GITEA_ISSUE_TOKEN || process.env.GITEA_TOKEN;
  if (!tok) {
    return {
      error: "AUTH_ERROR",
      detail:
        "GITEA_ISSUE_TOKEN is not set. create_issue needs a Gitea token scoped " +
        "to issue:write on the triage repo to file bug reports.",
    };
  }
  return { "Content-Type": "application/json", Authorization: `token ${tok}` };
}

async function giteaCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | ApiError> {
  const headers = giteaHeaders();
  if (isApiError(headers)) return headers;
  const base = giteaApiUrl();
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers as Record<string, string>,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        return { error: "AUTH_ERROR", detail: text, status: res.status };
      }
      if (res.status === 404) {
        return { error: "NOT_FOUND", detail: text, status: res.status };
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
    logError(err, `Gitea API error (${method} ${path})`, { url: base });
    return { error: `Gitea unreachable at ${base}`, detail: msg };
  }
}

interface GiteaLabel {
  id: number;
  name: string;
}

/**
 * Resolve label names to ids in `repo`, best-effort. Returns the ids that
 * exist and the names that didn't (so the caller can see what was dropped —
 * "no silent caps"). A lookup failure degrades to "attach nothing" rather than
 * failing the whole file — the body table still carries the taxonomy.
 */
async function resolveLabelIds(
  repo: string,
  names: string[],
): Promise<{ ids: number[]; matched: string[]; unmatched: string[] }> {
  if (names.length === 0) return { ids: [], matched: [], unmatched: [] };
  const res = await giteaCall<GiteaLabel[]>("GET", `/repos/${repo}/labels?limit=100`);
  if (isApiError(res) || !Array.isArray(res)) {
    return { ids: [], matched: [], unmatched: names };
  }
  const byName = new Map(res.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: number[] = [];
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const n of names) {
    const id = byName.get(n.toLowerCase());
    if (id !== undefined) {
      ids.push(id);
      matched.push(n);
    } else {
      unmatched.push(n);
    }
  }
  return { ids, matched, unmatched };
}

export async function handleCreateIssue(params: CreateIssueParams) {
  const repo = (params.repo || defaultIssueRepo() || "").trim();
  if (!repo) {
    return toMcpResult({
      error: "CONFIG_ERROR",
      detail:
        "No target repo. Pass `repo` ('owner/name') or set GITEA_ISSUE_REPO " +
        "to the default triage repo.",
    });
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return toMcpResult({
      error: "VALIDATION_ERROR",
      detail: `repo must be 'owner/name', got '${repo}'.`,
    });
  }

  const labelNames = deriveLabelNames(params);
  const { ids, unmatched } = await resolveLabelIds(repo, labelNames);

  const body = buildIssueBody(params);
  const created = await giteaCall<{ number: number; html_url: string; title: string }>(
    "POST",
    `/repos/${repo}/issues`,
    { title: params.title, body, labels: ids },
  );
  if (isApiError(created)) {
    // Surface the structured Gitea error verbatim so the caller can act on it.
    return toMcpResult(created);
  }
  return toMcpResult({
    ok: true,
    repo,
    number: created.number,
    url: created.html_url,
    title: created.title,
    labels_applied: labelNames.filter((n) => !unmatched.includes(n)),
    labels_unmatched: unmatched,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIssueTools(srv: McpServer) {
  srv.tool(
    "create_issue",
    "File a structured bug report as a Gitea issue for the maintenance/dev team. " +
      "Supply the context you already have (org, workspace, agent, whether the " +
      "tenant is external/customer-facing, severity, component, environment, " +
      "related ids) — it is rendered into a uniform issue body + triage labels. " +
      "Targets GITEA_ISSUE_REPO unless `repo` ('owner/name') is given. " +
      "Do NOT include secrets/credentials in any field.",
    {
      title: z.string().describe("Short one-line summary of the bug."),
      description: z.string().describe("Detailed description: what happened, expected vs actual, impact."),
      repo: z
        .string()
        .optional()
        .describe("Target repo 'owner/name'. Defaults to GITEA_ISSUE_REPO (the triage queue)."),
      severity: z.enum(SEVERITIES).optional().describe("critical | high | medium | low"),
      external: z
        .boolean()
        .optional()
        .describe("true if this concerns an EXTERNAL (customer-facing) tenant; false for internal."),
      org_id: z.string().optional().describe("Molecule org id the bug pertains to."),
      org_slug: z.string().optional().describe("Molecule org slug (human-readable)."),
      workspace_id: z.string().optional().describe("Affected workspace / agent id."),
      agent_role: z.string().optional().describe("Agent role, e.g. 'kimi-coder', 'reviewer'."),
      component: z
        .string()
        .optional()
        .describe("Affected component, e.g. controlplane, runtime, mcp-server, provisioner."),
      environment: z.enum(ENVIRONMENTS).optional().describe("prod | staging | dev"),
      related_ids: z
        .array(z.string())
        .optional()
        .describe("Related ids: PR numbers, run ids, request ids, EC2 instance ids, etc."),
      reproduction: z.string().optional().describe("Steps to reproduce, if known."),
      logs_excerpt: z
        .string()
        .optional()
        .describe("Short log/error excerpt. REDACT secrets — this is stored in Gitea."),
      labels: z
        .array(z.string())
        .optional()
        .describe("Extra Gitea label names to attach (best-effort; existing labels only)."),
    },
    handleCreateIssue,
  );
}
