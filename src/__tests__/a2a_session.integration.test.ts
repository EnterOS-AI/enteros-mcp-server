/**
 * INTEGRATION regression test — molecule-ai/molecule-mcp-server#34
 *
 * SOP rule internal#765 (regression-coverage). The repo is otherwise entirely
 * fetch-mocked Jest unit tests; the security-bearing peer-ACL boundary, the
 * GLOBAL memory-scope write boundary, and the highest-frequency
 * reply / delegate / list_peers / commit_memory paths had NO real,
 * over-the-wire gate, and async_delegate had ZERO tests.
 *
 * This closes that gap with a REAL integration session:
 *
 *   - The REAL MCP server is built via createServer() (real McpServer, real
 *     tool registrations, real Zod validation, real handlers, real api.ts
 *     apiCall()/platformGet() → real fetch). NO SDK mock, NO fetch mock —
 *     contrast index.test.ts which jest.mock()s both. internal#765 requires
 *     the real layer (integration), not a mock-only proxy.
 *   - It is connected to a REAL MCP Client over a REAL InMemoryTransport
 *     linked pair, so every tool call is genuine JSON-RPC serialized
 *     OVER-THE-WIRE through the transport boundary — NOT a direct handler
 *     call. stdio and InMemory share the identical Protocol/Server request
 *     loop; the only difference is the byte pipe. We use InMemory so CI need
 *     not spawn a child process, while still exercising the real
 *     client → protocol → server → handler → fetch path.
 *   - A REAL node:http server stands in for the platform ("fake-but-real"):
 *     it speaks the actual REST contract api.ts targets, and enforces the SAME
 *     authorization boundaries the Go control plane does:
 *       * peer-ACL — GET /registry/:id/peers only returns peers the caller
 *         may reach; an unknown / cross-org workspace gets 403.
 *       * GLOBAL memory scope — POST /workspaces/:id/memories with
 *         scope="GLOBAL" only succeeds for a tier-0 root; a non-root caller
 *         is rejected 403 AUTH_ERROR.
 *
 * Env note: api.ts captures PLATFORM_URL as a module-load-time const from
 * MOLECULE_API_URL. We therefore set the env to the fake-platform URL and
 * lazily require("../index.js") AFTER the http server is listening, so the
 * server's fetch target is the fake platform — not the localhost default.
 *
 * WATCH-FAIL intent (how a regression of the covered behavior trips this):
 *   - async_delegate dropping target_id/task from the POST body → fake
 *     platform records no delegation / 400 → assertion on recorded body FAILS.
 *   - list_peers not threading workspace_id into /registry/:id/peers → wrong
 *     peer set or 403 → ACL assertions FAIL.
 *   - commit_memory dropping `scope` → a non-root GLOBAL write would silently
 *     succeed → the "unauthorized GLOBAL write is rejected" assertion FAILS.
 *   - Removing the platform-side GLOBAL / peer-ACL gate → the deny assertions
 *     FAIL (they expect a structured AUTH_ERROR, not data).
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ---------------------------------------------------------------------------
// Fake-but-real platform — a real node:http server speaking the REST contract
// src/api.ts targets, with the SAME ACL + scope gates as the control plane.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface FakePlatform {
  server: http.Server;
  baseUrl: string;
  requests: CapturedRequest[];
  delegations: Array<{ workspace_id: string; target_id: string; task: string }>;
  memories: Array<{ workspace_id: string; content: string; scope: string }>;
  close: () => Promise<void>;
}

/**
 * Canvas/registry fixture mirroring how the platform models reachability.
 *
 * - "ws-root"    : tier-0 root (org owner). MAY write GLOBAL memory. Peers =
 *                  its children.
 * - "ws-child"   : tier-1 child of ws-root. NOT a root → may NOT write GLOBAL.
 *                  Peers = parent + siblings.
 * - "ws-foreign" : a workspace in a DIFFERENT org. Not reachable / not a peer
 *                  of ws-root or ws-child.
 */
const TIER0_ROOTS = new Set<string>(["ws-root"]);

const PEERS: Record<string, Array<{ workspace_id: string; name: string; role: string }>> = {
  "ws-root": [{ workspace_id: "ws-child", name: "Child Agent", role: "child" }],
  "ws-child": [
    { workspace_id: "ws-root", name: "Root Agent", role: "parent" },
    { workspace_id: "ws-sibling", name: "Sibling Agent", role: "sibling" },
  ],
};

// Same-org, addressable delegation targets (ws-foreign is intentionally absent).
const REACHABLE_TARGETS = new Set<string>(["ws-root", "ws-child", "ws-sibling"]);

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

async function startFakePlatform(): Promise<FakePlatform> {
  const requests: CapturedRequest[] = [];
  const delegations: FakePlatform["delegations"] = [];
  const memories: FakePlatform["memories"] = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://internal");
    const path = url.pathname;
    const body = await readBody(req);
    requests.push({ method: req.method || "GET", path, body });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (path === "/health") return send(200, { status: "ok" });

    // --- peer-ACL: GET /registry/:id/peers -------------------------------
    const peersMatch = path.match(/^\/registry\/([^/]+)\/peers$/);
    if (peersMatch && req.method === "GET") {
      const wsId = decodeURIComponent(peersMatch[1]);
      const peers = PEERS[wsId];
      if (!peers) {
        return send(403, { error: "AUTH_ERROR", detail: `workspace ${wsId} not reachable` });
      }
      return send(200, { peers });
    }

    // --- delegate: POST /workspaces/:id/delegate -------------------------
    const delegateMatch = path.match(/^\/workspaces\/([^/]+)\/delegate$/);
    if (delegateMatch && req.method === "POST") {
      const wsId = decodeURIComponent(delegateMatch[1]);
      const b = (body || {}) as { target_id?: string; task?: string };
      if (!b.target_id || !b.task) {
        return send(400, { error: "INVALID_ARGUMENTS", detail: "target_id and task are required" });
      }
      if (!REACHABLE_TARGETS.has(b.target_id)) {
        return send(403, { error: "AUTH_ERROR", detail: `target ${b.target_id} not reachable from ${wsId}` });
      }
      delegations.push({ workspace_id: wsId, target_id: b.target_id, task: b.task });
      return send(202, { delegation_id: `del-${delegations.length}`, status: "pending", target_id: b.target_id });
    }

    // --- commit_memory: POST /workspaces/:id/memories --------------------
    const memMatch = path.match(/^\/workspaces\/([^/]+)\/memories$/);
    if (memMatch && req.method === "POST") {
      const wsId = decodeURIComponent(memMatch[1]);
      const b = (body || {}) as { content?: string; scope?: string };
      const scope = b.scope || "LOCAL";
      if (scope === "GLOBAL" && !TIER0_ROOTS.has(wsId)) {
        return send(403, {
          error: "AUTH_ERROR",
          detail: `workspace ${wsId} is not a tier-0 root; GLOBAL memory writes are forbidden`,
        });
      }
      memories.push({ workspace_id: wsId, content: b.content || "", scope });
      return send(201, { memory_id: `mem-${memories.length}`, scope });
    }

    // --- reply_to_workspace analog on this server's surface --------------
    // notify_user → POST /workspaces/:id/notify (canvas reply primitive).
    const notifyMatch = path.match(/^\/workspaces\/([^/]+)\/notify$/);
    if (notifyMatch && req.method === "POST") {
      return send(200, { delivered: true });
    }

    return send(404, { error: "NOT_FOUND", detail: path });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    delegations,
    memories,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Parse the JSON blob a handler wraps via toMcpResult(). */
function parseToolJson(result: unknown): any {
  const r = result as { content: Array<{ type: string; text: string }> };
  const text = r.content.map((c) => c.text).join("");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("integration#34: real MCP session over-the-wire (peer-ACL + GLOBAL memory-scope)", () => {
  let platform: FakePlatform;
  let client: Client;
  let closeSession: () => Promise<void>;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // 1. Bring up the fake-but-real platform.
    platform = await startFakePlatform();

    // 2. Point the server's REST client at it BEFORE the module is loaded,
    //    because api.ts captures PLATFORM_URL as a load-time const.
    process.env.MOLECULE_API_URL = platform.baseUrl;
    delete process.env.MOLECULE_URL;
    delete process.env.PLATFORM_URL;

    // 3. Lazily load the REAL server module now that the env is set.
    //    jest.isolateModules guarantees a fresh module graph that re-reads env.
    let createServer!: () => any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ createServer } = require("../index.js"));
    });

    // 4. Connect a REAL client to the REAL server over a REAL transport pair.
    const server = createServer();
    client = new Client({ name: "issue-34-integration-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeSession = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    if (closeSession) await closeSession();
    if (platform) await platform.close();
    process.env = savedEnv;
  });

  it("exposes the A2A tool surface over the wire (list_peers/async_delegate/commit_memory/notify_user)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_peers", "async_delegate", "commit_memory", "notify_user"]));
  });

  it("does not register or dispatch tools that cross the HTTP boundary to retired Core routes", async () => {
    const retired = [
      { name: "expand_team", arguments: { workspace_id: "ws-root" } },
      { name: "collapse_team", arguments: { workspace_id: "ws-root" } },
      { name: "get_shared_context", arguments: { workspace_id: "ws-root" } },
    ];
    const forbiddenPaths = new Set([
      "/workspaces/ws-root/expand",
      "/workspaces/ws-root/collapse",
      "/workspaces/ws-root/shared-context",
    ]);

    const { tools } = await client.listTools();
    const registered = tools
      .map((tool) => tool.name)
      .filter((name) => retired.some((tool) => tool.name === name));
    const requestOffset = platform.requests.length;
    const dispatched: string[] = [];

    for (const tool of retired) {
      try {
        const result = await client.callTool(tool);
        if (!(result as { isError?: boolean }).isError) dispatched.push(tool.name);
      } catch {
        // Also acceptable: an unregistered tool may reject instead of returning isError.
      }
    }

    const forbiddenRequests = platform.requests
      .slice(requestOffset)
      .filter((request) => forbiddenPaths.has(request.path))
      .map((request) => `${request.method} ${request.path}`);

    expect({ registered, dispatched, forbiddenRequests }).toEqual({
      registered: [],
      dispatched: [],
      forbiddenRequests: [],
    });
  });

  // --- list_peers + peer-ACL ------------------------------------------------

  it("list_peers returns only ACL-reachable peers for the calling workspace", async () => {
    const res = await client.callTool({ name: "list_peers", arguments: { workspace_id: "ws-child" } });
    const data = parseToolJson(res);
    expect(data.peers.map((p: any) => p.workspace_id).sort()).toEqual(["ws-root", "ws-sibling"]);
    // ws-foreign (different org) must NOT leak into the peer set.
    expect(JSON.stringify(data)).not.toContain("ws-foreign");
    // The handler must have hit the per-workspace registry path (ACL scope).
    expect(platform.requests.some((r) => r.method === "GET" && r.path === "/registry/ws-child/peers")).toBe(true);
  });

  it("list_peers surfaces a peer-ACL denial (403) for an unreachable / cross-org workspace", async () => {
    const res = await client.callTool({ name: "list_peers", arguments: { workspace_id: "ws-foreign" } });
    const data = parseToolJson(res);
    // api.ts maps non-2xx to { error: "HTTP 403", detail: "...AUTH_ERROR..." }.
    expect(data.error).toBe("HTTP 403");
    expect(String(data.detail)).toContain("not reachable");
    expect(data.peers).toBeUndefined();
  });

  // --- async_delegate (was ZERO tests) -------------------------------------

  it("async_delegate POSTs {target_id, task} to a reachable peer and returns a delegation_id", async () => {
    const res = await client.callTool({
      name: "async_delegate",
      arguments: { workspace_id: "ws-child", target_id: "ws-sibling", task: "summarize the Q3 report" },
    });
    const data = parseToolJson(res);
    expect(data.delegation_id).toMatch(/^del-\d+$/);
    expect(data.status).toBe("pending");
    expect(data.target_id).toBe("ws-sibling");

    // WATCH-FAIL: the real request body must carry target_id + task.
    const recorded = platform.delegations.find((d) => d.workspace_id === "ws-child");
    expect(recorded).toBeDefined();
    expect(recorded).toMatchObject({ target_id: "ws-sibling", task: "summarize the Q3 report" });

    const sent = platform.requests.find((r) => r.method === "POST" && r.path === "/workspaces/ws-child/delegate");
    expect(sent?.body).toMatchObject({ target_id: "ws-sibling", task: "summarize the Q3 report" });
  });

  it("async_delegate to an unreachable target is denied (peer-ACL, 403) and records no delegation", async () => {
    const before = platform.delegations.length;
    const res = await client.callTool({
      name: "async_delegate",
      arguments: { workspace_id: "ws-child", target_id: "ws-foreign", task: "leak org data" },
    });
    const data = parseToolJson(res);
    expect(data.error).toBe("HTTP 403");
    expect(String(data.detail)).toContain("not reachable");
    // No delegation may be recorded for a denied target.
    expect(platform.delegations.length).toBe(before);
  });

  it("async_delegate rejects missing required args before any platform call (real Zod validation over the wire)", async () => {
    const before = platform.requests.length;
    const res = await client.callTool({
      name: "async_delegate",
      arguments: { workspace_id: "ws-child" },
    });
    // Real Zod validation produces an MCP error result (isError=true),
    // not a thrown exception — the transport resolves with the error shape.
    expect((res as any).isError).toBe(true);
    const text = (res as any).content?.[0]?.text ?? "";
    expect(text).toContain("Input validation error");
    expect(text).toContain("target_id");
    expect(text).toContain("task");
    // Validation must short-circuit — no POST should reach the platform.
    expect(platform.requests.length).toBe(before);
  });

  // --- commit_memory + GLOBAL-scope authorization --------------------------

  it("commit_memory LOCAL succeeds for a non-root workspace and carries scope over the wire", async () => {
    const res = await client.callTool({
      name: "commit_memory",
      arguments: { workspace_id: "ws-child", content: "child remembers a LOCAL fact", scope: "LOCAL" },
    });
    const data = parseToolJson(res);
    expect(data.memory_id).toMatch(/^mem-\d+$/);
    expect(data.scope).toBe("LOCAL");
    const sent = platform.requests.find(
      (r) => r.method === "POST" && r.path === "/workspaces/ws-child/memories" && (r.body as any)?.scope === "LOCAL",
    );
    expect((sent?.body as any)?.content).toBe("child remembers a LOCAL fact");
  });

  it("commit_memory GLOBAL succeeds for a tier-0 root workspace", async () => {
    const res = await client.callTool({
      name: "commit_memory",
      arguments: { workspace_id: "ws-root", content: "org-wide policy", scope: "GLOBAL" },
    });
    const data = parseToolJson(res);
    expect(data.memory_id).toMatch(/^mem-\d+$/);
    expect(data.scope).toBe("GLOBAL");
    expect(platform.memories.some((m) => m.workspace_id === "ws-root" && m.scope === "GLOBAL")).toBe(true);
  });

  it("commit_memory GLOBAL from a NON-root workspace is rejected (AUTH_ERROR) and writes nothing", async () => {
    const before = platform.memories.length;
    const res = await client.callTool({
      name: "commit_memory",
      arguments: { workspace_id: "ws-child", content: "child tries to escalate to GLOBAL", scope: "GLOBAL" },
    });
    const data = parseToolJson(res);
    // WATCH-FAIL: if scope is dropped or the gate removed, this becomes a 201.
    expect(data.error).toBe("HTTP 403");
    expect(String(data.detail)).toContain("not a tier-0 root");
    // The unauthorized GLOBAL write must NOT have been persisted.
    expect(platform.memories.length).toBe(before);
    expect(platform.memories.some((m) => m.workspace_id === "ws-child" && m.scope === "GLOBAL")).toBe(false);
  });

  // --- reply_to_workspace analog (canvas reply primitive) ------------------

  it("notify_user delivers a canvas reply over the wire (reply_to_workspace analog on this surface)", async () => {
    const res = await client.callTool({
      name: "notify_user",
      arguments: { workspace_id: "ws-child", type: "delegation_complete" },
    });
    const data = parseToolJson(res);
    expect(data.delivered).toBe(true);
    expect(platform.requests.some((r) => r.method === "POST" && r.path === "/workspaces/ws-child/notify")).toBe(true);
  });
});
