/**
 * Self-mode (audience=self) unit tests — the SECURITY crux of self-schedule v1.
 *
 * Self mode = a workspace acting on ITSELF, authenticated with its OWN
 * per-workspace token (read per-call from /configs/.auth_token). The three
 * negative controls below each FAIL if their guard is removed/inverted:
 *
 *   (a) a FOREIGN workspace_id can never be reached — the request carries only
 *       the self-bound workspace token (core WorkspaceAuth 401s a foreign :id);
 *       an omitted id self-resolves to the caller's OWN id, never another.
 *   (b) with MOLECULE_API_KEY (the org-admin key) present in env, self mode uses
 *       the token-FILE bearer — NEVER the env org key.
 *   (c) self mode registers EXACTLY the 6 schedule tools — ZERO management-tier
 *       (or any other workspace-ops) tools.
 *
 * The MCP SDK + fetch are mocked (no real server / network). The workspace
 * token is a REAL temp file so the per-call fs read path is exercised for real.
 */

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    name: string;
    registeredToolNames: string[] = [];
    constructor(args: { name: string }) {
      this.name = args.name;
    }
    tool(name: string) {
      // Mirror the real SDK: duplicate tool names throw at registration.
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

import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  isSelfMode,
  PLATFORM_URL,
  handleListSchedules,
  handleCreateSchedule,
  handleDeleteSchedule,
  handleRunSchedule,
} from "../index.js";
import { authHeaders } from "../api.js";

const WS_TOKEN = "wsk_self_token_abc123"; // the per-workspace token (self)
const ORG_KEY = "org_admin_key_MUST_NOT_LEAK"; // org-admin key on a concierge box
const OWN_WS = "ws-self-own-1111";
const FOREIGN_WS = "ws-someone-else-9999";
const ORG_ID = "org-routing-uuid-7777"; // tenant ROUTING id (X-Molecule-Org-Id), not a credential

/** Mock fetch returning a JSON payload; records the last call args. */
function mockFetch(payload: unknown, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => null },
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  });
}

function lastCall(f: jest.Mock) {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers as Record<string, string>) || {};
}

function parsed(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

const ORIGINAL_ENV = { ...process.env };
let tmpDir: string;
let tokenFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-self-"));
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.MOLECULE_MCP_MODE = "self";
  // The caller's own workspace id resolves via the UNIVERSAL WORKSPACE_ID env.
  process.env.WORKSPACE_ID = OWN_WS;
  delete process.env.MOLECULE_WORKSPACE_ID;
  // Deliberately place the ORG-ADMIN key in env — self mode must NEVER use it.
  process.env.MOLECULE_API_KEY = ORG_KEY;
  delete process.env.MOLECULE_API_TOKEN;
  // The tenant ROUTING id the SaaS gateway requires (X-Molecule-Org-Id). Present
  // in self mode too — it selects the tenant, it is NOT a credential.
  process.env.MOLECULE_ORG_ID = ORG_ID;
  delete process.env.MOLECULE_ORGANIZATION_ID;
  delete process.env.MOLECULE_ORG;
  // Fresh on-disk token file per test; padded to prove the reader trims it.
  tokenFile = join(tmpDir, `auth_token_${Math.random().toString(36).slice(2)}`);
  writeFileSync(tokenFile, `  ${WS_TOKEN}\n`);
  process.env.MOLECULE_WORKSPACE_TOKEN_FILE = tokenFile;
});

describe("self mode detection", () => {
  it("isSelfMode() reflects MOLECULE_MCP_MODE=self (case-insensitive)", () => {
    expect(isSelfMode()).toBe(true);
    process.env.MOLECULE_MCP_MODE = "SELF";
    expect(isSelfMode()).toBe(true);
    process.env.MOLECULE_MCP_MODE = "management";
    expect(isSelfMode()).toBe(false);
    delete process.env.MOLECULE_MCP_MODE;
    expect(isSelfMode()).toBe(false);
  });
});

// ===========================================================================
// (a) FOREIGN workspace_id rejected; omitted → OWN id (never a foreign one)
// ===========================================================================
describe("(a) self-scoped: foreign workspace_id can't be reached", () => {
  it("omitting workspace_id self-resolves to the caller's OWN id", async () => {
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    await handleListSchedules({});
    // GUARD: `params.workspace_id || selfWorkspaceId()`. Remove the fallback and
    // this fails closed (no fetch) → lastCall throws / url mismatches.
    expect(lastCall(f).url).toBe(`${PLATFORM_URL}/workspaces/${OWN_WS}/schedules`);
  });

  it("a create with a FOREIGN workspace_id carries ONLY the self workspace token (core 401s; no org-key escalation)", async () => {
    // core's WorkspaceAuth binds the workspace token to its OWN id, so a foreign
    // :id 401s. Simulate that rejection and assert the request that reached core
    // was authed with the WORKSPACE TOKEN — not the org key sitting in env. If
    // the self-mode bearer path were removed, the org key would be sent and the
    // cross-workspace write would SUCCEED (breach).
    const f = mockFetch({ error: "forbidden" }, false, 401);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(
      await handleCreateSchedule({
        workspace_id: FOREIGN_WS,
        name: "x",
        cron_expr: "0 9 * * 1-5",
        prompt: "hi",
      }),
    );
    const { url, init } = lastCall(f);
    expect(url).toBe(`${PLATFORM_URL}/workspaces/${FOREIGN_WS}/schedules`);
    expect(headersOf(init).Authorization).toBe(`Bearer ${WS_TOKEN}`);
    expect(headersOf(init).Authorization).not.toBe(`Bearer ${ORG_KEY}`);
    // The tenant ROUTING header IS present (the SaaS API requires it) — but it is
    // NOT a privilege: the bearer is the per-workspace token, so core WorkspaceAuth
    // still 401s the foreign :id below. Routing selects the tenant; the token gates
    // the workspace.
    expect(headersOf(init)["X-Molecule-Org-Id"]).toBe(ORG_ID);
    // core rejected it — surfaced as an error, not a successful write.
    expect(res.error).toBe("HTTP 401");
  });
});

// ===========================================================================
// (b) org key present in env → self mode uses the token FILE, never the org key
// ===========================================================================
describe("(b) never uses MOLECULE_API_KEY as the self bearer", () => {
  it("authHeaders() returns the token-file bearer + org ROUTING id, never the org key", () => {
    const h = authHeaders();
    expect(h.Authorization).toBe(`Bearer ${WS_TOKEN}`);
    expect(h.Authorization).not.toBe(`Bearer ${ORG_KEY}`);
    // The tenant ROUTING header is present (SaaS requires it); it is the org UUID,
    // never a credential.
    expect(h["X-Molecule-Org-Id"]).toBe(ORG_ID);
    // Belt-and-suspenders: the org KEY must not appear anywhere in the headers.
    expect(JSON.stringify(h)).not.toContain(ORG_KEY);
  });

  it("self mode omits X-Molecule-Org-Id when no org id is configured (never falls back to the key)", () => {
    delete process.env.MOLECULE_ORG_ID;
    const h = authHeaders();
    expect(h.Authorization).toBe(`Bearer ${WS_TOKEN}`);
    expect(h["X-Molecule-Org-Id"]).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain(ORG_KEY);
  });

  it("end-to-end: a real tool call sends the token-file bearer over the wire", async () => {
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    await handleListSchedules({});
    expect(headersOf(lastCall(f).init).Authorization).toBe(`Bearer ${WS_TOKEN}`);
  });

  it("re-reads the token file on EVERY call so a rotation is picked up without restart", async () => {
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    await handleListSchedules({});
    expect(headersOf(lastCall(f).init).Authorization).toBe(`Bearer ${WS_TOKEN}`);
    // Rotate the on-disk token (what a workspace restart does).
    writeFileSync(tokenFile, "wsk_rotated_v2\n");
    await handleListSchedules({});
    expect(headersOf(lastCall(f).init).Authorization).toBe("Bearer wsk_rotated_v2");
  });

  it("does NOT change non-self behavior: with mode unset, authHeaders uses MOLECULE_API_KEY (+ org routing id)", () => {
    delete process.env.MOLECULE_MCP_MODE;
    delete process.env.MOLECULE_WORKSPACE_TOKEN_FILE;
    // Management mode: org KEY bearer + the org routing id (unchanged behavior).
    expect(authHeaders()).toEqual({
      Authorization: `Bearer ${ORG_KEY}`,
      "X-Molecule-Org-Id": ORG_ID,
    });
  });
});

// ===========================================================================
// Fail-closed: missing/empty token file → NO Authorization header (401), never
// a fall-through to the org key. This is the single most important invariant.
// ===========================================================================
describe("fail-closed auth path", () => {
  it("missing token file → NO Authorization header, and NOT the org key", async () => {
    process.env.MOLECULE_WORKSPACE_TOKEN_FILE = join(tmpDir, "does-not-exist");
    const h = authHeaders();
    expect(h.Authorization).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain(ORG_KEY);

    const f = mockFetch({ error: "unauthorized" }, false, 401);
    global.fetch = f as unknown as typeof fetch;
    await handleListSchedules({});
    expect(headersOf(lastCall(f).init)).not.toHaveProperty("Authorization");
  });

  it("empty / whitespace-only token file → NO Authorization header (fail closed)", () => {
    writeFileSync(tokenFile, "   \n");
    const h = authHeaders();
    expect(h.Authorization).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain(ORG_KEY);
  });

  it("fails closed with INVALID_ARGUMENTS (no fetch) when NO workspace id is resolvable", async () => {
    delete process.env.WORKSPACE_ID;
    delete process.env.MOLECULE_WORKSPACE_ID;
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleListSchedules({}));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(f).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// #1 SECURITY — the MOLECULE_ORG_API_KEY (org-admin) fallback in authHeaders()
// may be emitted ONLY in management mode. In the DEFAULT a2a/workspace-ops mode
// it must NEVER be sent, even when present in env — the mode gate is the
// enforcement, not a trust that the injector never leaks the env. These pin the
// gate from both sides:
//
//   • management mode + org key (no MOLECULE_API_KEY/_TOKEN) → org-key bearer.
//   • DEFAULT mode  + org key (no MOLECULE_API_KEY/_TOKEN) → NO Authorization.
//     Negative control: against the pre-fix code (org key third in the OR with
//     no mode gate) this emitted `Bearer <org key>` and FAILS this assertion.
//   • self mode still early-returns to the token-file bearer (org key ignored).
// ===========================================================================
describe("#1 org-key fallback is gated to management mode", () => {
  const ORG_API_KEY = "org_api_key_MANAGEMENT_ONLY";

  beforeEach(() => {
    // Strip the workspace-token + primary key vars so ONLY MOLECULE_ORG_API_KEY
    // could satisfy the bearer — isolating the gate under test.
    delete process.env.MOLECULE_MCP_MODE;
    delete process.env.MOLECULE_API_KEY;
    delete process.env.MOLECULE_API_TOKEN;
    delete process.env.MOLECULE_WORKSPACE_TOKEN_FILE;
    process.env.MOLECULE_ORG_API_KEY = ORG_API_KEY;
  });

  it("management mode + MOLECULE_ORG_API_KEY → Authorization: Bearer <org key> (+ org routing id)", () => {
    process.env.MOLECULE_MCP_MODE = "management";
    const h = authHeaders();
    expect(h.Authorization).toBe(`Bearer ${ORG_API_KEY}`);
    expect(h["X-Molecule-Org-Id"]).toBe(ORG_ID);
  });

  it("DEFAULT mode (MOLECULE_MCP_MODE unset) + MOLECULE_ORG_API_KEY → NO Authorization (org key never leaks)", () => {
    // MOLECULE_MCP_MODE deleted above → default a2a/workspace-ops mode.
    expect(isSelfMode()).toBe(false);
    const h = authHeaders();
    expect(h.Authorization).toBeUndefined();
    // The org-admin key must not appear anywhere in the emitted headers.
    expect(JSON.stringify(h)).not.toContain(ORG_API_KEY);
    // The tenant ROUTING id is unrelated to the key gate and still attaches.
    expect(h["X-Molecule-Org-Id"]).toBe(ORG_ID);
  });

  it("DEFAULT mode + MOLECULE_ORG_API_KEY='a2a' alias → still NO org bearer", () => {
    process.env.MOLECULE_MCP_MODE = "a2a";
    const h = authHeaders();
    expect(h.Authorization).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain(ORG_API_KEY);
  });

  it("management mode still prefers MOLECULE_API_KEY over the org key when both are set", () => {
    process.env.MOLECULE_MCP_MODE = "management";
    process.env.MOLECULE_API_KEY = "primary_workspace_key";
    const h = authHeaders();
    expect(h.Authorization).toBe("Bearer primary_workspace_key");
  });

  it("self mode ignores MOLECULE_ORG_API_KEY and early-returns the token-file bearer", () => {
    process.env.MOLECULE_MCP_MODE = "self";
    const tf = join(tmpDir, `auth_token_orggate_${Math.random().toString(36).slice(2)}`);
    writeFileSync(tf, `${WS_TOKEN}\n`);
    process.env.MOLECULE_WORKSPACE_TOKEN_FILE = tf;
    const h = authHeaders();
    expect(h.Authorization).toBe(`Bearer ${WS_TOKEN}`);
    expect(JSON.stringify(h)).not.toContain(ORG_API_KEY);
  });
});

// ===========================================================================
// (c) self mode registers EXACTLY the 6 schedule tools — ZERO management tools
// ===========================================================================
describe("(c) self mode registers only the schedule tools", () => {
  const SCHEDULE_TOOLS = [
    "create_schedule",
    "delete_schedule",
    "get_schedule_history",
    "list_schedules",
    "run_schedule",
    "update_schedule",
  ];

  it("registers EXACTLY the 6 schedule tools and names the server molecule-self", () => {
    const srv = createServer() as unknown as {
      name: string;
      registeredToolNames: string[];
    };
    expect([...srv.registeredToolNames].sort()).toEqual(SCHEDULE_TOOLS);
    expect(srv.name).toBe("molecule-self");
  });

  it("registers ZERO management-tier / workspace-ops / cross-workspace tools", () => {
    const srv = createServer() as unknown as { registeredToolNames: string[] };
    // Explicit deny-list — any of these appearing means the self branch leaked
    // the management or workspace-ops surface.
    for (const forbidden of [
      "provision_workspace",
      "deprovision_workspace",
      "create_workspace",
      "list_workspaces",
      "delete_workspace",
      "mint_org_token",
      "mint_workspace_token",
      "promote_to_production",
      "set_secret",
      "set_workspace_secret",
      "set_org_secret",
      "install_plugin",
      "uninstall_plugin",
      "chat_with_agent",
      "write_file",
      "create_issue",
      "create_request",
    ]) {
      expect(srv.registeredToolNames).not.toContain(forbidden);
    }
    // Nothing beyond the 6 schedule tools, and no duplicates.
    expect(srv.registeredToolNames).toHaveLength(SCHEDULE_TOOLS.length);
    expect(new Set(srv.registeredToolNames).size).toBe(
      srv.registeredToolNames.length,
    );
  });
});

// ===========================================================================
// #1 REGRESSION GUARD — workspace_id self-defaults ONLY in self mode.
//
// The schedule tools register in BOTH self mode AND the DEFAULT a2a/workspace-
// ops mode (org/operator key that can target ANY workspace). A prior change
// narrowed workspace_id to optional and self-defaulted it in ALL modes, so an
// OMITTED id silently retargeted to the operator's OWN workspace — a silent
// wrong-workspace list/run/delete. These tests pin the mode gate from BOTH
// sides (inversion):
//
//   • default mode + omitted  → INVALID_ARGUMENTS, NO fetch. If the self-default
//     were re-applied in default mode, WORKSPACE_ID (set to OWN_WS in
//     beforeEach) would resolve and fetch WOULD be called → both assertions
//     fail. (Guards against RE-INTRODUCING the regression.)
//   • self mode + omitted     → resolves to the caller's OWN id, fetch IS made.
//     If the gate were inverted (self-default only in NON-self mode), self mode
//     would fail closed with INVALID_ARGUMENTS and no fetch → this fails.
//     (Guards against a gate that is present but backwards.)
// ===========================================================================
describe("#1 workspace_id self-defaults ONLY in self mode", () => {
  it("DEFAULT mode + OMITTED workspace_id → INVALID_ARGUMENTS, no fetch (does NOT self-default to the operator's own workspace)", async () => {
    delete process.env.MOLECULE_MCP_MODE; // default a2a / workspace-ops mode
    // WORKSPACE_ID is still OWN_WS from beforeEach — the regression would have
    // silently defaulted to it. Prove it does not.
    expect(isSelfMode()).toBe(false);
    expect(process.env.WORKSPACE_ID).toBe(OWN_WS);
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(await handleListSchedules({}));
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(f).not.toHaveBeenCalled();
  });

  it("DEFAULT mode + OMITTED workspace_id on the DESTRUCTIVE delete path → INVALID_ARGUMENTS, no fetch", async () => {
    delete process.env.MOLECULE_MCP_MODE;
    const f = mockFetch({ ok: true });
    global.fetch = f as unknown as typeof fetch;
    const res = parsed(
      await handleDeleteSchedule({ schedule_id: "sched-123" }),
    );
    expect(res.error).toBe("INVALID_ARGUMENTS");
    expect(f).not.toHaveBeenCalled();
  });

  it("DEFAULT mode + EXPLICIT workspace_id → targets that workspace (org/operator key can act on any workspace; not over-restricted)", async () => {
    delete process.env.MOLECULE_MCP_MODE;
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    await handleRunSchedule({ workspace_id: FOREIGN_WS, schedule_id: "s9" });
    expect(lastCall(f).url).toBe(
      `${PLATFORM_URL}/workspaces/${FOREIGN_WS}/schedules/s9/run`,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("SELF mode + OMITTED workspace_id → self-resolves to the caller's OWN id and fetches (beforeEach already sets self mode + WORKSPACE_ID)", async () => {
    // beforeEach: MOLECULE_MCP_MODE=self, WORKSPACE_ID=OWN_WS.
    expect(isSelfMode()).toBe(true);
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    await handleListSchedules({});
    expect(lastCall(f).url).toBe(
      `${PLATFORM_URL}/workspaces/${OWN_WS}/schedules`,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("SELF mode + EXPLICIT workspace_id is still allowed (carries only the self-bound token; core 401s a foreign id — see suite (a))", async () => {
    const f = mockFetch([{ id: "s1" }]);
    global.fetch = f as unknown as typeof fetch;
    await handleListSchedules({ workspace_id: FOREIGN_WS });
    expect(lastCall(f).url).toBe(
      `${PLATFORM_URL}/workspaces/${FOREIGN_WS}/schedules`,
    );
  });
});
