/**
 * The model a new workspace gets when the caller names none, through the real
 * MCP transport (management mode) against a real node:http tenant:
 *   - MOLECULE_LLM_DEFAULT_MODEL set: that model, and no lookup;
 *   - unset: the tenant's GET /admin/llm/offered-models default_model;
 *   - neither: INVALID_ARGUMENTS, and no create request at all.
 * Neither MOLECULE_MODEL nor MODEL (the concierge's own model) is ever used.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../index.js";

type Route = { status: number; body: unknown };

describe("default model for new workspaces, through the real MCP transport", () => {
  const savedEnv = { ...process.env };
  const requests: Array<{ method?: string; path?: string; auth?: string; body: unknown }> = [];
  let routes: Record<string, Route[]> = {};
  let api: http.Server;
  let server: ReturnType<typeof createServer>;
  let client: Client;

  const text = (result: unknown) =>
    JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;
  const offered = (defaultModel?: string): Route => ({
    status: 200,
    body: {
      runtime: "hermes",
      ...(defaultModel ? { default_model: defaultModel } : {}),
      models: [{ model: "google/gemini-4-hydrogen", provider: "platform", platform_billed: true }],
    },
  });
  const schedule = { name: "daily-report", cron: "0 9 * * *", timezone: "America/Vancouver", prompt: "Write it." };

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
    process.env.MOLECULE_ORG_API_KEY = "default-model-integration-key";
    process.env.MOLECULE_ORG_ID = "org-default-model";
    server = createServer();
    client = new Client({ name: "default-model-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  beforeEach(() => {
    requests.length = 0;
    routes = {};
    delete process.env.MOLECULE_LLM_DEFAULT_MODEL;
    // The concierge's own model is in its env; it must never become a member's.
    process.env.MOLECULE_MODEL = "minimax/MiniMax-M2.7";
    process.env.MODEL = "minimax/MiniMax-M2.7";
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
    process.env = savedEnv;
  });

  it("provision_workspace: MOLECULE_LLM_DEFAULT_MODEL set gives that model, with no lookup", async () => {
    process.env.MOLECULE_LLM_DEFAULT_MODEL = "google/gemini-4-hydrogen";
    routes["POST /workspaces"] = [{ status: 201, body: { id: "w-env", status: "provisioning" } }];
    const result = await client.callTool({ name: "provision_workspace", arguments: { name: "Writer", runtime: "hermes" } });
    expect(result.isError).not.toBe(true);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /workspaces"]);
    expect(requests[0].body).toEqual({ name: "Writer", runtime: "hermes", model: "google/gemini-4-hydrogen" });
    expect(requests[0].auth).toBe("Bearer default-model-integration-key");
  });

  it("provision_workspace: env unset gives the tenant's offered-models default_model", async () => {
    routes["GET /admin/llm/offered-models?runtime=hermes"] = [offered("google/gemini-4-hydrogen")];
    routes["POST /workspaces"] = [{ status: 201, body: { id: "w-api", status: "provisioning" } }];
    const result = await client.callTool({ name: "provision_workspace", arguments: { name: "Writer", runtime: "hermes" } });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toEqual({ id: "w-api", status: "provisioning" });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /admin/llm/offered-models?runtime=hermes",
      "POST /workspaces",
    ]);
    expect(requests[1].body).toEqual({ name: "Writer", runtime: "hermes", model: "google/gemini-4-hydrogen" });
  });

  it("provision_workspace: no env and no default_model is INVALID_ARGUMENTS, with no create request", async () => {
    routes["GET /admin/llm/offered-models?runtime=hermes"] = [offered()];
    const result = await client.callTool({ name: "provision_workspace", arguments: { name: "Writer", runtime: "hermes" } });
    expect(result.isError).toBe(true);
    const out = text(result);
    expect(out.error).toBe("INVALID_ARGUMENTS");
    expect(String(out.detail)).toContain("MOLECULE_LLM_DEFAULT_MODEL is not set");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /admin/llm/offered-models?runtime=hermes"]);
  });

  it("light_create_agent: no env and no default_model is INVALID_ARGUMENTS, with no create request", async () => {
    routes["GET /admin/llm/offered-models?runtime=hermes"] = [offered()];
    const result = await client.callTool({
      name: "light_create_agent",
      arguments: { name: "daily-reporter", schedules: [schedule] },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ code: "INVALID_ARGUMENTS", step: "create" });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /admin/llm/offered-models?runtime=hermes"]);
  });

  it("light_create_agent: env unset creates on the tenant's default_model", async () => {
    routes["GET /admin/llm/offered-models?runtime=hermes"] = [offered("google/gemini-4-hydrogen")];
    // The create is refused so the flow stops right after the request under test.
    routes["POST /workspaces"] = [{ status: 422, body: { error: "quota", code: "TEST_STOP" } }];
    const result = await client.callTool({
      name: "light_create_agent",
      arguments: { name: "daily-reporter", schedules: [schedule] },
    });
    expect(text(result)).toMatchObject({ code: "TEST_STOP", step: "create" });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /admin/llm/offered-models?runtime=hermes",
      "POST /workspaces",
    ]);
    expect(requests[1].body).toEqual({ name: "daily-reporter", runtime: "hermes", model: "google/gemini-4-hydrogen" });
  });
});
