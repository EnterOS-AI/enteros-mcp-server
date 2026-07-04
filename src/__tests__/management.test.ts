/**
 * Unit tests for the management tool registry (Org API Key, tenant host).
 *
 * The HTTP layer is mocked via global.fetch so no real requests are made.
 * Tests assert the exact URL + method + body + auth headers each tool sends,
 * the auth-gating when the Org API Key is absent, and the CP-tier gating.
 */

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registeredToolNames: string[] = [];
    tool(name: string) {
      // Mirror the real SDK: duplicate tool names throw at registration.
      // Without this the composed-server test cannot catch cross-registry
      // collisions (the management create_request duplicate killed the
      // management server at startup on 2026-06-11; only the image smoke
      // gate caught it).
      if (this.registeredToolNames.includes(name)) {
        throw new Error(`Tool ${name} is already registered`);
      }
      this.registeredToolNames.push(name);
    }
    connect() {
      return Promise.resolve();
    }
  },
}));
jest.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

import {
  registerManagementTools,
  handleDeprovisionWorkspace,
  handleSetWorkspaceSecret,
  handleListWorkspaceSecrets,
  handleDeleteWorkspaceSecret,
  handleSetOrgSecret,
  handleListOrgSecrets,
  handleDeleteOrgSecret,
  handleSetWorkspaceBudget,
  handleSetLlmBillingMode,
  handleMintOrgToken,
  handleListOrgTokens,
  handleRevokeOrgToken,
  handleMintWorkspaceToken,
  handleGetOrgPluginAllowlist,
  handleSetOrgPluginAllowlist,
  handleListOrgs,
  handleGetOrg,
  isManagementMode,
  createServer,
} from "../index.js";
import {
  handleProvisionWorkspace as mgmtProvisionWorkspace,
  handleListWorkspaces as mgmtListWorkspaces,
  handleGetWorkspace,
  handleRestartWorkspace,
  handlePauseWorkspace,
  handleResumeWorkspace,
  handleExportBundle,
  handleListOrgEvents,
  handleCreateApproval as mgmtCreateApproval,
  handleGetConversationHistory,
} from "../tools/management/index.js";
import {
  handleRecreateWorkspace,
  handleMigrateWorkspaceProvider,
  handleGetWorkspaceMigrationStatus,
} from "../tools/management/cp_admin.js";

const ORG_KEY = "org_testkey_abcdef";
const ORG_ID = "org-11111111";
const HOST = "https://agents-team.moleculesai.app";

/** Mock fetch returning a JSON payload; records the last call args. */
function mockFetch(payload: unknown, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => null },
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  });
}

/** Parse the JSON blob a handler returns inside the MCP envelope. */
function parsed(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function lastCall(fetchMock: jest.Mock) {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers as Record<string, string>) || {};
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.MOLECULE_API_URL = HOST;
  process.env.MOLECULE_ORG_API_KEY = ORG_KEY;
  process.env.MOLECULE_ORG_ID = ORG_ID;
  delete process.env.MOLECULE_MCP_MODE;
  delete process.env.CP_ADMIN_API_TOKEN;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("management auth model", () => {
  it("sends Bearer Org API Key + X-Molecule-Org-Id to the tenant host", async () => {
    const f = mockFetch([{ id: "w1" }]);
    global.fetch = f as unknown as typeof fetch;
    await mgmtListWorkspaces();
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces`);
    expect(init.method).toBe("GET");
    const h = headersOf(init);
    expect(h.Authorization).toBe(`Bearer ${ORG_KEY}`);
    expect(h["X-Molecule-Org-Id"]).toBe(ORG_ID);
  });

  it("returns AUTH_ERROR (no fetch) when MOLECULE_ORG_API_KEY is absent", async () => {
    delete process.env.MOLECULE_ORG_API_KEY;
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleListWorkspaceSecrets({ workspace_id: "w1" }));
    expect(res.error).toBe("AUTH_ERROR");
    expect(f).not.toHaveBeenCalled();
  });

  it("returns AUTH_ERROR (no fetch) when org routing header is absent", async () => {
    delete process.env.MOLECULE_ORG_ID;
    delete process.env.MOLECULE_ORG_SLUG;
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleListWorkspaceSecrets({ workspace_id: "w1" }));
    expect(res.error).toBe("AUTH_ERROR");
    expect(f).not.toHaveBeenCalled();
  });

  it("maps a 401 to AUTH_ERROR", async () => {
    const f = mockFetch({ error: "unauthorized" }, false, 401);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleListWorkspaceSecrets({ workspace_id: "w1" }));
    expect(res.error).toBe("AUTH_ERROR");
    expect(res.status).toBe(401);
  });

  it("maps a 429 to RATE_LIMITED", async () => {
    const f = mockFetch({ error: "slow down" }, false, 429);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleListOrgTokens());
    expect(res.error).toBe("RATE_LIMITED");
  });
});

describe("workspace secret tools", () => {
  it("set_workspace_secret POSTs key+value to /workspaces/:id/secrets", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleSetWorkspaceSecret({ workspace_id: "w1", key: "ANTHROPIC_API_KEY", value: "sk-x" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1/secrets`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ key: "ANTHROPIC_API_KEY", value: "sk-x" });
  });

  it("create_approval POSTs an approval-kind request addressed to the user (mcp-server#61)", async () => {
    const f = mockFetch({ ok: true, id: "req-1" });
    global.fetch = f as unknown as typeof fetch;
    await mgmtCreateApproval({ workspace_id: "w1", action: "Test approval", reason: "demo" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1/requests`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "approval",
      recipient_type: "user",
      recipient_id: "",
      title: "Test approval",
      detail: "demo",
    });
  });

  it("list_workspace_secrets GETs /workspaces/:id/secrets", async () => {
    const f = mockFetch([{ key: "FOO" }]);
    global.fetch = f as unknown as typeof fetch;
    await handleListWorkspaceSecrets({ workspace_id: "w1" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1/secrets`);
    expect(init.method).toBe("GET");
  });

  it("delete_workspace_secret DELETEs and url-encodes the key", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleDeleteWorkspaceSecret({ workspace_id: "w1", key: "A/B KEY" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1/secrets/A%2FB%20KEY`);
    expect(init.method).toBe("DELETE");
  });

  it("rejects a missing required key with INVALID_ARGUMENTS (no fetch)", async () => {
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    await expect(handleSetWorkspaceSecret({ workspace_id: "w1", value: "x" })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("org secret tools", () => {
  it("set_org_secret POSTs to /settings/secrets", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleSetOrgSecret({ key: "GITHUB_TOKEN", value: "ghp_x" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/settings/secrets`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ key: "GITHUB_TOKEN", value: "ghp_x" });
  });

  it("list_org_secrets GETs /settings/secrets", async () => {
    const f = mockFetch([]);
    global.fetch = f as unknown as typeof fetch;
    await handleListOrgSecrets();
    expect(lastCall(f).url).toBe(`${HOST}/settings/secrets`);
  });

  it("delete_org_secret DELETEs /settings/secrets/:key", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleDeleteOrgSecret({ key: "GITHUB_TOKEN" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/settings/secrets/GITHUB_TOKEN`);
    expect(init.method).toBe("DELETE");
  });
});

describe("workspace lifecycle tools", () => {
  it("provision_workspace POSTs to /workspaces with the supplied fields", async () => {
    const f = mockFetch({ id: "w-new" });
    global.fetch = f as unknown as typeof fetch;
    await mgmtProvisionWorkspace({ name: "Researcher", runtime: "claude-code", tier: 2 });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("Researcher");
    expect(body.runtime).toBe("claude-code");
    expect(body.tier).toBe(2);
  });

  it("deprovision_workspace DELETEs /workspaces/:id", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleDeprovisionWorkspace({ workspace_id: "w1" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1`);
    expect(init.method).toBe("DELETE");
  });

  it("deprovision_workspace sends X-Confirm-Name when confirm_name is provided", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleDeprovisionWorkspace({ workspace_id: "w1", confirm_name: "Test-PM" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1`);
    expect(init.method).toBe("DELETE");
    expect(headersOf(init)["X-Confirm-Name"]).toBe("Test-PM");
  });
});

describe("budget + billing tools", () => {
  it("set_workspace_budget PATCHes budget_limits to /workspaces/:id/budget", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleSetWorkspaceBudget({ workspace_id: "w1", budget_limits: { monthly: 50000 } });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1/budget`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ budget_limits: { monthly: 50000 } });
  });

  it("set_workspace_budget rejects an unknown period (no fetch)", async () => {
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    await expect(
      handleSetWorkspaceBudget({ workspace_id: "w1", budget_limits: { yearly: 1 } as never }),
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it("set_workspace_budget rejects when neither field is given (no fetch)", async () => {
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    await expect(handleSetWorkspaceBudget({ workspace_id: "w1" })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it("set_llm_billing_mode PUTs {mode} to the billing-mode route", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleSetLlmBillingMode({ workspace_id: "w1", mode: "byok" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/admin/workspaces/w1/llm-billing-mode`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ mode: "byok" });
  });

  it("set_llm_billing_mode passes mode:null through to clear the override", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleSetLlmBillingMode({ workspace_id: "w1", mode: null });
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({ mode: null });
  });

  it("set_llm_billing_mode rejects an invalid mode (no fetch)", async () => {
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    await expect(
      handleSetLlmBillingMode({ workspace_id: "w1", mode: "free" as never }),
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("token tools", () => {
  it("mint_org_token POSTs {name} to /org/tokens", async () => {
    const f = mockFetch({ auth_token: "org_xyz", id: "t1" });
    global.fetch = f as unknown as typeof fetch;
    await handleMintOrgToken({ name: "ci-bot" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/org/tokens`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "ci-bot" });
  });

  it("list_org_tokens GETs /org/tokens", async () => {
    const f = mockFetch([]);
    global.fetch = f as unknown as typeof fetch;
    await handleListOrgTokens();
    expect(lastCall(f).url).toBe(`${HOST}/org/tokens`);
  });

  it("revoke_org_token DELETEs /org/tokens/:id (url-encoded)", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleRevokeOrgToken({ id: "abc/def" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/org/tokens/abc%2Fdef`);
    expect(init.method).toBe("DELETE");
  });

  it("mint_workspace_token POSTs to /admin/workspaces/:id/tokens", async () => {
    const f = mockFetch({ auth_token: "ws_xyz" });
    global.fetch = f as unknown as typeof fetch;
    await handleMintWorkspaceToken({ workspace_id: "w1" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/admin/workspaces/w1/tokens`);
    expect(init.method).toBe("POST");
  });

  it("mint_org_token rejects an over-long name (no fetch)", async () => {
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    await expect(handleMintOrgToken({ name: "x".repeat(101) })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("plugin allowlist tools", () => {
  it("get_org_plugin_allowlist GETs /orgs/:id/plugins/allowlist (default org id)", async () => {
    const f = mockFetch({ plugins: [] });
    global.fetch = f as unknown as typeof fetch;
    await handleGetOrgPluginAllowlist({});
    expect(lastCall(f).url).toBe(`${HOST}/orgs/${ORG_ID}/plugins/allowlist`);
  });

  it("set_org_plugin_allowlist PUTs the plugins array", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleSetOrgPluginAllowlist({ plugins: ["a", "b"], enabled_by: "w1" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/orgs/${ORG_ID}/plugins/allowlist`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ plugins: ["a", "b"], enabled_by: "w1" });
  });

  it("set_org_plugin_allowlist rejects a missing enabled_by (no fetch)", async () => {
    // The tenant PutAllowlist handler hard-requires enabled_by (400
    // "enabled_by is required"); the schema must reject it client-side.
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    await expect(handleSetOrgPluginAllowlist({ plugins: ["a", "b"] })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it("get_org_plugin_allowlist surfaces INVALID_ARGUMENTS when no org id resolvable (no fetch)", async () => {
    delete process.env.MOLECULE_ORG_ID;
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetOrgPluginAllowlist({}));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("CP-tier tools (separated, gated)", () => {
  it("list_orgs returns CP_TIER_NOT_CONFIGURED and makes no call when CP token absent", async () => {
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleListOrgs());
    expect(res.error).toBe("CP_TIER_NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("get_org hits the CP base URL with the admin bearer when configured", async () => {
    process.env.CP_ADMIN_API_TOKEN = "cp_admin_token";
    process.env.MOLECULE_CP_URL = "https://api.moleculesai.app";
    const f = mockFetch({ slug: "agents-team" });
    global.fetch = f as unknown as typeof fetch;
    await handleGetOrg({ slug: "agents-team" });
    const { url, init } = lastCall(f);
    expect(url).toBe("https://api.moleculesai.app/api/v1/orgs/agents-team");
    expect(headersOf(init).Authorization).toBe("Bearer cp_admin_token");
  });
});

describe("recreate_workspace (CP-tier hard redeploy)", () => {
  const CP = "https://api.moleculesai.app";

  beforeEach(() => {
    process.env.CP_ADMIN_API_TOKEN = "cp_admin_token";
    process.env.MOLECULE_CP_URL = CP;
    process.env.MOLECULE_ORG_SLUG = "agents-team";
  });

  it("returns CP_TIER_NOT_CONFIGURED and makes no call when CP token absent", async () => {
    delete process.env.CP_ADMIN_API_TOKEN;
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({ runtime: "claude-code" }));
    expect(res.error).toBe("CP_TIER_NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("POSTs runtime+recreate to the slug-keyed redeploy endpoint with the admin bearer", async () => {
    const f = mockFetch({ ok: true, result: { recreated: ["ws-1"] } });
    global.fetch = f as unknown as typeof fetch;
    await handleRecreateWorkspace({ runtime: "claude-code", recreate: true });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${CP}/api/v1/admin/tenants/agents-team/workspaces/redeploy`);
    expect(init.method).toBe("POST");
    expect(headersOf(init).Authorization).toBe("Bearer cp_admin_token");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.runtime).toBe("claude-code");
    expect(sentBody.recreate).toBe(true);
    expect(sentBody.dry_run).toBe(false);
    // actor is always present for the audit trail (falls back to the tenant
    // identity when not passed explicitly).
    expect(sentBody.actor).toBeDefined();
  });

  it("defaults recreate to true and dry_run to false", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleRecreateWorkspace({ runtime: "codex" });
    const body = JSON.parse(lastCall(f).init.body as string);
    expect(body.recreate).toBe(true);
    expect(body.dry_run).toBe(false);
  });

  it("honors an explicit slug arg over MOLECULE_ORG_SLUG and url-encodes it", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleRecreateWorkspace({ runtime: "codex", slug: "other/team" });
    expect(lastCall(f).url).toBe(`${CP}/api/v1/admin/tenants/other%2Fteam/workspaces/redeploy`);
  });

  it("derives the runtime from workspace_id via the tenant API when runtime omitted", async () => {
    // First fetch = tenant GET /workspaces/:id (org-key host), second =
    // the CP redeploy POST. mockFetch returns the same payload for both,
    // so make it the workspace row carrying a runtime.
    const f = mockFetch({ id: "w1", runtime: "hermes", ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleRecreateWorkspace({ workspace_id: "w1" });
    // The LAST call is the CP redeploy; assert it carried the resolved runtime.
    const { url, init } = lastCall(f);
    expect(url).toBe(`${CP}/api/v1/admin/tenants/agents-team/workspaces/redeploy`);
    expect(JSON.parse(init.body as string).runtime).toBe("hermes");
  });

  it("FAILS CLOSED: aborts (recreates NOTHING) when workspace_id is given but its runtime can't be resolved and no explicit runtime", async () => {
    // Lookup returns a workspace row with NO runtime field → unresolvable.
    // The tool must NOT fall back to a tenant-wide all-runtimes recreate.
    const f = mockFetch({ id: "w1", ok: true }); // no runtime field
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({ workspace_id: "w1" }));
    expect(res.error).toBe("RUNTIME_UNRESOLVED");
    expect(res.detail).toMatch(/refusing to fall back to a tenant-wide/i);
    // Exactly ONE fetch happened — the tenant lookup. The CP redeploy POST
    // was NEVER issued (nothing was recreated).
    expect(f).toHaveBeenCalledTimes(1);
    const onlyCallUrl = f.mock.calls[0][0] as string;
    expect(onlyCallUrl).not.toMatch(/\/redeploy$/);
  });

  it("FAILS CLOSED: aborts an unscoped recreate (no runtime, no workspace_id, no all_runtimes)", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({}));
    expect(res.error).toBe("SCOPE_REQUIRED");
    expect(f).not.toHaveBeenCalled();
  });

  it("allows an EXPLICIT tenant-wide recreate via all_runtimes:true (runtime:'')", async () => {
    const f = mockFetch({ ok: true, result: { recreated: [] } });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({ all_runtimes: true }));
    const { url, init } = lastCall(f);
    expect(url).toBe(`${CP}/api/v1/admin/tenants/agents-team/workspaces/redeploy`);
    expect(JSON.parse(init.body as string).runtime).toBe("");
    expect(res.ok).toBe(true);
    expect(res.runtime_source).toBe("all_runtimes");
  });

  it("AUDIT: forwards actor + reason in the redeploy body and echoes them in the result", async () => {
    const f = mockFetch({ ok: true, result: {} });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(
      await handleRecreateWorkspace({
        runtime: "claude-code",
        actor: "devops-engineer",
        reason: "onto promoted pin per cp#245",
      }),
    );
    const body = JSON.parse(lastCall(f).init.body as string);
    expect(body.actor).toBe("devops-engineer");
    expect(body.reason).toBe("onto promoted pin per cp#245");
    // The result also surfaces the audit fields for attribution.
    expect(res.actor).toBe("devops-engineer");
    expect(res.reason).toBe("onto promoted pin per cp#245");
  });

  it("AUDIT: actor is never anonymous — falls back to MOLECULE_AUDIT_ACTOR when not passed", async () => {
    process.env.MOLECULE_AUDIT_ACTOR = "cr2-fleet-bot";
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleRecreateWorkspace({ runtime: "codex" });
    expect(JSON.parse(lastCall(f).init.body as string).actor).toBe("cr2-fleet-bot");
  });

  it("FAILS CLOSED: aborts when actor is unresolvable (no actor arg, no MOLECULE_AUDIT_ACTOR, no MOLECULE_ORG_SLUG)", async () => {
    delete process.env.MOLECULE_ORG_SLUG;
    delete process.env.MOLECULE_AUDIT_ACTOR;
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({ runtime: "codex", slug: "some-org" }));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(res.detail).toMatch(/audit actor is required/i);
    // No CP call made — the op is aborted before reaching the redeploy endpoint.
    expect(f).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED: aborts when actor is explicitly 'unknown' (mcp-server#48)", async () => {
    delete process.env.MOLECULE_ORG_SLUG;
    delete process.env.MOLECULE_AUDIT_ACTOR;
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({ runtime: "codex", slug: "some-org", actor: "unknown" }));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(res.detail).toMatch(/audit actor is required/i);
    expect(f).not.toHaveBeenCalled();
  });

  it("returns INVALID_ARGUMENTS (no CP call) when no slug is resolvable", async () => {
    delete process.env.MOLECULE_ORG_SLUG;
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({ runtime: "codex" }));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(f).not.toHaveBeenCalled();
  });

  it("surfaces REDEPLOY_FAILED on an upstream CP error", async () => {
    const f = mockFetch({ error: "tenant not found" }, false, 404);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleRecreateWorkspace({ runtime: "codex", slug: "ghost" }));
    expect(res.error).toBe("REDEPLOY_FAILED");
  });
});

describe("migrate_workspace_provider (CP-tier cross-cloud migration)", () => {
  const CP = "https://api.moleculesai.app";

  beforeEach(() => {
    process.env.CP_ADMIN_API_TOKEN = "cp_admin_token";
    process.env.MOLECULE_CP_URL = CP;
  });

  it("returns CP_TIER_NOT_CONFIGURED and makes no call when CP token absent", async () => {
    delete process.env.CP_ADMIN_API_TOKEN;
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "hetzner", from: "aws", confirm: true }));
    expect(res.error).toBe("CP_TIER_NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("POSTs {from,to,confirm:true} to the admin migrate-provider endpoint with the admin bearer", async () => {
    const f = mockFetch({ status: "migration_started", workspace_id: "w1", from: "aws", to: "hetzner" });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "hetzner", from: "aws", confirm: true }));
    const { url, init } = lastCall(f);
    expect(url).toBe(`${CP}/api/v1/admin/workspaces/w1/migrate-provider`);
    expect(init.method).toBe("POST");
    expect(headersOf(init).Authorization).toBe("Bearer cp_admin_token");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ from: "aws", to: "hetzner", confirm: true });
    expect(res.ok).toBe(true);
    expect(res.from_source).toBe("explicit");
    expect(res.result.status).toBe("migration_started");
  });

  it("REFUSES without confirm:true — no CP call (defaults confirm to false)", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "hetzner", from: "aws" }));
    expect(res.error).toBe("CONFIRMATION_REQUIRED");
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects from === to at the schema layer (no fetch)", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await expect(
      handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "aws", from: "aws", confirm: true }),
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects an invalid provider enum (no fetch)", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await expect(
      handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "azure" as never, from: "aws", confirm: true }),
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it("requires from_instance_id for a non-AWS source (no CP call)", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "aws", from: "hetzner", confirm: true }));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(res.detail).toMatch(/from_instance_id is required/i);
    expect(f).not.toHaveBeenCalled();
  });

  it("forwards from_instance_id for a non-AWS source", async () => {
    const f = mockFetch({ status: "migration_started" });
    global.fetch = f as unknown as typeof fetch;
    await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "aws", from: "gcp", from_instance_id: "gcp-box-9", confirm: true });
    const body = JSON.parse(lastCall(f).init.body as string);
    expect(body).toEqual({ from: "gcp", to: "aws", confirm: true, from_instance_id: "gcp-box-9" });
  });

  it("auto-resolves `from` from the workspace's current provider when omitted", async () => {
    // First fetch = tenant GET /workspaces/:id (carries provider); second = CP POST.
    // mockFetch returns the same payload for both, so include a `provider` field.
    const f = mockFetch({ id: "w1", provider: "aws", status: "migration_started" });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "hetzner", confirm: true }));
    // First call = tenant lookup on the org-key host; last = CP migrate POST.
    expect(f.mock.calls[0][0]).toContain("/workspaces/w1");
    const { url, init } = lastCall(f);
    expect(url).toBe(`${CP}/api/v1/admin/workspaces/w1/migrate-provider`);
    expect(JSON.parse(init.body as string)).toEqual({ from: "aws", to: "hetzner", confirm: true });
    expect(res.from_source).toBe("workspace_lookup");
  });

  it("FROM_UNRESOLVED when `from` omitted and the workspace reports no provider", async () => {
    const f = mockFetch({ id: "w1" }); // no provider field
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "hetzner", confirm: true }));
    expect(res.error).toBe("FROM_UNRESOLVED");
    // Only the tenant lookup happened — the CP migrate POST was never issued.
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).not.toMatch(/migrate-provider/);
  });

  it("INVALID_ARGUMENTS when an auto-resolved `from` equals `to`", async () => {
    const f = mockFetch({ id: "w1", provider: "hetzner" });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "hetzner", confirm: true }));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(res.detail).toMatch(/same provider/i);
    expect(f).toHaveBeenCalledTimes(1); // lookup only, no migrate POST
  });

  it("surfaces MIGRATION_START_FAILED on an upstream CP error", async () => {
    const f = mockFetch({ error: "migrator not configured" }, false, 503);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleMigrateWorkspaceProvider({ workspace_id: "w1", to: "hetzner", from: "aws", confirm: true }));
    expect(res.error).toBe("MIGRATION_START_FAILED");
  });

  it("url-encodes the workspace id in the path", async () => {
    const f = mockFetch({ status: "migration_started" });
    global.fetch = f as unknown as typeof fetch;
    await handleMigrateWorkspaceProvider({ workspace_id: "w/1", to: "hetzner", from: "aws", confirm: true });
    expect(lastCall(f).url).toBe(`${CP}/api/v1/admin/workspaces/w%2F1/migrate-provider`);
  });
});

describe("get_workspace_migration_status (CP-tier read)", () => {
  const CP = "https://api.moleculesai.app";

  beforeEach(() => {
    process.env.CP_ADMIN_API_TOKEN = "cp_admin_token";
    process.env.MOLECULE_CP_URL = CP;
  });

  it("returns CP_TIER_NOT_CONFIGURED and makes no call when CP token absent", async () => {
    delete process.env.CP_ADMIN_API_TOKEN;
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetWorkspaceMigrationStatus({ workspace_id: "w1" }));
    expect(res.error).toBe("CP_TIER_NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("GETs the migrate-provider endpoint and returns the migration record", async () => {
    const f = mockFetch({ migration: { state: "provisioning_target", from_provider: "aws", to_provider: "hetzner" }, terminal: false });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetWorkspaceMigrationStatus({ workspace_id: "w1" }));
    const { url, init } = lastCall(f);
    expect(url).toBe(`${CP}/api/v1/admin/workspaces/w1/migrate-provider`);
    expect(init.method).toBe("GET");
    expect(headersOf(init).Authorization).toBe("Bearer cp_admin_token");
    expect(res.ok).toBe(true);
    expect(res.migration.state).toBe("provisioning_target");
    expect(res.terminal).toBe(false);
  });

  it("maps a 404 to a clean NOT_FOUND (never migrated)", async () => {
    const f = mockFetch({ error: "no migration found" }, false, 404);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetWorkspaceMigrationStatus({ workspace_id: "w1" }));
    expect(res.error).toBe("NOT_FOUND");
  });

  it("surfaces MIGRATION_STATUS_FAILED on a non-404 CP error", async () => {
    const f = mockFetch({ error: "boom" }, false, 500);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetWorkspaceMigrationStatus({ workspace_id: "w1" }));
    expect(res.error).toBe("MIGRATION_STATUS_FAILED");
  });

  it("url-encodes the workspace id", async () => {
    const f = mockFetch({ migration: {}, terminal: true });
    global.fetch = f as unknown as typeof fetch;
    await handleGetWorkspaceMigrationStatus({ workspace_id: "w/1" });
    expect(lastCall(f).url).toBe(`${CP}/api/v1/admin/workspaces/w%2F1/migrate-provider`);
  });
});

describe("registration + mode", () => {
  it("isManagementMode reflects MOLECULE_MCP_MODE=management", () => {
    process.env.MOLECULE_MCP_MODE = "management";
    expect(isManagementMode()).toBe(true);
    process.env.MOLECULE_MCP_MODE = "";
    expect(isManagementMode()).toBe(false);
  });

  it("registerManagementTools registers the full §5(a) toolset including CP-tier", () => {
    const srv = { registeredToolNames: [] as string[], tool(n: string) { this.registeredToolNames.push(n); } };
    registerManagementTools(srv as never);
    const names = srv.registeredToolNames;
    for (const expected of [
      "list_orgs", "get_org", "recreate_workspace",
      "migrate_workspace_provider", "get_workspace_migration_status",
      "list_workspaces", "get_workspace", "provision_workspace", "deprovision_workspace",
      "restart_workspace", "pause_workspace", "resume_workspace",
      "set_workspace_secret", "list_workspace_secrets", "delete_workspace_secret",
      "set_org_secret", "list_org_secrets", "delete_org_secret",
      "set_workspace_budget", "set_llm_billing_mode",
      "list_org_templates", "create_org_from_template", "list_templates", "import_template",
      "mint_org_token", "list_org_tokens", "revoke_org_token", "mint_workspace_token",
      "get_org_plugin_allowlist", "set_org_plugin_allowlist",
      "export_bundle", "import_bundle",
      "list_org_events", "list_pending_approvals", "create_approval",
      "get_conversation_history",
    ]) {
      expect(names).toContain(expected);
    }
    // No duplicate registrations.
    expect(new Set(names).size).toBe(names.length);
  });

  it("createServer in management mode registers only the management surface", () => {
    process.env.MOLECULE_MCP_MODE = "management";
    // The mock McpServer throws on duplicate names (like the real SDK), so
    // simply composing the full management-mode server here is the
    // regression gate against cross-registry tool-name collisions.
    const srv = createServer() as unknown as { registeredToolNames: string[] };
    expect(srv.registeredToolNames).toContain("provision_workspace");
    // The unified request tools come from requests.ts (BOTH modes) — the
    // management registry must NOT duplicate them.
    expect(srv.registeredToolNames).toContain("create_request");
    expect(srv.registeredToolNames).toContain("create_approval");
    // Legacy-only tools (chat_with_agent) must NOT be present in mgmt mode.
    expect(srv.registeredToolNames).not.toContain("chat_with_agent");
  });

  it("createServer in workspace mode composes without tool-name collisions", () => {
    process.env.MOLECULE_MCP_MODE = "";
    expect(() => createServer()).not.toThrow();
  });
});

describe("get_conversation_history (on-demand paginated history)", () => {
  const HISTORY_BODY = {
    messages: [
      { id: "m1", role: "user", content: "first", timestamp: "2026-05-01T00:00:00Z" },
      { id: "m2", role: "agent", content: "reply", timestamp: "2026-05-01T00:00:05Z" },
    ],
    reached_end: false,
  };

  it("GETs /workspaces/:id/chat-history with the Org API Key auth headers", async () => {
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    await handleGetConversationHistory({ workspace_id: "w1" });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${HOST}/workspaces/w1/chat-history?limit=50`);
    expect(init.method).toBe("GET");
    const h = headersOf(init);
    expect(h.Authorization).toBe(`Bearer ${ORG_KEY}`);
    expect(h["X-Molecule-Org-Id"]).toBe(ORG_ID);
  });

  it("defaults limit to 50 and clamps an over-max limit to 200", async () => {
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    await handleGetConversationHistory({ workspace_id: "w1", limit: 9999 });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w1/chat-history?limit=200`);
  });

  it("passes before_cursor through as the before_ts query param", async () => {
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    await handleGetConversationHistory({
      workspace_id: "w1",
      limit: 10,
      before_cursor: "2026-05-01T00:00:00Z",
    });
    expect(lastCall(f).url).toBe(
      `${HOST}/workspaces/w1/chat-history?limit=10&before_ts=2026-05-01T00%3A00%3A00Z`,
    );
  });

  it("returns a next_before_cursor (oldest ts) when more history remains", async () => {
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetConversationHistory({ workspace_id: "w1" }));
    expect(res.count).toBe(2);
    expect(res.reached_end).toBe(false);
    // messages are oldest-first; the cursor to page further back is the oldest.
    expect(res.next_before_cursor).toBe("2026-05-01T00:00:00Z");
  });

  it("omits next_before_cursor at end-of-history (reached_end)", async () => {
    const f = mockFetch({ messages: HISTORY_BODY.messages, reached_end: true });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetConversationHistory({ workspace_id: "w1" }));
    expect(res.reached_end).toBe(true);
    expect(res.next_before_cursor).toBeUndefined();
  });

  it("defaults workspace_id to MOLECULE_WORKSPACE_ID when omitted", async () => {
    process.env.MOLECULE_WORKSPACE_ID = "own-ws";
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    await handleGetConversationHistory({});
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/own-ws/chat-history?limit=50`);
  });

  it("fails closed (no fetch) with INVALID_ARGUMENTS when no workspace can be resolved", async () => {
    delete process.env.MOLECULE_WORKSPACE_ID;
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetConversationHistory({}));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(f).not.toHaveBeenCalled();
  });

  it("returns AUTH_ERROR (no fetch) when the Org API Key is absent", async () => {
    delete process.env.MOLECULE_ORG_API_KEY;
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetConversationHistory({ workspace_id: "w1" }));
    expect(res.error).toBe("AUTH_ERROR");
    expect(f).not.toHaveBeenCalled();
  });

  it("surfaces an upstream HTTP error unchanged (no cursor synthesis)", async () => {
    const f = mockFetch({ error: "boom" }, false, 502);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleGetConversationHistory({ workspace_id: "w1" }));
    expect(res.error).toBe("HTTP 502");
    expect(res.next_before_cursor).toBeUndefined();
  });

  it("escapes workspace_id in the chat-history path", async () => {
    const f = mockFetch(HISTORY_BODY);
    global.fetch = f as unknown as typeof fetch;
    await handleGetConversationHistory({ workspace_id: "w/1" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2F1/chat-history?limit=50`);
  });
});

describe("path segment escaping", () => {
  it("escapes workspace_id in get_workspace", async () => {
    const f = mockFetch({ id: "w1" });
    global.fetch = f as unknown as typeof fetch;
    await mgmtListWorkspaces(); // warm-up not needed; call directly
    await handleSetWorkspaceSecret({ workspace_id: "a/b", key: "K", value: "V" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/a%2Fb/secrets`);
  });

  it("escapes workspace_id across lifecycle verbs", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;

    await handleGetWorkspace({ workspace_id: "w/x" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fx`);

    await handleDeprovisionWorkspace({ workspace_id: "w/x" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fx`);

    await handleRestartWorkspace({ workspace_id: "w/x" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fx/restart`);

    await handlePauseWorkspace({ workspace_id: "w/x" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fx/pause?cascade=true`);

    await handleResumeWorkspace({ workspace_id: "w/x" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fx/resume?cascade=true`);
  });

  it("escapes workspace_id in secrets, budget, billing-mode, and token mint", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;

    await handleListWorkspaceSecrets({ workspace_id: "w/y" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fy/secrets`);

    await handleDeleteWorkspaceSecret({ workspace_id: "w/y", key: "K" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fy/secrets/K`);

    await handleSetWorkspaceBudget({ workspace_id: "w/y", budget_limits: { monthly: 1 } });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fy/budget`);

    await handleSetLlmBillingMode({ workspace_id: "w/y", mode: "disabled" });
    expect(lastCall(f).url).toBe(`${HOST}/admin/workspaces/w%2Fy/llm-billing-mode`);

    await handleMintWorkspaceToken({ workspace_id: "w/y" });
    expect(lastCall(f).url).toBe(`${HOST}/admin/workspaces/w%2Fy/tokens`);
  });

  it("escapes workspace_id in bundle export and events filter", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;

    await handleExportBundle({ workspace_id: "w/z" });
    expect(lastCall(f).url).toBe(`${HOST}/bundles/export/w%2Fz`);

    await handleListOrgEvents({ workspace_id: "w/z" });
    expect(lastCall(f).url).toBe(`${HOST}/events/w%2Fz`);
  });

  it("does NOT double-encode already-safe ids", async () => {
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    await handleGetWorkspace({ workspace_id: "w1" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w1`);
  });
});
