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
} from "../tools/management/index.js";

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
      "list_orgs", "get_org",
      "list_workspaces", "get_workspace", "provision_workspace", "deprovision_workspace",
      "restart_workspace", "pause_workspace", "resume_workspace",
      "set_workspace_secret", "list_workspace_secrets", "delete_workspace_secret",
      "set_org_secret", "list_org_secrets", "delete_org_secret",
      "set_workspace_budget", "set_llm_billing_mode",
      "list_org_templates", "create_org_from_template", "list_templates", "import_template",
      "mint_org_token", "list_org_tokens", "revoke_org_token", "mint_workspace_token",
      "get_org_plugin_allowlist", "set_org_plugin_allowlist",
      "export_bundle", "import_bundle",
      "list_org_events", "list_pending_approvals",
    ]) {
      expect(names).toContain(expected);
    }
    // No duplicate registrations.
    expect(new Set(names).size).toBe(names.length);
  });

  it("createServer in management mode registers only the management surface", () => {
    process.env.MOLECULE_MCP_MODE = "management";
    const srv = createServer() as unknown as { registeredToolNames: string[] };
    expect(srv.registeredToolNames).toContain("provision_workspace");
    // Legacy-only tools (chat_with_agent) must NOT be present in mgmt mode.
    expect(srv.registeredToolNames).not.toContain("chat_with_agent");
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
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fx/pause`);

    await handleResumeWorkspace({ workspace_id: "w/x" });
    expect(lastCall(f).url).toBe(`${HOST}/workspaces/w%2Fx/resume`);
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
