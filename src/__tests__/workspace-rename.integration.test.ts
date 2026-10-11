import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../index.js";

describe("workspace rename through real MCP transport", () => {
  const workspaceId = "aaaaaaaa-0000-4000-8000-000000000001";
  const savedEnv = { ...process.env };
  const requests: Array<{ method?: string; path?: string; auth?: string; body: unknown }> = [];
  let api: http.Server;
  let server: ReturnType<typeof createServer>;
  let client: Client;
  let status = 200;

  beforeAll(async () => {
    api = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200
        ? { status: "updated", workspace_id: workspaceId, name: body.name }
        : { error: "rename rejected" }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    process.env.MOLECULE_MCP_MODE = "management";
    process.env.MOLECULE_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    process.env.MOLECULE_ORG_API_KEY = "rename-integration-key";
    server = createServer();
    client = new Client({ name: "rename-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  beforeEach(() => { requests.length = 0; status = 200; });
  afterAll(async () => {
    await client?.close();
    await server?.close();
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
    process.env = savedEnv;
  });

  it("advertises the tool and patches the existing workspace without lifecycle calls", async () => {
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "rename_workspace");
    expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["workspace_id", "name"]));
    const result = await client.callTool({
      name: "rename_workspace", arguments: { workspace_id: workspaceId, name: "Personal Brand" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({
      status: "updated", workspace_id: workspaceId, name: "Personal Brand",
    }, null, 2) }]);
    expect(requests).toEqual([{
      method: "PATCH", path: `/workspaces/${workspaceId}`,
      auth: "Bearer rename-integration-key", body: { name: "Personal Brand" },
    }]);
  });

  it.each([400, 403, 404, 409, 500])("surfaces HTTP %i as a tool error", async (code) => {
    status = code;
    const result = await client.callTool({
      name: "rename_workspace", arguments: { workspace_id: workspaceId, name: "Personal Brand" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("rename rejected");
    expect(requests).toHaveLength(1);
  });

  it.each([
    { workspace_id: "../other", name: "Brand" },
    { workspace_id: workspaceId, name: "  " },
    { workspace_id: workspaceId, name: 123 },
    { workspace_id: workspaceId },
  ])("validates the advertised schema before HTTP: %p", async (args) => {
    const result = await client.callTool({ name: "rename_workspace", arguments: args });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
