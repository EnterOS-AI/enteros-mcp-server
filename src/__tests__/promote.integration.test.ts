import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

interface CapturedRequest {
  method: string;
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function parseToolJson(result: unknown): Record<string, any> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content.map((item) => item.text).join(""));
}

describe("promote v2 real MCP session", () => {
  const targetImage = `registry.moleculesai.app/molecule-ai/molecule-tenant@sha256:${"b".repeat(64)}`;
  const savedEnv = { ...process.env };
  const requests: CapturedRequest[] = [];
  let fakeCP: http.Server;
  let client: Client;
  let closeSession: () => Promise<void>;
  let redirectNextPromote = false;

  beforeAll(async () => {
    fakeCP = http.createServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({
        method: req.method || "",
        path: new URL(req.url || "/", "http://internal").pathname,
        authorization: req.headers.authorization,
        body,
      });
      if (
        redirectNextPromote &&
        new URL(req.url || "/", "http://internal").pathname === "/cp/admin/promote"
      ) {
        redirectNextPromote = false;
        res.writeHead(307, { Location: "/redirected-promote" });
        res.end();
        return;
      }
      const dryRun = body.dry_run === true;
      const tenantResult = {
        slug: "tenant-integration",
        instance_id: "local-tenant-integration",
        provider: "local",
        phase: "canary",
        ssm_status: dryRun ? "DryRun" : "Success",
        healthz_ok: !dryRun,
        verified_on_target: !dryRun,
        ...(dryRun ? {} : { running_image: targetImage }),
      };
      const payload = {
        ok: true,
        complete: !dryRun,
        env: body.env,
        dry_run: dryRun,
        results: [{
          component: "tenant-fleet",
          status: dryRun ? "planned" : "ok",
          target_image: targetImage,
          coverage: {
            target_image: targetImage,
            enumerated: 1,
            planned: dryRun ? 1 : 0,
            refreshed: dryRun ? 0 : 1,
            verified_on_target: dryRun ? 0 : 1,
            failed: 0,
            stragglers: [],
          },
          tenant_results: [tenantResult],
        }],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => fakeCP.listen(0, "127.0.0.1", resolve));
    const { port } = fakeCP.address() as AddressInfo;

    process.env.MOLECULE_MCP_MODE = "management";
    process.env.MOLECULE_CP_URL = `http://127.0.0.1:${port}`;
    process.env.CP_PROMOTE_PROD_API_TOKEN = "integration-promote-token";

    let createServer!: () => any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ createServer } = require("../index.js"));
    });
    const server = createServer();
    client = new Client({ name: "promote-v2-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeSession = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    if (closeSession) await closeSession();
    if (fakeCP) await new Promise<void>((resolve) => fakeCP.close(() => resolve()));
    process.env = savedEnv;
  });

  it("registers the promote tool only in the real management registry", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("promote_to_production");
  });

  it("plans through real MCP transport and one real HTTP CP POST", async () => {
    const before = requests.length;
    const result = parseToolJson(await client.callTool({
      name: "promote_to_production",
      arguments: { dry_run: true },
    }));

    expect(result).toMatchObject({ ok: true, complete: false, dry_run: true });
    expect(requests).toHaveLength(before + 1);
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/cp/admin/promote",
      authorization: "Bearer integration-promote-token",
      body: {
        env: "production",
        components: ["tenant-fleet"],
        dry_run: true,
        confirm: false,
      },
    });
  });

  it("refuses a wet call without explicit operator confirmation before HTTP", async () => {
    const before = requests.length;
    const result = parseToolJson(await client.callTool({
      name: "promote_to_production",
      arguments: { dry_run: false },
    }));

    expect(result.error).toBe("CONFIRMATION_REQUIRED");
    expect(requests).toHaveLength(before);
  });

  it("returns exact verified wet evidence through the real protocol boundary", async () => {
    const result = parseToolJson(await client.callTool({
      name: "promote_to_production",
      arguments: { dry_run: false, confirm: true, components: ["all"] },
    }));

    expect(result.ok).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ component: "tenant-fleet", status: "ok" });
    expect(result.results[0].coverage).toMatchObject({
      enumerated: 1,
      verified_on_target: 1,
      stragglers: [],
    });
  });

  it("fails closed without replaying a wet POST when the CP redirects", async () => {
    const before = requests.length;
    redirectNextPromote = true;

    const result = parseToolJson(await client.callTool({
      name: "promote_to_production",
      arguments: { dry_run: false, confirm: true },
    }));

    expect(result.error).toBe("PROMOTE_FAILED");
    expect(requests.slice(before)).toEqual([expect.objectContaining({
      method: "POST",
      path: "/cp/admin/promote",
    })]);
  });
});
