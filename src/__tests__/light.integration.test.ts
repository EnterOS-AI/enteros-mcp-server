/**
 * Enter OS Light tools through the real MCP transport (management mode) against
 * a real node:http tenant: the advertised schemas, the request each tool sends,
 * a refusal surfacing as an MCP error with core's code, and light_create_agent's
 * whole flow with its progress notifications.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../index.js";

type Route = { status: number; body: unknown };

describe("Light tools through the real MCP transport", () => {
  const ws = "be7540cf-d160-4e2a-9b1c-0123456789ab";
  const savedEnv = { ...process.env };
  const requests: Array<{ method?: string; path?: string; auth?: string; body: unknown }> = [];
  let routes: Record<string, Route[]> = {};
  let api: http.Server;
  let server: ReturnType<typeof createServer>;
  let client: Client;

  const text = (result: unknown) =>
    JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;

  beforeAll(async () => {
    api = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      requests.push({
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const queue = routes[`${req.method} ${req.url}`];
      const route = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      res.writeHead(route?.status ?? 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(route?.body ?? { error: "no such route in the test", code: "TEST_NO_ROUTE" }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    process.env.MOLECULE_MCP_MODE = "management";
    process.env.MOLECULE_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    process.env.MOLECULE_ORG_API_KEY = "light-integration-key";
    process.env.MOLECULE_ORG_ID = "org-light";
    server = createServer();
    client = new Client({ name: "light-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  beforeEach(() => {
    requests.length = 0;
    routes = {};
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
    process.env = savedEnv;
  });

  it("advertises the eight Light tools with their input schemas", async () => {
    const tools = (await client.listTools()).tools.filter((t) => t.name.startsWith("light_"));
    expect(tools.map((t) => t.name).sort()).toEqual([
      "light_create_agent",
      "light_disable",
      "light_enable",
      "light_open",
      "light_park",
      "light_run_now",
      "light_runs",
      "light_status",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.light_create_agent.inputSchema.required).toEqual(expect.arrayContaining(["name", "schedules"]));
    expect(byName.light_run_now.inputSchema.required).toEqual(expect.arrayContaining(["workspace_id", "schedule"]));
    const limit = (byName.light_runs.inputSchema.properties as Record<string, { maximum?: number }>).limit;
    expect(limit.maximum).toBe(100);
    for (const t of tools) expect(t.description).toMatch(/^Enter OS Light: /);
  });

  it("light_park POSTs the park with the org key and no body, and returns core's 202 answer", async () => {
    const accepted = { light_state: "parking", schedules: [], removed: [] };
    routes[`POST /workspaces/${ws}/light/park`] = [{ status: 202, body: accepted }];
    const result = await client.callTool({ name: "light_park", arguments: { workspace_id: ws } });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toEqual(accepted);
    expect(requests).toEqual([
      { method: "POST", path: `/workspaces/${ws}/light/park`, auth: "Bearer light-integration-key", body: undefined },
    ]);
  });

  it("surfaces a refusal as an MCP error carrying core's code, message and extras", async () => {
    const busy = { error: "the agent is working", code: "LIGHT_AGENT_BUSY", active_tasks: 1, is_busy: true };
    routes[`POST /workspaces/${ws}/light/park`] = [{ status: 409, body: busy }];
    const result = await client.callTool({ name: "light_park", arguments: { workspace_id: ws } });
    expect(result.isError).toBe(true);
    expect(text(result)).toEqual({ ...busy, http_status: 409 });
  });

  it("light_runs maps its arguments to the query string", async () => {
    routes[`GET /workspaces/${ws}/light/runs?limit=2&schedule=daily-report`] = [
      { status: 200, body: { runs: [], next_before: null } },
    ];
    const result = await client.callTool({
      name: "light_runs",
      arguments: { workspace_id: ws, limit: 2, schedule: "daily-report" },
    });
    expect(text(result)).toEqual({ runs: [], next_before: null });
    expect(requests.map((r) => r.path)).toEqual([`/workspaces/${ws}/light/runs?limit=2&schedule=daily-report`]);
  });

  it.each([
    ["light_status", { workspace_id: "../other" }],
    ["light_park", { workspace_id: `${ws}/..` }],
    ["light_open", { workspace_id: ws.toUpperCase() }],
    ["light_run_now", { workspace_id: "%2e%2e", schedule: "daily-report" }],
    ["light_runs", { workspace_id: ws, limit: 0 }],
    ["light_create_agent", { name: "x", schedules: [] }],
  ])("%s validates its arguments before any request: %p", async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("light_create_agent runs the whole setup and reports each step as progress", async () => {
    const parked = { workspace_id: ws, light_state: "parked", last_error: null, schedules: [] };
    routes["POST /workspaces"] = [{ status: 201, body: { id: ws, status: "provisioning", auth_token: "never-returned" } }];
    routes[`GET /workspaces/${ws}`] = [{ status: 200, body: { id: ws, status: "online", active_tasks: 0 } }];
    routes[`POST /workspaces/${ws}/schedules`] = [{ status: 201, body: { id: "daily-report", status: "created" } }];
    routes[`POST /workspaces/${ws}/light/enable`] = [
      { status: 200, body: { status: "enabled", light_state: "open", restart: "none" } },
    ];
    routes[`POST /workspaces/${ws}/light/park`] = [{ status: 202, body: { light_state: "parking", schedules: [], removed: [] } }];
    routes[`GET /workspaces/${ws}/light`] = [{ status: 200, body: parked }];

    const progress: Array<{ progress: number; message?: string }> = [];
    const result = await client.callTool(
      {
        name: "light_create_agent",
        arguments: {
          name: "daily-reporter",
          model: "minimax/MiniMax-M2.7",
          schedules: [{ name: "daily-report", cron: "0 9 * * *", timezone: "America/Vancouver", prompt: "Write it." }],
        },
      },
      undefined,
      { onprogress: (p) => progress.push({ progress: p.progress, message: p.message }) },
    );

    expect(result.isError).not.toBe(true);
    expect(text(result)).toEqual({
      workspace_id: ws,
      name: "daily-reporter",
      model: "minimax/MiniMax-M2.7",
      light_state: "parked",
      light: parked,
    });
    expect(JSON.stringify(result)).not.toContain("never-returned");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /workspaces",
      `GET /workspaces/${ws}`,
      `POST /workspaces/${ws}/schedules`,
      `POST /workspaces/${ws}/light/enable`,
      `GET /workspaces/${ws}`,
      `POST /workspaces/${ws}/light/park`,
      `GET /workspaces/${ws}/light`,
    ]);
    expect(requests[0].body).toEqual({ name: "daily-reporter", runtime: "hermes", model: "minimax/MiniMax-M2.7" });
    expect(requests[2].body).toEqual({
      name: "daily-report",
      cron_expr: "0 9 * * *",
      timezone: "America/Vancouver",
      prompt: "Write it.",
      enabled: true,
    });
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(progress.map((p) => String(p.message).split(":")[0])).toEqual([
      "create",
      "wait-online",
      "create-schedules",
      "enable",
      "wait-restart",
      "park",
      "wait-parked",
    ]);
  });
});
