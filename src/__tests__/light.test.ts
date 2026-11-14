/**
 * Unit tests for the Enter OS Light tools (src/tools/light.ts).
 *
 * The HTTP layer is mocked via global.fetch with a scripted tenant: every
 * request must match the next expected method + path (+ body), so a wrong
 * route, a stray retry or a missing step fails the test. The contract is
 * molecule-core docs/api-protocol/light-api.md; the bodies below are the doc's
 * own examples.
 *
 * light_create_agent's polling and backoff run on an injected fake clock (sleeps
 * return at once and advance `now`), so the recorded sleeps pin the poll
 * interval, the backoff and Retry-After.
 */

import { isDeepStrictEqual } from "node:util";

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registeredToolNames: string[] = [];
    tool(name: string) {
      // Mirror the real SDK: a duplicate tool name throws at registration.
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

import { createServer } from "../index.js";
import { PLATFORM_URL } from "../api.js";
import {
  LIGHT_TOOL_NAMES,
  createLightAgent,
  handleLightCreateAgent,
  handleLightDisable,
  handleLightEnable,
  handleLightOpen,
  handleLightPark,
  handleLightRunNow,
  handleLightRuns,
  handleLightStatus,
  lightPathSegment,
  lightRequest,
  registerLightTools,
  type LightClock,
} from "../tools/light.js";

const WS = "be7540cf-d160-4e2a-9b1c-0123456789ab";
const HOST = "https://acme.moleculesai.app";
const ORG_KEY = "org_testkey_light";
const API_KEY = "tenant_testkey_light";
const ORG_ID = "org-22222222";

// --- the doc's example bodies ------------------------------------------------

const LIGHT_PARKED = {
  workspace_id: WS,
  light_state: "parked",
  light_state_at: "2026-11-13T09:00:04Z",
  refresh_pending: false,
  pending_actions: [],
  last_error: null,
  schedules: [
    {
      name: "daily-report",
      cron: "0 9 * * *",
      timezone: "America/Vancouver",
      prompt: "Write the daily report.",
      enabled: true,
      suspended: false,
      suspended_reason: null,
      suspended_at: null,
      consecutive_failures: 0,
      cronjob: "light-be7540cfd160-1a2b3c4d",
      next_run_at: "2026-11-13T16:00:00Z",
    },
  ],
};
const LIGHT_PARKING = { ...LIGHT_PARKED, light_state: "parking", light_state_at: "2026-11-13T08:59:40Z" };
const PARK_ACCEPTED = {
  light_state: "parking",
  schedules: [
    {
      name: "daily-report",
      cron: "0 9 * * *",
      timezone: "America/Vancouver",
      enabled: true,
      suspended: false,
      cronjob: "light-be7540cfd160-1a2b3c4d",
    },
  ],
  removed: ["old-schedule"],
};
const RUNS_PAGE = {
  runs: [
    {
      run_id: "light-be7540cfd160-1a2b3c4d-29384756",
      schedule: "daily-report",
      status: "succeeded",
      source: "report",
      scheduled_for: "2026-11-13T09:00:00Z",
      started_at: "2026-11-13T09:00:07Z",
      finished_at: "2026-11-13T09:03:41Z",
      exit_code: 0,
      output: "Report sent.",
      error: "",
      created_at: "2026-11-13T09:00:07.512Z",
      activity_count: 12,
      activity_path: `/workspaces/${WS}/activity?run_id=light-be7540cfd160-1a2b3c4d-29384756`,
    },
  ],
  next_before: "opaque-cursor-1",
};
const BUSY = {
  error: "the agent is working; park it when it is idle",
  code: "LIGHT_AGENT_BUSY",
  active_tasks: 1,
  is_busy: true,
};

// --- scripted tenant ---------------------------------------------------------

type Expected = {
  method: "GET" | "POST";
  path: string;
  /** When present, the request body must deep-equal it (undefined = no body). */
  body?: unknown;
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Serve this answer this many times in a row. */
  repeat?: number;
  /** Called when this answer is served (e.g. to cancel the call). */
  onServe?: () => void;
};

type Seen = { method: string; path: string; body: unknown; headers: Record<string, string> };

function response(status: number, json?: unknown, text?: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => (text !== undefined ? text : json === undefined ? "" : JSON.stringify(json)),
  };
}

function scriptTenant(base: string, expected: Expected[]) {
  const queue: Expected[] = [];
  for (const e of expected) for (let i = 0; i < (e.repeat ?? 1); i += 1) queue.push(e);
  const problems: string[] = [];
  const seen: Seen[] = [];
  const fetchMock = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = String(init.method ?? "GET");
    const path = url.startsWith(base) ? url.slice(base.length) : url;
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    seen.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
    const next = queue.shift();
    const bodyMismatch = next !== undefined && "body" in next && !isDeepStrictEqual(next.body, body);
    if (!next || next.method !== method || next.path !== path || bodyMismatch) {
      problems.push(
        `unexpected ${method} ${path} ${JSON.stringify(body)}; expected ` +
          (next ? `${next.method} ${next.path} ${JSON.stringify(next.body)}` : "no request"),
      );
      return response(418, { error: "unexpected request in the test", code: "TEST_UNEXPECTED_REQUEST" });
    }
    next.onServe?.();
    return response(next.status, next.json, next.text, next.headers);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, problems, seen, left: () => queue.length };
}

function fakeClock() {
  let t = Date.parse("2026-11-14T00:00:00Z");
  const sleeps: number[] = [];
  const clock: LightClock = {
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      sleeps.push(ms);
      t += ms;
    },
  };
  return { clock, sleeps };
}

/** Parse the JSON a handler returns inside the MCP envelope. */
function parsed(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.MOLECULE_MCP_MODE = "management";
  process.env.MOLECULE_API_URL = HOST;
  process.env.MOLECULE_ORG_API_KEY = ORG_KEY;
  process.env.MOLECULE_ORG_ID = ORG_ID;
  delete process.env.MOLECULE_ORG_SLUG;
  delete process.env.MOLECULE_API_KEY;
  delete process.env.MOLECULE_API_TOKEN;
  delete process.env.MOLECULE_LLM_DEFAULT_MODEL;
  delete process.env.MOLECULE_MODEL;
  delete process.env.MODEL;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// =============================================================================
// registration
// =============================================================================

describe("registration", () => {
  it("registerLightTools registers exactly the eight Light tools", () => {
    const srv = { names: [] as string[], tool(n: string) { this.names.push(n); } };
    registerLightTools(srv as never);
    expect([...srv.names].sort()).toEqual([
      "light_create_agent",
      "light_disable",
      "light_enable",
      "light_open",
      "light_park",
      "light_run_now",
      "light_runs",
      "light_status",
    ]);
    expect([...LIGHT_TOOL_NAMES].sort()).toEqual([...srv.names].sort());
  });

  it.each([
    ["management", "management"],
    ["workspace (default)", ""],
  ])("createServer in %s mode offers every Light tool without a name collision", (_label, mode) => {
    process.env.MOLECULE_MCP_MODE = mode;
    const srv = createServer() as unknown as { registeredToolNames: string[] };
    for (const name of LIGHT_TOOL_NAMES) expect(srv.registeredToolNames).toContain(name);
  });

  it("self mode offers no Light tool (core refuses a workspace's own token on the Light management routes)", () => {
    process.env.MOLECULE_MCP_MODE = "self";
    const srv = createServer() as unknown as { registeredToolNames: string[] };
    for (const name of LIGHT_TOOL_NAMES) expect(srv.registeredToolNames).not.toContain(name);
  });
});

// =============================================================================
// request + response mapping
// =============================================================================

describe("request and response mapping (management mode: Org API Key)", () => {
  it("light_status GETs /workspaces/{id}/light and returns core's answer unchanged", async () => {
    const t = scriptTenant(HOST, [
      { method: "GET", path: `/workspaces/${WS}/light`, body: undefined, status: 200, json: LIGHT_PARKED },
    ]);
    const res = await handleLightStatus({ workspace_id: WS });
    expect(t.problems).toEqual([]);
    expect(res.isError).toBeUndefined();
    expect(parsed(res)).toEqual(LIGHT_PARKED);
    expect(t.seen[0].headers.Authorization).toBe(`Bearer ${ORG_KEY}`);
    expect(t.seen[0].headers["X-Molecule-Org-Id"]).toBe(ORG_ID);
    // A Light call never names the target in X-Workspace-ID: core reads that
    // header as "the workspace itself" and refuses with LIGHT_SELF_FORBIDDEN.
    expect(t.seen[0].headers["X-Workspace-ID"]).toBeUndefined();
  });

  it.each([
    ["light_enable", handleLightEnable, "enable", 200, { status: "enabled", light_state: "open", restart: "started" }],
    [
      "light_disable",
      handleLightDisable,
      "disable",
      200,
      { status: "disabled", light_state: null, deleted: { cronjobs: 1, jobs: 0, secrets: 1 }, restart: "woken" },
    ],
    ["light_park", handleLightPark, "park", 202, PARK_ACCEPTED],
    ["light_open", handleLightOpen, "open", 200, { status: "unchanged", light_state: "open" }],
  ])("%s POSTs /light/%s with no body and returns core's answer unchanged", async (_tool, handler, route, status, json) => {
    const t = scriptTenant(HOST, [
      { method: "POST", path: `/workspaces/${WS}/light/${route}`, body: undefined, status, json },
    ]);
    const res = await handler({ workspace_id: WS });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(res.isError).toBeUndefined();
    expect(parsed(res)).toEqual(json);
    expect(t.seen[0].headers.Authorization).toBe(`Bearer ${ORG_KEY}`);
  });

  it("light_open passes the 202 opening answer through, cancelled runs included", async () => {
    const json = { light_state: "opening", cancelled: ["light-be7540cfd160-1a2b3c4d-29384756"] };
    const t = scriptTenant(HOST, [{ method: "POST", path: `/workspaces/${WS}/light/open`, status: 202, json }]);
    expect(parsed(await handleLightOpen({ workspace_id: WS }))).toEqual(json);
    expect(t.problems).toEqual([]);
  });

  it("light_run_now POSTs exactly {schedule} to /light/run and returns the run_id", async () => {
    const json = { run_id: "light-be7540cfd160-1a2b3c4d-m1763000000" };
    const t = scriptTenant(HOST, [
      { method: "POST", path: `/workspaces/${WS}/light/run`, body: { schedule: "daily-report" }, status: 201, json },
    ]);
    const res = await handleLightRunNow({ workspace_id: WS, schedule: "daily-report" });
    expect(t.problems).toEqual([]);
    expect(parsed(res)).toEqual(json);
  });

  it("light_runs sends limit, schedule and before as query parameters and returns next_before", async () => {
    const t = scriptTenant(HOST, [
      {
        method: "GET",
        path: `/workspaces/${WS}/light/runs?limit=5&schedule=daily-report&before=opaque-cursor-0`,
        body: undefined,
        status: 200,
        json: RUNS_PAGE,
      },
    ]);
    const res = await handleLightRuns({
      workspace_id: WS,
      limit: 5,
      schedule: "daily-report",
      before: "opaque-cursor-0",
    });
    expect(t.problems).toEqual([]);
    expect(res.isError).toBeUndefined();
    expect(parsed(res)).toEqual(RUNS_PAGE);
    expect(parsed(res).next_before).toBe("opaque-cursor-1");
  });

  it("light_runs omits the query parameters it was not given", async () => {
    const t = scriptTenant(HOST, [
      { method: "GET", path: `/workspaces/${WS}/light/runs`, status: 200, json: { runs: [], next_before: null } },
    ]);
    expect(parsed(await handleLightRuns({ workspace_id: WS }))).toEqual({ runs: [], next_before: null });
    expect(t.problems).toEqual([]);
  });

  it("sends X-Molecule-Org-Slug when MOLECULE_ORG_SLUG is set, like the other management tools", async () => {
    process.env.MOLECULE_ORG_SLUG = "acme";
    const t = scriptTenant(HOST, [{ method: "GET", path: `/workspaces/${WS}/light`, status: 200, json: LIGHT_PARKED }]);
    await handleLightStatus({ workspace_id: WS });
    expect(t.seen[0].headers["X-Molecule-Org-Slug"]).toBe("acme");
  });

  it("returns AUTH_ERROR without a request when MOLECULE_ORG_API_KEY is absent", async () => {
    delete process.env.MOLECULE_ORG_API_KEY;
    const t = scriptTenant(HOST, []);
    const res = await handleLightPark({ workspace_id: WS });
    expect(res.isError).toBe(true);
    expect(parsed(res).code).toBe("AUTH_ERROR");
    expect(parsed(res).error).toMatch(/MOLECULE_ORG_API_KEY is not set/);
    expect(t.fetchMock).not.toHaveBeenCalled();
  });
});

describe("request mapping (workspace mode: MOLECULE_API_KEY)", () => {
  beforeEach(() => {
    process.env.MOLECULE_MCP_MODE = "";
    process.env.MOLECULE_API_KEY = API_KEY;
  });

  it("uses the tenant API key on the workspace API base and never the org key", async () => {
    // MOLECULE_ORG_API_KEY is still set (beforeEach): outside management mode
    // it must not be sent (the api.ts mode gate).
    const t = scriptTenant(PLATFORM_URL, [
      { method: "POST", path: `/workspaces/${WS}/light/park`, body: undefined, status: 202, json: PARK_ACCEPTED },
    ]);
    const res = await handleLightPark({ workspace_id: WS });
    expect(t.problems).toEqual([]);
    expect(parsed(res)).toEqual(PARK_ACCEPTED);
    expect(t.seen[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(t.seen[0].headers["X-Molecule-Org-Id"]).toBe(ORG_ID);
    expect(JSON.stringify(t.seen[0].headers)).not.toContain(ORG_KEY);
  });
});

// =============================================================================
// input validation
// =============================================================================

// =============================================================================
// path safety: no request path is built from an unvalidated value
// =============================================================================

const ROUTE_TOOLS: Array<[string, (args: unknown) => Promise<unknown>, Record<string, unknown>]> = [
  ["light_status", handleLightStatus, {}],
  ["light_enable", handleLightEnable, {}],
  ["light_disable", handleLightDisable, {}],
  ["light_park", handleLightPark, {}],
  ["light_open", handleLightOpen, {}],
  ["light_run_now", handleLightRunNow, { schedule: "daily-report" }],
  ["light_runs", handleLightRuns, {}],
];

// Path traversal, encoded dots and slashes, control characters, and ids that
// are UUIDs but not canonical (core requires the lowercase form).
const MALICIOUS_WORKSPACE_IDS = [
  "",
  ".",
  "..",
  "%2e%2e",
  "../other",
  `${WS}/..`,
  `${WS}/../../admin`,
  `${WS}%2f..`,
  `${WS}\\..`,
  `${WS}/light`,
  `${WS}\u0000`,
  `${WS}\n`,
  ` ${WS}`,
  WS.toUpperCase(),
  "w1",
  "a".repeat(129),
];

describe.each(ROUTE_TOOLS)("%s accepts only a canonical workspace UUID", (_tool, handler, extra) => {
  it.each(MALICIOUS_WORKSPACE_IDS)("refuses workspace_id %p and sends no request", async (workspace_id) => {
    const t = scriptTenant(HOST, []);
    await expect(handler({ workspace_id, ...extra })).rejects.toThrow(/workspace_id/);
    expect(t.fetchMock).not.toHaveBeenCalled();
  });
});

describe("lightPathSegment: the one way a supplied value enters a path", () => {
  it.each([
    "",
    ".",
    "..",
    "a/b",
    "/",
    "a\\b",
    "\\",
    "a\u0000b",
    "a\u001fb",
    "a\u007fb",
    "a\u0085b",
    "a".repeat(129),
    "é".repeat(65), // 130 bytes
  ])("refuses %p", (value) => {
    expect(() => lightPathSegment(value, "schedule")).toThrow(/schedule/);
  });

  it("encodes an accepted value as a single segment", () => {
    expect(lightPathSegment("daily-report", "schedule")).toBe("daily-report");
    expect(lightPathSegment("daily report?#%", "schedule")).toBe("daily%20report%3F%23%25");
    expect(lightPathSegment("a".repeat(128), "schedule")).toBe("a".repeat(128));
    // Encoded, an encoded dot is no longer a dot segment.
    expect(lightPathSegment("%2e%2e", "schedule")).toBe("%252e%252e");
  });
});

describe("lightRequest refuses a path with a dot segment before it is sent", () => {
  it.each([
    `/workspaces/${WS}/schedules/..`,
    `/workspaces/${WS}/schedules/.`,
    `/workspaces/${WS}/./light`,
    `/workspaces/${WS}/schedules/%2e%2e`,
    `/workspaces/${WS}/schedules/%2E%2E`,
    `/workspaces/${WS}/schedules/.%2e`,
    `/workspaces/${WS}/schedules/%2e.`,
    `/workspaces/${WS}/%2e/light`,
    `/workspaces/${WS}/x%2f..%2f..`,
    `/workspaces/${WS}/x%5c..`,
    `/workspaces/${WS}\\..`,
    `/workspaces/${WS}/\u0001`,
    `/workspaces/${WS}/%zz`,
    `workspaces/${WS}/light`,
    `//evil.example/workspaces/${WS}`,
    `/workspaces/${WS}/light?x=1`,
    `/workspaces/${WS}/light#x`,
  ])("refuses %p", async (path) => {
    const t = scriptTenant(HOST, []);
    const answer = await lightRequest("POST", path);
    expect(answer).toMatchObject({
      ok: false,
      failure: { error: "Invalid platform API path", code: "INVALID_ARGUMENTS" },
    });
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it("sends a clean path (control)", async () => {
    const t = scriptTenant(HOST, [{ method: "GET", path: `/workspaces/${WS}/light`, status: 200, json: LIGHT_PARKED }]);
    await expect(lightRequest("GET", `/workspaces/${WS}/light`)).resolves.toMatchObject({ ok: true });
    expect(t.problems).toEqual([]);
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("input validation (before any request)", () => {
  it.each([0, 101, 2.5])("light_runs rejects limit %p", async (limit) => {
    const t = scriptTenant(HOST, []);
    await expect(handleLightRuns({ workspace_id: WS, limit })).rejects.toThrow();
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it("light_run_now requires a schedule name", async () => {
    const t = scriptTenant(HOST, []);
    await expect(handleLightRunNow({ workspace_id: WS, schedule: "" })).rejects.toThrow();
    await expect(handleLightRunNow({ workspace_id: WS })).rejects.toThrow();
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  const schedule = { name: "daily-report", cron: "0 9 * * *", timezone: "America/Vancouver", prompt: "Write it." };
  it.each([
    ["no schedules", { name: "a", schedules: [] }],
    ["a duplicate schedule name", { name: "a", schedules: [schedule, schedule] }],
    ["a name that is not a lowercase slug", { name: "a", schedules: [{ ...schedule, name: "Daily Report" }] }],
    ["an empty cron", { name: "a", schedules: [{ ...schedule, cron: " " }] }],
    // Core parses crons with the standard five-field parser: no seconds field, no @-descriptors.
    ["a six-field cron with seconds", { name: "a", schedules: [{ ...schedule, cron: "0 0 9 * * *" }] }],
    ["an @-descriptor cron", { name: "a", schedules: [{ ...schedule, cron: "@daily" }] }],
    ["an empty timezone", { name: "a", schedules: [{ ...schedule, timezone: "" }] }],
    ["an empty prompt", { name: "a", schedules: [{ ...schedule, prompt: "  " }] }],
    ["a prompt over 16 KiB", { name: "a", schedules: [{ ...schedule, prompt: "é".repeat(8193) }] }],
    ["an empty agent name", { name: " ", schedules: [schedule] }],
    ["a timeout under a minute", { name: "a", schedules: [schedule], timeout_seconds: 30 }],
    ["a non-string secret", { name: "a", schedules: [schedule], secrets: { KEY: 1 } }],
  ])("light_create_agent rejects %s before creating anything", async (_label, args) => {
    const t = scriptTenant(HOST, []);
    await expect(handleLightCreateAgent(args)).rejects.toThrow();
    expect(t.fetchMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// error mapping
// =============================================================================

describe("error mapping: core's code and message surface unchanged", () => {
  it("a refusal returns core's body unchanged plus http_status, as an MCP error", async () => {
    scriptTenant(HOST, [{ method: "POST", path: `/workspaces/${WS}/light/park`, status: 409, json: BUSY }]);
    const res = await handleLightPark({ workspace_id: WS });
    expect(res.isError).toBe(true);
    expect(parsed(res)).toEqual({ ...BUSY, http_status: 409 });
  });

  it("keeps core's `status` extra (the workspace status), never overwriting it with the HTTP status", async () => {
    const body = {
      error: "the agent is not online; park it once it is online again",
      code: "LIGHT_AGENT_NOT_AWAKE",
      status: "offline",
    };
    scriptTenant(HOST, [{ method: "POST", path: `/workspaces/${WS}/light/park`, status: 409, json: body }]);
    const out = parsed(await handleLightPark({ workspace_id: WS }));
    expect(out).toEqual({ ...body, http_status: 409 });
    expect(out.status).toBe("offline");
  });

  it("passes LIGHT_INVALID's invalid list through", async () => {
    const body = {
      error: "some schedules are invalid",
      code: "LIGHT_INVALID",
      invalid: [{ schedule: "daily-report", field: "cron", reason: "expected five fields" }],
    };
    scriptTenant(HOST, [{ method: "POST", path: `/workspaces/${WS}/light/park`, status: 422, json: body }]);
    expect(parsed(await handleLightPark({ workspace_id: WS }))).toEqual({ ...body, http_status: 422 });
  });

  it("adds retry_after_seconds from a 503's Retry-After", async () => {
    const body = {
      error: "the control plane did not answer; nothing was changed by this step, retry shortly",
      code: "LIGHT_BACKEND_UNAVAILABLE",
    };
    scriptTenant(HOST, [
      { method: "POST", path: `/workspaces/${WS}/light/enable`, status: 503, json: body, headers: { "Retry-After": "7" } },
    ]);
    expect(parsed(await handleLightEnable({ workspace_id: WS }))).toEqual({
      ...body,
      http_status: 503,
      retry_after_seconds: 7,
    });
  });

  it("a parked agent's run refusal keeps light_state", async () => {
    const body = { error: "the agent is not parked", code: "LIGHT_NOT_PARKED", light_state: "open" };
    scriptTenant(HOST, [{ method: "POST", path: `/workspaces/${WS}/light/run`, status: 409, json: body }]);
    expect(parsed(await handleLightRunNow({ workspace_id: WS, schedule: "daily-report" }))).toEqual({
      ...body,
      http_status: 409,
    });
  });

  it("an error body without a code keeps core's sentence and gets AUTH_ERROR for 401", async () => {
    scriptTenant(HOST, [{ method: "GET", path: `/workspaces/${WS}/light`, status: 401, json: { error: "unauthorized" } }]);
    const res = await handleLightStatus({ workspace_id: WS });
    expect(res.isError).toBe(true);
    expect(parsed(res)).toEqual({ error: "unauthorized", code: "AUTH_ERROR", http_status: 401 });
  });

  it("a body that is not JSON gets PLATFORM_ERROR with the start of the body", async () => {
    scriptTenant(HOST, [
      { method: "GET", path: `/workspaces/${WS}/light/runs`, status: 502, text: "<html>Bad gateway</html>" },
    ]);
    expect(parsed(await handleLightRuns({ workspace_id: WS }))).toEqual({
      error: "HTTP 502",
      code: "PLATFORM_ERROR",
      http_status: 502,
      detail: "<html>Bad gateway</html>",
    });
  });

  it("a network failure is a PLATFORM_ERROR naming the host", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED")) as unknown as typeof fetch;
    const res = await handleLightStatus({ workspace_id: WS });
    expect(res.isError).toBe(true);
    expect(parsed(res)).toMatchObject({
      error: `Platform unreachable at ${HOST}`,
      code: "PLATFORM_ERROR",
      detail: "connect ECONNREFUSED",
    });
  });
});

// =============================================================================
// light_create_agent
// =============================================================================

const SOCIAL = {
  name: "social-post",
  cron: "0 9 * * *",
  timezone: "America/Vancouver",
  prompt: "Write today's social media post and publish it.",
};
const SEO = {
  name: "seo-scan",
  cron: "0 18 * * *",
  timezone: "America/Vancouver",
  prompt: "Scan the website for SEO problems.",
  enabled: false,
};
const INPUT = {
  name: "social-and-seo",
  model: "minimax/MiniMax-M2.7",
  secrets: { SOCIAL_API_KEY: "s3cr3t-value" },
  schedules: [SOCIAL, SEO],
};
const WS_PATH = `/workspaces/${WS}`;
const CREATED = { id: WS, status: "provisioning", workspace_access: "none", auth_token: "ws-token-must-not-leak" };
const ws = (status: string, active_tasks = 0, extra: Record<string, unknown> = {}) => ({
  id: WS,
  name: "social-and-seo",
  runtime: "hermes",
  status,
  active_tasks,
  light_state: null,
  ...extra,
});
const scheduleBody = (s: typeof SOCIAL & { enabled?: boolean }) => ({
  name: s.name,
  cron_expr: s.cron,
  timezone: s.timezone,
  prompt: s.prompt,
  enabled: s.enabled ?? true,
});

// The steps before the park, for a fresh agent whose enable needs no restart wait.
function upToPark(): Expected[] {
  return [
    { method: "POST", path: "/workspaces", status: 201, json: CREATED },
    { method: "GET", path: WS_PATH, status: 200, json: ws("online") },
    { method: "POST", path: `${WS_PATH}/schedules`, body: scheduleBody(SOCIAL), status: 201, json: { id: "social-post" } },
    { method: "POST", path: `${WS_PATH}/schedules`, body: scheduleBody(SEO), status: 201, json: { id: "seo-scan" } },
    {
      method: "POST",
      path: `${WS_PATH}/light/enable`,
      body: undefined,
      status: 200,
      json: { status: "enabled", light_state: "open", restart: "none" },
    },
    { method: "GET", path: WS_PATH, status: 200, json: ws("online") },
  ];
}

describe("light_create_agent flow", () => {
  it("creates, schedules, enables, waits out the restart and parks — retrying a busy park", async () => {
    const t = scriptTenant(HOST, [
      {
        method: "POST",
        path: "/workspaces",
        body: {
          name: "social-and-seo",
          runtime: "hermes",
          model: "minimax/MiniMax-M2.7",
          secrets: { SOCIAL_API_KEY: "s3cr3t-value" },
        },
        status: 201,
        json: CREATED,
      },
      { method: "GET", path: WS_PATH, status: 200, json: ws("provisioning") },
      { method: "GET", path: WS_PATH, status: 200, json: ws("online") },
      // The scheduler is still starting: core answers 503, retried.
      { method: "POST", path: `${WS_PATH}/schedules`, body: scheduleBody(SOCIAL), status: 503, json: { error: "scheduler starting, retry" } },
      { method: "POST", path: `${WS_PATH}/schedules`, body: scheduleBody(SOCIAL), status: 201, json: { id: "social-post", status: "created" } },
      { method: "POST", path: `${WS_PATH}/schedules`, body: scheduleBody(SEO), status: 201, json: { id: "seo-scan", status: "created" } },
      {
        method: "POST",
        path: `${WS_PATH}/light/enable`,
        body: undefined,
        status: 200,
        json: { status: "enabled", light_state: "open", restart: "started" },
      },
      // The restart enable started: still online, then down, then up but busy, then idle.
      { method: "GET", path: WS_PATH, status: 200, json: ws("online") },
      { method: "GET", path: WS_PATH, status: 200, json: ws("offline") },
      { method: "GET", path: WS_PATH, status: 200, json: ws("online", 1) },
      { method: "GET", path: WS_PATH, status: 200, json: ws("online") },
      // The agent took a task: the park is refused as busy and retried.
      { method: "POST", path: `${WS_PATH}/light/park`, body: undefined, status: 409, json: BUSY },
      { method: "POST", path: `${WS_PATH}/light/park`, body: undefined, status: 202, json: PARK_ACCEPTED },
      { method: "GET", path: `${WS_PATH}/light`, status: 200, json: LIGHT_PARKING },
      { method: "GET", path: `${WS_PATH}/light`, status: 200, json: LIGHT_PARKED },
    ]);
    const { clock, sleeps } = fakeClock();
    const steps: string[] = [];

    const out = await createLightAgent(INPUT, { clock, onStep: (s) => steps.push(s) });

    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toEqual({
      workspace_id: WS,
      name: "social-and-seo",
      model: "minimax/MiniMax-M2.7",
      light_state: "parked",
      light: LIGHT_PARKED,
    });
    // Poll every 3 s; back off 2 s on the first retry of a step.
    expect(sleeps).toEqual([3000, 2000, 3000, 3000, 3000, 2000, 3000]);
    expect(steps).toEqual([
      "create",
      "wait-online",
      "create-schedules",
      "enable",
      "wait-restart",
      "park",
      "park",
      "wait-parked",
    ]);
    // The create answer's workspace token and the secret values never reach the result.
    expect(JSON.stringify(out)).not.toContain("ws-token-must-not-leak");
    expect(JSON.stringify(out)).not.toContain("s3cr3t-value");
    // Every call carries the org credential.
    for (const s of t.seen) expect(s.headers.Authorization).toBe(`Bearer ${ORG_KEY}`);
  });

  it("parks again when a park is undone after its 202 because the agent was busy", async () => {
    const t = scriptTenant(HOST, [
      ...upToPark(),
      { method: "POST", path: `${WS_PATH}/light/park`, status: 202, json: PARK_ACCEPTED },
      { method: "GET", path: `${WS_PATH}/light`, status: 200, json: LIGHT_PARKING },
      {
        method: "GET",
        path: `${WS_PATH}/light`,
        status: 200,
        json: {
          ...LIGHT_PARKED,
          light_state: "open",
          last_error: { code: "LIGHT_AGENT_BUSY", message: "the agent took a task while parking", at: "2026-11-13T09:00:02Z" },
        },
      },
      { method: "POST", path: `${WS_PATH}/light/park`, status: 202, json: PARK_ACCEPTED },
      { method: "GET", path: `${WS_PATH}/light`, status: 200, json: LIGHT_PARKED },
    ]);
    const { clock, sleeps } = fakeClock();
    const out = await createLightAgent(INPUT, { clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toMatchObject({ workspace_id: WS, light_state: "parked" });
    expect(sleeps).toEqual([3000, 2000]);
  });

  it("stops on a hard park refusal with core's code, message and extras, the step and the workspace id", async () => {
    const invalid = {
      error: "some schedules are invalid",
      code: "LIGHT_INVALID",
      invalid: [{ schedule: "social-post", field: "cron", reason: "expected five fields" }],
    };
    const t = scriptTenant(HOST, [
      ...upToPark(),
      { method: "POST", path: `${WS_PATH}/light/park`, status: 422, json: invalid },
    ]);
    const { clock, sleeps } = fakeClock();
    const out = await createLightAgent(INPUT, { clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0); // no retry of a hard refusal
    expect(sleeps).toEqual([]);
    expect(out).toMatchObject({ ...invalid, http_status: 422, step: "park", workspace_id: WS });
    expect(out).not.toHaveProperty("attempts");
    expect(String(out.note)).toMatch(/light_park/);
  });

  it("stops at enable when the tenant cannot run Light, saying the workspace is an ordinary agent", async () => {
    const unsupported = {
      error: "Light runs on the Kubernetes substrate only; this tenant cannot run Light schedules",
      code: "LIGHT_UNSUPPORTED",
    };
    const t = scriptTenant(HOST, [
      ...upToPark().slice(0, 4),
      { method: "POST", path: `${WS_PATH}/light/enable`, status: 501, json: unsupported },
    ]);
    const { clock } = fakeClock();
    const out = await createLightAgent(INPUT, { clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toMatchObject({ ...unsupported, http_status: 501, step: "enable", workspace_id: WS });
    expect(String(out.note)).toMatch(/ordinary 24\/7 agent/);
    expect(String(out.note)).toMatch(/deprovision_workspace/);
  });

  it("names delete_workspace in the note in workspace mode", async () => {
    process.env.MOLECULE_MCP_MODE = "";
    process.env.MOLECULE_API_KEY = API_KEY;
    const t = scriptTenant(PLATFORM_URL, [
      ...upToPark().slice(0, 4),
      { method: "POST", path: `${WS_PATH}/light/enable`, status: 422, json: { error: "x", code: "LIGHT_PLATFORM_AGENT" } },
    ]);
    const out = await createLightAgent(INPUT, { clock: fakeClock().clock });
    expect(t.problems).toEqual([]);
    expect(String(out.note)).toMatch(/delete_workspace/);
  });

  it("honours a 503's Retry-After on enable, and still waits for the restart when the retried enable answers unchanged", async () => {
    const t = scriptTenant(HOST, [
      ...upToPark().slice(0, 4),
      {
        method: "POST",
        path: `${WS_PATH}/light/enable`,
        status: 503,
        json: { error: "the control plane did not answer", code: "LIGHT_BACKEND_UNAVAILABLE" },
        headers: { "Retry-After": "5" },
      },
      // The first call did enable the agent (its answer was the 503 of a later
      // step or it was lost): unchanged means the restart may still be pending.
      {
        method: "POST",
        path: `${WS_PATH}/light/enable`,
        status: 200,
        json: { status: "unchanged", light_state: "open", restart: "none" },
      },
      { method: "GET", path: WS_PATH, status: 200, json: ws("online") },
      { method: "GET", path: WS_PATH, status: 200, json: ws("provisioning") },
      { method: "GET", path: WS_PATH, status: 200, json: ws("online") },
      { method: "POST", path: `${WS_PATH}/light/park`, status: 202, json: PARK_ACCEPTED },
      { method: "GET", path: `${WS_PATH}/light`, status: 200, json: LIGHT_PARKED },
    ]);
    const { clock, sleeps } = fakeClock();
    const out = await createLightAgent(INPUT, { clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toMatchObject({ light_state: "parked" });
    expect(sleeps).toEqual([5000, 3000, 3000]);
  });

  it("gives up a transient refusal when the time limit would pass, returning the last refusal and the attempts", async () => {
    const inProgress = {
      error: "another Light operation on this agent is in progress; retry shortly",
      code: "LIGHT_TRANSITION_IN_PROGRESS",
    };
    // 60 s budget: retries after 2, 4, 8, 16 and 30 s (the backoff caps at 30 s);
    // the next 30 s wait would pass the limit, so the sixth refusal is returned.
    const t = scriptTenant(HOST, [
      ...upToPark(),
      { method: "POST", path: `${WS_PATH}/light/park`, status: 409, json: inProgress, repeat: 6 },
    ]);
    const { clock, sleeps } = fakeClock();
    const out = await createLightAgent({ ...INPUT, timeout_seconds: 60 }, { clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(out).toMatchObject({ ...inProgress, http_status: 409, step: "park", workspace_id: WS, attempts: 6 });
  });

  it("returns core's refusal of the create with the step and no workspace id", async () => {
    const refusal = {
      error: "model is not registered for runtime hermes",
      code: "UNREGISTERED_MODEL_FOR_RUNTIME",
      runtime: "hermes",
    };
    const t = scriptTenant(HOST, [{ method: "POST", path: "/workspaces", status: 422, json: refusal }]);
    const out = await createLightAgent(INPUT, { clock: fakeClock().clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toEqual({ ...refusal, http_status: 422, step: "create" });
  });

  it.each(["../../admin", `${WS}/..`, `${WS}%2f..`, WS.toUpperCase(), "", 42])(
    "never builds a path from a create answer whose id is not a canonical UUID: %p",
    async (id) => {
      const t = scriptTenant(HOST, [
        { method: "POST", path: "/workspaces", status: 201, json: { id, status: "provisioning" } },
      ]);
      const out = await createLightAgent(INPUT, { clock: fakeClock().clock });
      expect(t.problems).toEqual([]);
      expect(t.seen).toHaveLength(1); // only the create; nothing addressed with that id
      expect(out).toMatchObject({ code: "PLATFORM_ERROR", step: "create", http_status: 201 });
      expect(out).not.toHaveProperty("workspace_id");
    },
  );

  it("uses the platform default model when none is given", async () => {
    process.env.MOLECULE_LLM_DEFAULT_MODEL = "minimax/MiniMax-M3";
    const t = scriptTenant(HOST, [
      {
        method: "POST",
        path: "/workspaces",
        body: { name: "seo", runtime: "hermes", model: "minimax/MiniMax-M3" },
        status: 500,
        json: { error: "boom" },
      },
    ]);
    const out = await createLightAgent({ name: "seo", schedules: [SOCIAL] }, { clock: fakeClock().clock });
    expect(t.problems).toEqual([]);
    expect(out).toMatchObject({ error: "boom", code: "PLATFORM_ERROR", http_status: 500, step: "create" });
  });

  it("fails fast when the agent fails while booting", async () => {
    const t = scriptTenant(HOST, [
      { method: "POST", path: "/workspaces", status: 201, json: CREATED },
      { method: "GET", path: WS_PATH, status: 200, json: ws("failed", 0, { last_sample_error: "image pull failed" }) },
    ]);
    const out = await createLightAgent(INPUT, { clock: fakeClock().clock });
    expect(t.problems).toEqual([]);
    expect(out).toMatchObject({
      code: "LIGHT_SETUP_AGENT_FAILED",
      error: "the agent is failed: image pull failed",
      workspace_status: "failed",
      last_sample_error: "image pull failed",
      step: "wait-online",
      workspace_id: WS,
    });
  });

  it("keeps polling through a transient read failure", async () => {
    const t = scriptTenant(HOST, [
      ...upToPark().slice(0, 1),
      { method: "GET", path: WS_PATH, status: 502, text: "bad gateway" },
      ...upToPark().slice(1),
      { method: "POST", path: `${WS_PATH}/light/park`, status: 202, json: PARK_ACCEPTED },
      { method: "GET", path: `${WS_PATH}/light`, status: 503, json: { error: "x", code: "LIGHT_FAILED" } },
      { method: "GET", path: `${WS_PATH}/light`, status: 200, json: LIGHT_PARKED },
    ]);
    const { clock, sleeps } = fakeClock();
    const out = await createLightAgent(INPUT, { clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toMatchObject({ light_state: "parked" });
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("times out a wait with LIGHT_SETUP_TIMEOUT and what it last saw", async () => {
    const t = scriptTenant(HOST, [
      { method: "POST", path: "/workspaces", status: 201, json: CREATED },
      { method: "GET", path: WS_PATH, status: 200, json: ws("provisioning"), repeat: 21 },
    ]);
    const { clock, sleeps } = fakeClock();
    const out = await createLightAgent({ ...INPUT, timeout_seconds: 60 }, { clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(sleeps).toHaveLength(20);
    expect(out).toMatchObject({
      code: "LIGHT_SETUP_TIMEOUT",
      waiting_for: "the agent online",
      workspace_status: "provisioning",
      step: "wait-online",
      workspace_id: WS,
    });
  });

  it("reports a park that settles open with another last_error with that error's code and message", async () => {
    const t = scriptTenant(HOST, [
      ...upToPark(),
      { method: "POST", path: `${WS_PATH}/light/park`, status: 202, json: PARK_ACCEPTED },
      {
        method: "GET",
        path: `${WS_PATH}/light`,
        status: 200,
        json: {
          ...LIGHT_PARKED,
          light_state: "open",
          last_error: { code: "LIGHT_PARK_FAILED", message: "the pod failed while it was being parked", at: "2026-11-13T09:00:09Z" },
        },
      },
    ]);
    const out = await createLightAgent(INPUT, { clock: fakeClock().clock });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toMatchObject({
      error: "the pod failed while it was being parked",
      code: "LIGHT_PARK_FAILED",
      light_state: "open",
      step: "wait-parked",
      workspace_id: WS,
    });
  });

  it("stops when the call is cancelled", async () => {
    const controller = new AbortController();
    const t = scriptTenant(HOST, [
      { method: "POST", path: "/workspaces", status: 201, json: CREATED },
      { method: "GET", path: WS_PATH, status: 200, json: ws("provisioning"), onServe: () => controller.abort() },
    ]);
    const out = await createLightAgent(INPUT, { clock: fakeClock().clock, signal: controller.signal });
    expect(t.problems).toEqual([]);
    expect(t.left()).toBe(0);
    expect(out).toMatchObject({ code: "CANCELLED", step: "wait-online", workspace_id: WS });
  });
});

describe("light_create_agent handler", () => {
  it("reports each step as an MCP progress notification when the caller asked for progress", async () => {
    scriptTenant(HOST, [
      ...upToPark(),
      { method: "POST", path: `${WS_PATH}/light/park`, status: 202, json: PARK_ACCEPTED },
      { method: "GET", path: `${WS_PATH}/light`, status: 200, json: LIGHT_PARKED },
    ]);
    const sendNotification = jest.fn().mockResolvedValue(undefined);
    const res = await handleLightCreateAgent(INPUT, {
      signal: new AbortController().signal,
      _meta: { progressToken: "tok-1" },
      sendNotification,
    });
    expect(res.isError).toBeUndefined();
    expect(parsed(res)).toMatchObject({ workspace_id: WS, light_state: "parked" });
    const params = sendNotification.mock.calls.map(([n]) => n.params);
    expect(sendNotification.mock.calls.every(([n]) => n.method === "notifications/progress")).toBe(true);
    expect(params.map((p) => p.progressToken)).toEqual(Array(7).fill("tok-1"));
    expect(params.map((p) => p.progress)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(params.map((p) => String(p.message).split(":")[0])).toEqual([
      "create",
      "wait-online",
      "create-schedules",
      "enable",
      "wait-restart",
      "park",
      "wait-parked",
    ]);
  });

  it("returns a failure as an MCP error result", async () => {
    scriptTenant(HOST, [
      { method: "POST", path: "/workspaces", status: 422, json: { error: "unsupported workspace runtime", code: "RUNTIME_UNSUPPORTED" } },
    ]);
    const res = await handleLightCreateAgent(INPUT);
    expect(res.isError).toBe(true);
    expect(parsed(res)).toMatchObject({ code: "RUNTIME_UNSUPPORTED", step: "create", http_status: 422 });
  });
});
